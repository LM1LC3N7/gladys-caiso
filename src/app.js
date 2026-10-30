// -----------------------------------------------------------------------------
// The integration itself: the California grid read from the public files of
// the ISO at the pace of the form, published on the devices the user created
// (the grid, the trading hubs), the scene triggers fired on a change of the
// grid conditions or of a hub price around the threshold, the pace, the
// pauses and what was published kept in /data. index.js only wires the SDK
// handlers to it (src/wire.js). Read-only: only GET requests leave.
//
// Two sources, each read only while a device needs it, never two requests
// at once, each at its own pace (never sooner than the interval after it was
// last asked, kept across restarts; OASIS never sooner than 5 s whatever):
//   - Today's Outlook (stats.txt): the grid device;
//   - OASIS (the real-time 5-minute prices of the three hubs): the hub devices.
// A source failing, paused or frozen never stops the other.
//
// Freshness: a value is published once per source reading (deduplicated on
// the time given by the source, kept in /data), only while that reading is
// fresh (Outlook slot at most 20 min old, price interval ended at most 10 min
// ago), without `created_at`. A stale, missing or unreadable value is never
// published, never as 0: the status texts say it. The views are evaluated
// again when they change without a read (a price interval starting, a
// reading turning stale), so that a status never says "fresh" after it is not.
//
// Two clocks: `now` (wall clock) only for /data, the OASIS query window and
// the reference of a source without a usable `Date` header; `monotonic` for
// the pace, the pauses and the ages, so that a wall clock set back or
// forward never stops nor hurries them. One clock read per decision.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  CONFIG_RETRY_MAX,
  CONFIG_RETRY_MIN,
  DATE_HEADER_TRUST,
  FUTURE_SLACK,
  HUB_KEYS,
  MINUTE,
  OASIS_MAX_BYTES,
  OASIS_MIN_GAP,
  OASIS_URL,
  OUTLOOK_MAX_AGE,
  OUTLOOK_MAX_BYTES,
  OUTLOOK_URL,
  PAUSE_BASE,
  PAUSE_MAX,
  PAUSE_MIN,
  PRICE_MAX_LAG,
  SAVE_WAIT,
  SECOND,
  SOURCES,
  STOP_WAIT,
} from './constants.js';
import { TEXT_KEYS, VALUE_KEYS, allDevices, idsOf, parseDeviceId } from './devices.js';
import { FetchError, getBody } from './http.js';
import { T, gridStatus, hubStatus, joinMessages, problemText } from './i18n.js';
import { oasisQuery, parseOasis, priceAt } from './oasis.js';
import { FormatError, LEVELS, classify, parseOutlook } from './outlook.js';
import { createFileStore } from './store.js';

const defaultTimers = { setTimeout, clearTimeout };
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const PAUSE_CODES = new Set(['rate_limited', 'server']);
/** A wake-up for a view that changes without a read never comes sooner than this (no busy loop). */
const MIN_WAKE = SECOND;
/** Features kept in the "published" map of /data, at most (the module has 10). */
const MAX_PUBLISHED = 100;

/** A pause read back from /data: in memory it ends at a monotonic `due`, its rest capped to PAUSE_MAX. */
function validPause(pause, now, mono) {
  if (
    !pause ||
    !finite(pause.until) ||
    !Number.isInteger(pause.count) ||
    pause.count < 1 ||
    !PAUSE_CODES.has(pause.code)
  ) {
    return undefined;
  }
  const left = Math.min(Math.max(0, pause.until - now), PAUSE_MAX);
  return {
    until: now + left,
    due: mono + left,
    count: Math.min(pause.count, 32),
    code: pause.code,
    status: Number.isInteger(pause.status) ? pause.status : undefined,
  };
}

/** The source dates of the values published, by feature external id. */
function keptPublished(object) {
  const published = new Map();
  if (!object || typeof object !== 'object' || Array.isArray(object)) return published;
  for (const [key, value] of Object.entries(object).slice(0, MAX_PUBLISHED)) {
    if (key.length <= 200 && key !== '__proto__' && finite(value)) published.set(key, value);
  }
  return published;
}

/** The last known states behind the scene triggers, checked one by one. */
function keptTriggers(object) {
  const triggers = { alert: undefined, prices: {} };
  if (!object || typeof object !== 'object') return triggers;
  const alert = object.alert;
  if (
    alert &&
    Number.isInteger(alert.level) &&
    alert.level >= 0 &&
    alert.level < LEVELS.length &&
    finite(alert.slot)
  ) {
    triggers.alert = { level: alert.level, slot: alert.slot };
  }
  for (const hub of HUB_KEYS) {
    const one = object.prices?.[hub];
    if (one && typeof one.below === 'boolean' && finite(one.stamp) && finite(one.threshold)) {
      triggers.prices[hub] = { below: one.below, stamp: one.stamp, threshold: one.threshold };
    }
  }
  return triggers;
}

export class CaisoApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'caiso' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    store = createFileStore(),
    fetchImpl = (...args) => fetch(...args),
    urls = {},
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.urls = { outlook: urls.outlook ?? OUTLOOK_URL, oasis: urls.oasis ?? OASIS_URL };
    this.config = normalizeConfig();
    this.running = false;
    this.run = 0;
    this.timer = undefined;
    this.busy = undefined;
    this.abort = undefined;
    this.lifecycle = Promise.resolve();
    this.connection = 0;
    this.configTimer = undefined;
    this.configFailures = 0;
    this.configRun = undefined;
    this.lastStatus = undefined;
    /** Texts sent, by feature (forgotten at each connection: Gladys may have lost them). */
    this.sentTexts = new Map();
    this.publishRun = Promise.resolve();
    this.discoveryKey = undefined;
    this.saveFailed = false;
    /** The save running (one at a time), whether another is asked, whether it hangs. */
    this.saving = undefined;
    this.saveAgain = false;
    this.saveStuck = false;
    /**
     * Per source: when it was last asked (monotonic and wall), its pause after
     * a 429/5xx, the outcome of the last attempt, the data read (memory only),
     * the conditional headers to send back.
     */
    this.src = {
      [SOURCES.OUTLOOK]: { askedMono: undefined, askedWall: undefined, pause: undefined },
      [SOURCES.OASIS]: { askedMono: undefined, askedWall: undefined, pause: undefined },
    };
    this.lastOk = {};
    this.published = new Map();
    this.triggers = { alert: undefined, prices: {} };
    this.loaded = false;
    this.dataUnreadable = false;
    this.dataBlocked = false;
  }

  get intervalMs() {
    return this.config.intervalMinutes * MINUTE;
  }

  /** Awaits `promise` at most SAVE_WAIT; `fallback` after (the work goes on in the background). */
  async bounded(promise, fallback) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = this.timers.setTimeout(() => resolve(fallback), SAVE_WAIT);
        }),
      ]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /** Reads /data once, bounded in time (a /data that never answers is unreadable, not empty). */
  async load() {
    if (this.loaded) return;
    const loaded = await this.bounded(
      Promise.resolve()
        .then(() => this.store.load())
        .catch(() => ({ ok: false, code: 'error' })),
      { ok: false, code: 'timeout' },
    );
    this.loaded = true;
    const at = this.now();
    const mono = this.monotonic();
    const kept = loaded?.ok ? loaded.data : {};
    this.dataUnreadable = !loaded?.ok;
    this.dataBlocked = !loaded?.ok;
    for (const source of Object.values(SOURCES)) {
      const s = this.src[source];
      s.pause = validPause(kept.pauses?.[source], at, mono);
      // The last time the source was asked: the next request never comes
      // sooner than the interval (a date in the future is brought to now).
      const asked = kept.asked?.[source];
      if (finite(asked)) {
        s.askedWall = Math.min(asked, at);
        s.askedMono = mono - (at - s.askedWall);
      }
      const ok = kept.lastOk?.[source];
      if (finite(ok) && ok <= at) this.lastOk[source] = ok;
    }
    this.published = keptPublished(kept.published);
    this.triggers = keptTriggers(kept.triggers);
  }

  // --- Connection to Gladys -------------------------------------------------------

  /**
   * A (re)connection to Gladys: its configuration, then a start. A
   * `getConfig()` that fails is tried again without end (5 s doubled up to
   * 5 min), the status saying so, until it answers or the connection ends.
   */
  connected(getConfig) {
    const token = ++this.connection;
    this.configFailures = 0;
    this.clearConfigTimer();
    // Gladys may have restarted: the texts and the Discovery list are sent again.
    this.sentTexts.clear();
    this.discoveryKey = undefined;
    this.lastStatus = undefined;
    this.configRun = this.tryConfig(getConfig, token);
    return this.configRun;
  }

  /** The connection to Gladys is lost: the retries of getConfig end, the reads stop. */
  disconnected() {
    this.connection += 1;
    this.clearConfigTimer();
    return this.serialize(async () => {
      this.doStop();
      await this.saveState();
    });
  }

  /** The user saved the form: this configuration wins over a getConfig still being tried. */
  configUpdated(raw) {
    this.connection += 1;
    this.clearConfigTimer();
    return this.start(raw);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  async tryConfig(getConfig, token) {
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (token !== this.connection) return;
      const wait = Math.min(CONFIG_RETRY_MIN * 2 ** this.configFailures, CONFIG_RETRY_MAX);
      this.configFailures = Math.min(this.configFailures + 1, 16);
      this.logger.warn(`The configuration could not be read (${err?.name ?? 'Error'})`);
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnread(wait));
      if (token !== this.connection) return;
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.configRun = this.tryConfig(getConfig, token);
        return this.configRun;
      }, wait);
      return;
    }
    if (token !== this.connection) return;
    this.configFailures = 0;
    await this.start(raw);
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Applies a configuration; queued: saved one after the other, the last one wins. */
  start(raw = {}) {
    return this.serialize(() => this.doStart(raw));
  }

  /** Stops the reads, waits (bounded) for the one running, and writes /data (bounded). */
  stop() {
    this.connection += 1;
    this.clearConfigTimer();
    return this.serialize(async () => {
      const busy = this.busy;
      this.doStop();
      if (busy) {
        let timer;
        await Promise.race([
          busy.catch(() => {}),
          new Promise((resolve) => {
            timer = this.timers.setTimeout(resolve, STOP_WAIT);
          }),
        ]);
        this.timers.clearTimeout(timer);
      }
      await this.saveState();
    });
  }

  /** Resolves once every queued start/stop, the read running and the publication are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.configRun;
    await this.busy;
    await this.publishRun;
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  async doStart(raw) {
    this.config = normalizeConfig(raw);
    await this.load();
    if (this.dataUnreadable && this.dataBlocked) {
      // Never overwritten: kept under another name, then a fresh file.
      // Bounded: a /data that never answers never holds the start back; it is
      // then never written.
      const aside = await this.bounded(
        Promise.resolve()
          .then(() => this.store.setAside(this.now()))
          .then(
            () => true,
            () => false,
          ),
        false,
      );
      if (aside) {
        this.dataBlocked = false;
        this.logger.warn('/data could not be read: the file was set aside');
      } else {
        this.logger.error('/data could not be read nor set aside: nothing is written to it');
      }
    }
    // A read in flight goes on (the form changes nothing it asks); only the
    // timer is armed again for the new interval.
    this.running = true;
    await this.publishDiscovery();
    this.publishValues().catch(() => {});
    await this.updateStatus();
    this.schedule();
  }

  doStop() {
    this.running = false;
    this.run += 1;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.abort?.abort();
    this.abort = undefined;
  }

  // --- Schedule ----------------------------------------------------------------

  /** The devices of this integration the user created: [{ kind, id, features: Set }]. */
  createdDevices() {
    const list = [];
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseDeviceId(this.gladys, device?.external_id);
      if (!parsed) continue;
      const features = new Set((device.features ?? []).map((f) => f?.external_id));
      list.push({ ...parsed, features });
    }
    return list;
  }

  /** The sources a created device needs: Outlook for the grid, OASIS for a hub. */
  neededSources(devices = this.createdDevices()) {
    const needed = new Set();
    for (const device of devices) {
      needed.add(device.kind === 'grid' ? SOURCES.OUTLOOK : SOURCES.OASIS);
    }
    return needed;
  }

  /** When a source may be asked again (monotonic): the interval after it was asked, and its pause. */
  dueAt(source) {
    const s = this.src[source];
    const gap =
      source === SOURCES.OASIS ? Math.max(this.intervalMs, OASIS_MIN_GAP) : this.intervalMs;
    const next = s.askedMono === undefined ? -Infinity : s.askedMono + gap;
    return Math.max(next, s.pause?.due ?? -Infinity);
  }

  /**
   * Arms the next wake-up: the earliest source due, or the next change of a
   * view held in memory (a price interval starting, a reading turning stale).
   */
  schedule() {
    if (!this.running) return;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    const mono = this.monotonic();
    let wake = Infinity;
    for (const source of this.neededSources()) wake = Math.min(wake, this.dueAt(source));
    const change = this.nextChange(mono);
    if (change !== undefined) wake = Math.min(wake, Math.max(change, mono + MIN_WAKE));
    if (wake === Infinity) return;
    const gen = this.run;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (gen !== this.run || !this.running) return undefined;
        return this.tick(gen);
      },
      Math.max(0, wake - mono),
    );
  }

  /** The timer fired: one cycle at a time (a cycle running re-arms the timer when it ends). */
  tick(gen) {
    if (this.busy) return undefined;
    const tracked = this.cycle(gen).finally(() => {
      if (this.busy === tracked) this.busy = undefined;
      this.schedule();
    });
    this.busy = tracked;
    return tracked;
  }

  /** The sources due, one request at a time, then the publication and the status. */
  async cycle(gen) {
    try {
      for (const source of [SOURCES.OUTLOOK, SOURCES.OASIS]) {
        if (gen !== this.run) return;
        if (!this.neededSources().has(source)) continue;
        // One clock read for this decision: due, pause included.
        const mono = this.monotonic();
        if (mono < this.dueAt(source)) continue;
        await this.readSource(source, gen, mono);
      }
      if (gen !== this.run) return;
      await this.publishValues();
      if (gen !== this.run) return;
      await this.updateStatus();
      await this.saveState();
    } catch (err) {
      this.logger.error(`Read failed (${err?.name ?? 'Error'})`);
    }
  }

  // --- One source ------------------------------------------------------------------

  async readSource(source, gen, mono) {
    const s = this.src[source];
    const before = { mono: s.askedMono, wall: s.askedWall };
    // Asked: the time goes to /data before the request (the pace survives a
    // restart). The save is bounded (SAVE_WAIT): a frozen /data never holds
    // the request back more than that, and the next wake-up is armed when the
    // cycle ends.
    s.askedMono = mono;
    s.askedWall = this.now();
    await this.saveState();
    if (gen !== this.run) {
      // Stopped before anything left: this attempt does not count.
      s.askedMono = before.mono;
      s.askedWall = before.wall;
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    const isOasis = source === SOURCES.OASIS;
    let answer;
    try {
      answer = await getBody({
        url: isOasis ? oasisQuery(this.now(), this.urls.oasis) : this.urls.outlook,
        accept: isOasis
          ? 'application/zip, application/x-zip-compressed;q=0.9'
          : 'application/json, text/plain;q=0.9',
        maxBytes: isOasis ? OASIS_MAX_BYTES : OUTLOOK_MAX_BYTES,
        // The Outlook sends an ETag and a Last-Modified; OASIS neither.
        etag: isOasis ? undefined : s.data?.etag,
        lastModified: isOasis ? undefined : s.data?.lastModified,
        signal: abort.signal,
        fetchImpl: this.fetchImpl,
        timers: this.timers,
        binary: isOasis,
      });
    } catch (err) {
      if (gen === this.run) this.failed(source, err);
      return;
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
    // An answer to a read stopped meanwhile changes nothing.
    if (gen !== this.run) return;
    const at = this.monotonic();
    const wall = this.now();
    s.pause = undefined;
    // The reference "now" of the source: its Date header, when close to ours,
    // plus the Age a cache (CloudFront) adds: a copy kept by a cache is as old
    // as Date + Age says, never as fresh as the moment it was served.
    const ref =
      finite(answer.date) && Math.abs(answer.date - wall) <= DATE_HEADER_TRUST
        ? answer.date + (answer.age ?? 0)
        : wall;
    if (answer.status === 304) {
      if (s.data) {
        // Not modified: the reading keeps its dates (its age grows on the monotonic clock).
        s.outcome = { ok: true };
        this.lastOk[source] = wall;
      } else {
        s.outcome = { ok: false, code: 'format' };
      }
      return;
    }
    try {
      if (!isOasis) {
        // The Last-Modified is the UTC time the ISO wrote the file: the anchor
        // of its local times (never one in the future of the server).
        const anchor =
          finite(answer.lastModifiedAt) && answer.lastModifiedAt <= ref + FUTURE_SLACK
            ? answer.lastModifiedAt
            : NaN;
        const parsed = parseOutlook(answer.text, anchor);
        s.data = { parsed, ref, at, etag: answer.etag, lastModified: answer.lastModified };
        s.outcome = { ok: true };
      } else {
        const parsed = parseOasis(answer.bytes);
        if (parsed.kind === 'prices') {
          s.data = { prices: parsed.prices, ref, at };
          s.outcome = { ok: true };
        } else if (parsed.kind === 'no_data') {
          // An answer, but no price: the prices read earlier age out on their own.
          s.outcome = { ok: true, noData: true };
        } else {
          s.outcome = { ok: false, code: 'oasis_error', detail: parsed.code };
          return;
        }
      }
      this.lastOk[source] = wall;
    } catch (err) {
      if (!(err instanceof FormatError)) throw err;
      s.outcome = { ok: false, code: 'format' };
      this.logger.warn(`${source}: unexpected format`);
    }
  }

  /** A request that failed: a 429/5xx pauses the source (bounded, kept in /data). */
  failed(source, err) {
    const s = this.src[source];
    const code = err instanceof FetchError ? err.code : 'network';
    if (code === 'aborted') return;
    if (PAUSE_CODES.has(code)) {
      const count = (s.pause?.count ?? 0) + 1;
      const doubled = PAUSE_BASE * 2 ** Math.min(count - 1, 10);
      const wait = Math.min(Math.max(doubled, err.retryAfter ?? 0, PAUSE_MIN), PAUSE_MAX);
      const mono = this.monotonic();
      s.pause = { until: this.now() + wait, due: mono + wait, count, code, status: err.status };
      s.outcome = { ok: false, code, status: err.status, until: mono + wait };
    } else {
      s.outcome = { ok: false, code, status: err.status };
    }
    this.logger.warn(`${source}: read failed (${code}${err?.status ? ` ${err.status}` : ''})`);
  }

  // --- Views -----------------------------------------------------------------------

  /** What the grid shows at `mono`: undefined (nothing read since the start), stale or fresh. */
  gridView(mono) {
    const d = this.src[SOURCES.OUTLOOK].data;
    if (!d) return undefined;
    const refNow = d.ref + (mono - d.at);
    const fresh = (stamp) => {
      const age = refNow - stamp;
      return age >= -FUTURE_SLACK && age <= OUTLOOK_MAX_AGE;
    };
    const { slot, values, missing, conditions } = d.parsed;
    if (!fresh(slot)) return { code: 'stale', slot };
    const shown = {};
    const left = [...missing];
    for (const [key, value] of Object.entries(values)) {
      if (fresh(value.stamp)) shown[key] = value;
      else left.push(key);
    }
    const { level, unknown, transmission } = classify(conditions);
    if (level !== undefined) shown.alert_level = { value: level, stamp: slot };
    return {
      code: 'fresh',
      slot,
      values: shown,
      conditions,
      level,
      missing: left,
      unknown: conditions === undefined ? [] : unknown,
      noLevel: conditions !== undefined && level === undefined,
      transmission,
    };
  }

  /** What a hub shows at `mono`: undefined (nothing read since the start), no_data, stale or fresh. */
  hubView(hub, mono) {
    const d = this.src[SOURCES.OASIS].data;
    if (!d) return undefined;
    const refNow = d.ref + (mono - d.at);
    const slot = priceAt(d.prices[hub], refNow);
    if (!slot) return { code: 'no_data' };
    if (refNow - slot.end > PRICE_MAX_LAG)
      return { code: 'stale', start: slot.start, end: slot.end };
    return { code: 'fresh', start: slot.start, end: slot.end, value: slot.value };
  }

  /** The next time (monotonic) a view held in memory changes by itself, if any. */
  nextChange(mono) {
    let next;
    const at = (when) => {
      if (when > mono && (next === undefined || when < next)) next = when;
    };
    const o = this.src[SOURCES.OUTLOOK].data;
    if (o) {
      const toMono = (instant) => o.at + (instant - o.ref);
      const { slot, values } = o.parsed;
      at(toMono(slot + OUTLOOK_MAX_AGE) + 1);
      for (const value of Object.values(values)) at(toMono(value.stamp + OUTLOOK_MAX_AGE) + 1);
    }
    const p = this.src[SOURCES.OASIS].data;
    if (p) {
      const toMono = (instant) => p.at + (instant - p.ref);
      for (const list of Object.values(p.prices)) {
        for (const slot of list) {
          at(toMono(slot.start));
          at(toMono(slot.end + PRICE_MAX_LAG) + 1);
        }
      }
    }
    return next;
  }

  // --- Discovery -------------------------------------------------------------------

  /** The Discovery list: fixed, never a read. */
  async scan() {
    this.discoveryKey = undefined;
    await this.publishDiscovery();
  }

  async publishDiscovery() {
    const devices = allDevices(this.gladys, this.config.language);
    const key = JSON.stringify(devices);
    if (key === this.discoveryKey) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discoveryKey = key;
    } catch (err) {
      this.logger.warn(`Discovery not published (${err?.name ?? 'Error'})`);
    }
  }

  // --- Publication -------------------------------------------------------------------

  /**
   * The fresh values not published yet (each source reading once), the texts
   * that changed, then the scene events. One publication at a time (queued):
   * a start or a device created during a publication waits for it.
   */
  publishValues() {
    const run = this.publishRun.then(() => this.doPublish());
    this.publishRun = run.catch(() => {});
    return run;
  }

  async doPublish() {
    if (!this.running) return;
    // Stopped meanwhile (a stop, a disconnection): nothing more leaves.
    const gen = this.run;
    const live = () => gen === this.run && this.running;
    const mono = this.monotonic();
    const language = this.config.language;
    const values = [];
    const texts = [];
    const events = [];
    for (const device of this.createdDevices()) {
      const ids = idsOf(this.gladys, device.kind, device.id);
      const addValue = (key, value, stamp) => {
        const fid = ids.feature(key);
        if (!device.features.has(fid)) return;
        const last = this.published.get(fid);
        if (last !== undefined && stamp <= last) return;
        values.push({ fid, state: value, stamp });
      };
      const addText = (key, text) => {
        const fid = ids.feature(key);
        if (device.features.has(fid) && this.sentTexts.get(fid) !== text) texts.push({ fid, text });
      };
      if (device.kind === 'grid') {
        const view = this.gridView(mono);
        if (!view) continue;
        if (view.code === 'fresh') {
          for (const key of VALUE_KEYS.grid) {
            const value = view.values[key];
            if (value) addValue(key, value.value, value.stamp);
          }
          if (view.conditions) addText('conditions', view.conditions.join(', '));
          if (view.level !== undefined) events.push(...this.alertEvents(view));
        }
        addText('status', gridStatus(language, view));
      } else {
        const view = this.hubView(device.id, mono);
        if (!view) continue;
        if (view.code === 'fresh') {
          addValue('price', view.value, view.start);
          events.push(...this.priceEvents(device.id, view));
        }
        addText('status', hubStatus(language, view));
      }
    }
    if (values.length > 0) {
      // Marked BEFORE the request: a start or a device created during it
      // never sends the same reading again.
      const before = values.map((v) => this.published.get(v.fid));
      for (const v of values) this.published.set(v.fid, v.stamp);
      try {
        await this.gladys.publishStates(
          values.map((v) => ({ device_feature_external_id: v.fid, state: v.state })),
        );
      } catch (err) {
        values.forEach((v, k) => {
          if (this.published.get(v.fid) !== v.stamp) return;
          if (before[k] === undefined) this.published.delete(v.fid);
          else this.published.set(v.fid, before[k]);
        });
        this.logger.warn(`Values not published (${err?.name ?? 'Error'}): next read`);
        return;
      }
    }
    if (!live()) return;
    if (texts.length > 0) {
      for (const t of texts) this.sentTexts.set(t.fid, t.text);
      try {
        await this.gladys.publishStates(
          texts.map((t) => ({ device_feature_external_id: t.fid, text: t.text })),
        );
      } catch (err) {
        for (const t of texts) {
          if (this.sentTexts.get(t.fid) === t.text) this.sentTexts.delete(t.fid);
        }
        this.logger.warn(`Statuses not published (${err?.name ?? 'Error'})`);
      }
    }
    for (const event of events) {
      if (!live()) return;
      try {
        await this.gladys.publishSceneEvent(event.key, event.data);
        event.commit();
      } catch (err) {
        // Not marked: the change is seen again at the next reading.
        this.logger.warn(`Scene event not sent (${err?.name ?? 'Error'})`);
      }
    }
  }

  /**
   * The grid conditions changed level since the last reading seen (kept in
   * /data): one event. The first level ever seen is only a reference, and a
   * reading not newer than the last one evaluated changes nothing.
   */
  alertEvents(view) {
    const last = this.triggers.alert;
    if (last && view.slot <= last.slot) return [];
    const record = () => {
      this.triggers.alert = { level: view.level, slot: view.slot };
    };
    if (!last || last.level === view.level) {
      record();
      return [];
    }
    return [
      {
        key: 'grid_alert',
        data: {
          level: LEVELS[view.level],
          previous_level: LEVELS[last.level],
          conditions: (view.conditions ?? []).join(', ') || null,
        },
        commit: record,
      },
    ];
  }

  /**
   * A hub price crossed the threshold of the form since the last interval
   * seen (kept in /data): one event, "started" below it, "ended" back at or
   * above it. The first interval seen, or a new threshold, is only a reference.
   */
  priceEvents(hub, view) {
    const threshold = this.config.threshold;
    const last = this.triggers.prices[hub];
    if (last && view.start <= last.stamp) return [];
    const below = view.value < threshold;
    const record = () => {
      this.triggers.prices[hub] = { below, stamp: view.start, threshold };
    };
    if (!last || last.threshold !== threshold || last.below === below) {
      record();
      return [];
    }
    return [
      {
        key: 'low_price',
        data: { hub, phase: below ? 'started' : 'ended', price: view.value, threshold },
        commit: record,
      },
    ];
  }

  /** A device created: Gladys holds nothing for it; its fresh readings in memory are sent at once (never a read). */
  async onDeviceCreated(device) {
    this.forgetDevice(device);
    if (!this.running) return;
    await this.publishValues();
    await this.updateStatus();
    // A source it needs and never asked (or asked an interval ago) is read now.
    this.schedule();
  }

  /** A device renamed or moved: Gladys keeps its values, nothing to send again. */
  async onDeviceUpdated() {}

  async onDeviceDeleted(device) {
    this.forgetDevice(device);
    if (!this.running) return;
    await this.updateStatus();
    this.schedule();
  }

  /** Gladys holds nothing for this device: its last readings may be sent again. */
  forgetDevice(device) {
    const parsed = parseDeviceId(this.gladys, device?.external_id);
    if (!parsed) return;
    const ids = idsOf(this.gladys, parsed.kind, parsed.id);
    for (const key of [...VALUE_KEYS[parsed.kind], ...TEXT_KEYS[parsed.kind]]) {
      this.published.delete(ids.feature(key));
      this.sentTexts.delete(ids.feature(key));
    }
  }

  // --- Status ------------------------------------------------------------------------

  /** Whether a source holds fresh data for the devices that need it now. */
  freshSource(source, mono, devices) {
    if (source === SOURCES.OUTLOOK) return this.gridView(mono)?.code === 'fresh';
    return devices
      .filter((d) => d.kind === 'hub')
      .some((d) => this.hubView(d.id, mono)?.code === 'fresh');
  }

  async updateStatus() {
    const mono = this.monotonic();
    const devices = this.createdDevices();
    const needed = this.neededSources(devices);
    const parts = [];
    for (const note of this.config.notes) parts.push(T.notes[note]);
    if (this.dataUnreadable) parts.push(this.dataBlocked ? T.dataBlocked : T.dataUnreadable);
    if (this.saveStuck) parts.push(T.dataStuck);
    else if (this.saveFailed || (this.dataBlocked && !this.dataUnreadable))
      parts.push(T.dataUnwritable);
    if (needed.size === 0) {
      parts.unshift(T.noDevice);
      await this.setStatus(false, joinMessages(parts));
      return;
    }
    const sources = [SOURCES.OUTLOOK, SOURCES.OASIS].filter((s) => needed.has(s));
    if (sources.every((source) => this.src[source].outcome === undefined)) {
      // Nothing asked since the start: a read fine within the interval before
      // a restart (kept in /data) still counts; the next read comes at its pace.
      const due = Math.min(...sources.map((source) => this.dueAt(source)));
      const left = Math.max(0, due - mono);
      const wall = this.now();
      const fresh = sources.some(
        (source) =>
          this.lastOk[source] !== undefined &&
          wall - this.lastOk[source] <= this.intervalMs + 5 * MINUTE,
      );
      parts.unshift(fresh ? T.nextRead(left) : T.waiting(left));
      // A pause kept across the restart: said with its cause.
      for (const source of sources) {
        const pause = this.src[source].pause;
        if (pause && pause.due > mono) {
          parts.push(problemText(source, { ...pause, until: pause.due }, mono));
        }
      }
      if (needed.has(SOURCES.OUTLOOK)) parts.push(T.alertSource);
      if (needed.has(SOURCES.OASIS)) parts.push(T.wholesale);
      await this.setStatus(fresh, joinMessages(parts));
      return;
    }
    let connected = false;
    for (const source of sources) {
      const s = this.src[source];
      const outcome = s.outcome;
      const fresh = this.freshSource(source, mono, devices);
      if (outcome && !outcome.ok) {
        parts.push(problemText(source, outcome, mono));
      } else if (s.pause && s.pause.due > mono) {
        parts.push(problemText(source, { code: 'paused', until: s.pause.due }, mono));
      }
      if (outcome?.ok && fresh) connected = true;
      if (!fresh && outcome !== undefined) {
        parts.push(problemText(source, { code: outcome.noData ? 'no_data' : 'stale' }, mono));
      }
      if (source === SOURCES.OUTLOOK && fresh) {
        const view = this.gridView(mono);
        if (view.missing.length > 0) parts.push(problemText(source, { code: 'partial' }, mono));
        if (view.unknown.length > 0 || view.noLevel) {
          parts.push(problemText(source, { code: 'unknown_level', words: view.unknown }, mono));
        }
      }
    }
    if (needed.has(SOURCES.OUTLOOK)) parts.push(T.alertSource);
    if (needed.has(SOURCES.OASIS)) parts.push(T.wholesale);
    await this.setStatus(connected, joinMessages(parts));
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    try {
      await this.gladys.setConnectionStatus(connected, message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Status not sent (${err?.name ?? 'Error'})`);
    }
  }

  // --- /data ---------------------------------------------------------------------------

  /** What /data keeps, now. */
  stateSnapshot() {
    const pauses = {};
    const asked = {};
    for (const [source, s] of Object.entries(this.src)) {
      if (s.pause) {
        pauses[source] = {
          until: s.pause.until,
          count: s.pause.count,
          code: s.pause.code,
          ...(s.pause.status !== undefined ? { status: s.pause.status } : {}),
        };
      }
      if (s.askedWall !== undefined) asked[source] = s.askedWall;
    }
    return structuredClone({
      v: 1,
      asked,
      pauses,
      published: Object.fromEntries(this.published),
      triggers: this.triggers,
      lastOk: { ...this.lastOk },
    });
  }

  /**
   * Writes /data, awaited SAVE_WAIT at most. One save at a time: a save
   * asked while one runs is folded into a single next one (with the state of
   * that moment), never queued without end. A save that outlives SAVE_WAIT
   * is said in the status ("/data does not answer"); while it hangs, the
   * next saves are not awaited at all.
   */
  saveState() {
    if (!this.loaded || this.dataBlocked) return Promise.resolve(false);
    if (this.saving) {
      this.saveAgain = true;
      if (this.saveStuck) return Promise.resolve(false);
      return this.awaitSave();
    }
    this.saving = this.saveLoop().finally(() => {
      this.saving = undefined;
      this.saveStuck = false;
    });
    return this.awaitSave();
  }

  async awaitSave() {
    const LATE = Symbol('late');
    const done = await this.bounded(this.saving ?? Promise.resolve(true), LATE);
    if (done !== LATE) return done;
    if (!this.saveStuck) {
      this.saveStuck = true;
      this.logger.warn('/data does not answer');
    }
    return false;
  }

  async saveLoop() {
    let ok;
    do {
      this.saveAgain = false;
      try {
        await this.store.save(this.stateSnapshot());
        this.saveFailed = false;
        ok = true;
      } catch (err) {
        this.saveFailed = true;
        this.logger.warn(`/data not written (${err?.code ?? err?.name ?? 'Error'})`);
        ok = false;
      }
    } while (this.saveAgain);
    return ok;
  }
}
