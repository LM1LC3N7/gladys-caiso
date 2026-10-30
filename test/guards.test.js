// -----------------------------------------------------------------------------
// One test per guard that the other tests leave untouched (each one kills a
// mutant of the code): OASIS spacing, a read stopped before it left, a Date
// or a Last-Modified not trusted, a first 304, a slot in the future, the
// wake-ups of a view held in memory, a refused publication, the trigger
// states against an older reading, stop() bounded, getConfig overtaken by a
// saved form, a stop queued before a start, a device created again, a
// reconnection to a restarted Gladys, an answer after a stop, a restart long
// after the last read, /data values that are not dates.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { SOURCES } from '../src/constants.js';
import { FormatError, strictNumber } from '../src/outlook.js';
import { createMemoryStore } from '../src/store.js';
import { unzipOne } from '../src/zip.js';
import {
  GRID,
  HOUR,
  HUB,
  MINUTE,
  NOW,
  SECOND,
  answer,
  oasisZip,
  outlookBody,
  setup,
  slotOf,
} from './helpers/app.js';
import { testClock } from './helpers/clock.js';
import { zipOne } from './helpers/zip.js';

const statusText = (ctx) => ctx.status().message?.fr ?? '';

test('OASIS is never asked twice within 5 s, whatever the interval says', async () => {
  const ctx = await setup({ devices: 'hubs' });
  await ctx.begin();
  ctx.app.config = { ...ctx.app.config, intervalMinutes: 0.01 };
  const asked = ctx.app.src[SOURCES.OASIS].askedMono;
  assert.equal(ctx.app.dueAt(SOURCES.OASIS), asked + 5 * SECOND);
  assert.equal(ctx.app.dueAt(SOURCES.OUTLOOK), -Infinity);
});

test('a read stopped while /data is frozen, before its request left: not counted, nothing sent', async () => {
  const store = createMemoryStore();
  store.hold = new Promise(() => {});
  const ctx = await setup({ store, devices: 'grid' });
  ctx.app.connected(() => ctx.gladys.getConfig());
  await ctx.wait(SECOND);
  assert.equal(ctx.sources.count('outlook'), 0, 'waiting for the save');
  ctx.app.disconnected();
  await ctx.wait(6 * SECOND);
  assert.equal(ctx.sources.count('outlook'), 0, 'stopped: nothing left');
  store.hold = undefined;
  await ctx.begin();
  await ctx.wait(SECOND);
  assert.equal(ctx.sources.count('outlook'), 1, 'read at once: the stopped one did not count');
});

test('a server Date more than a day away is not the reference: our clock is', async () => {
  const ctx = await setup({ devices: 'grid' });
  const slot = slotOf(NOW - 3 * MINUTE);
  ctx.world.outlook = () =>
    answer(outlookBody({ slot }), { date: NOW + 2 * 24 * HOUR, lastModified: slot + 3 * MINUTE });
  await ctx.begin();
  assert.deepEqual(ctx.valuesOf(GRID('demand')), [24000]);
});

test('a Last-Modified after the server Date is not an anchor: the repeated hour is then unreadable', async () => {
  // 1 November, 10:00 UTC = 02:00 PST: the slot 01:55 exists twice.
  const at = Date.UTC(2026, 10, 1, 10, 0);
  const ctx = await setup({ devices: 'grid', clock: testClock({ start: at }) });
  const slot = Date.UTC(2026, 10, 1, 9, 55);
  ctx.world.outlook = () =>
    answer(outlookBody({ slot }), { date: ctx.clock.now(), lastModified: at + 3 * HOUR });
  await ctx.begin();
  assert.deepEqual(ctx.valuesOf(GRID('demand')), []);
  assert.match(statusText(ctx), /Today's Outlook : format inattendu/);
  // With a sound Last-Modified, the same file reads (the second 01:55).
  ctx.world.outlook = () =>
    answer(outlookBody({ slot }), { date: ctx.clock.now(), lastModified: slot + 3 * MINUTE });
  await ctx.wait(5 * MINUTE);
  assert.deepEqual(ctx.valuesOf(GRID('demand')), [24000]);
});

test('a first answer 304 (nothing held) is a format problem, never "fine"', async () => {
  const ctx = await setup({ devices: 'grid' });
  ctx.world.outlook = () => answer(null, { status: 304, date: ctx.clock.now() });
  await ctx.begin();
  assert.match(statusText(ctx), /Today's Outlook : format inattendu, rien publié/);
  assert.equal(ctx.status().connected, false);
});

test('a slot more than 5 minutes ahead of the server is never published', async () => {
  const ctx = await setup({ devices: 'grid' });
  ctx.world.outlook = () => {
    const now = ctx.clock.now();
    return answer(outlookBody({ slot: now + 8 * MINUTE }), {
      date: now,
      lastModified: now + 4 * MINUTE,
    });
  };
  await ctx.begin();
  assert.deepEqual(ctx.valuesOf(GRID('demand')), []);
  assert.match(ctx.valuesOf(GRID('status')).at(-1), /^Périmé/);
});

test('the next interval held in memory is published at its start, even with no older interval', async () => {
  const ctx = await setup({ devices: 'hubs', config: { interval_minutes: 15 } });
  const now0 = slotOf(NOW);
  ctx.world.state.oasisBody = () =>
    oasisZip({ from: now0, to: now0 + 10 * MINUTE, price: (h, start) => (start === now0 ? 1 : 2) });
  await ctx.begin();
  assert.deepEqual(ctx.valuesOf(HUB('np15')), [1]);
  await ctx.wait(4 * MINUTE + 2 * SECOND);
  assert.deepEqual(ctx.valuesOf(HUB('np15')), [1, 2]);
});

test('a wake-up for a view change never comes sooner than 1 s (no busy loop)', async () => {
  // No Date header: our clock (to the ms) is the reference. Started at
  // 06:04:59.5, the next interval (06:05:00) starts 0.5 s later; the
  // wake-up comes 1 s after the answer.
  const start = Date.UTC(2026, 9, 30, 6, 4, 59, 500);
  const ctx = await setup({ devices: 'hubs', clock: testClock({ start }) });
  const now0 = slotOf(start);
  ctx.world.oasis = () =>
    answer(
      oasisZip({ from: now0, to: now0 + 10 * MINUTE, price: (h, s) => (s === now0 ? 1 : 2) }),
      { type: 'application/x-zip-compressed' },
    );
  await ctx.app.connected(() => ctx.gladys.getConfig());
  await ctx.clock.advance(0);
  await ctx.app.idle();
  assert.deepEqual(ctx.valuesOf(HUB('np15')), [1]);
  for (let i = 0; i < 7; i += 1) await ctx.clock.advance(100);
  await ctx.app.idle();
  assert.deepEqual(ctx.valuesOf(HUB('np15')), [1], 'not yet at +0.7 s');
  for (let i = 0; i < 4; i += 1) await ctx.clock.advance(100);
  await ctx.app.idle();
  assert.deepEqual(ctx.valuesOf(HUB('np15')), [1, 2], 'at +1.1 s');
});

test('a publication refused by Gladys is sent again later (the reading is not marked)', async () => {
  const ctx = await setup({ devices: 'grid' });
  ctx.world.state.frozenSlot = slotOf(NOW - 3 * MINUTE);
  const publish = ctx.gladys.publishStates.bind(ctx.gladys);
  let refuse = 1;
  ctx.gladys.publishStates = (list) =>
    refuse-- > 0 ? Promise.reject(new Error('down')) : publish(list);
  await ctx.begin();
  assert.deepEqual(ctx.valuesOf(GRID('demand')), []);
  await ctx.wait(5 * MINUTE);
  assert.deepEqual(ctx.valuesOf(GRID('demand')), [24000]);
});

test('trigger states from /data newer than the reading: an older reading never fires', async () => {
  const slot = slotOf(NOW - 3 * MINUTE);
  const store = createMemoryStore({
    triggers: {
      alert: { level: 2, slot: slot + 5 * MINUTE },
      prices: { np15: { below: false, stamp: slotOf(NOW) + 10 * MINUTE, threshold: 0 } },
    },
  });
  const ctx = await setup({ store });
  ctx.world.state.price = () => -5;
  await ctx.begin();
  assert.deepEqual(ctx.valuesOf(GRID('alert_level')), [0]);
  assert.equal(ctx.valuesOf(HUB('np15')).length, 1);
  assert.deepEqual(ctx.gladys.fake.sceneEvents, []);
});

test('stop() during a frozen save of a read: within 3 s (the read) + 5 s (its own save)', async () => {
  const store = createMemoryStore();
  store.hold = new Promise(() => {});
  const ctx = await setup({ store, devices: 'grid' });
  ctx.app.connected(() => ctx.gladys.getConfig());
  await ctx.wait(SECOND);
  let stopped = false;
  ctx.app.stop().then(() => {
    stopped = true;
  });
  await ctx.wait(7 * SECOND);
  assert.equal(stopped, false);
  await ctx.wait(1500);
  assert.equal(stopped, true);
});

test('a form saved while getConfig is still answering wins over it', async () => {
  const ctx = await setup({ devices: 'grid' });
  let release;
  const late = new Promise((resolve) => {
    release = resolve;
  });
  ctx.app.connected(() => late);
  await ctx.gladys.fake.configUpdated({ interval_minutes: 10 });
  release({ interval_minutes: 60 });
  await ctx.wait(SECOND);
  await ctx.app.idle();
  assert.equal(ctx.app.config.intervalMinutes, 10);
});

test('a disconnection during a slow start is queued behind it: the app ends up stopped', async () => {
  // A start slowed by a /data that takes 5 s to read (bounded).
  const store = createMemoryStore();
  store.loadHold = new Promise(() => {});
  const ctx = await setup({ store, devices: 'grid' });
  ctx.app.connected(() => ctx.gladys.getConfig());
  await ctx.wait(SECOND);
  ctx.app.disconnected();
  await ctx.wait(6 * SECOND);
  await ctx.app.idle();
  assert.equal(ctx.app.running, false);
  await ctx.wait(10 * MINUTE);
  assert.equal(ctx.sources.count('outlook'), 0);
  // Connected again: running, reading.
  ctx.app.connected(() => ctx.gladys.getConfig());
  await ctx.wait(2 * SECOND);
  await ctx.app.idle();
  assert.equal(ctx.app.running, true);
  assert.equal(ctx.sources.count('outlook'), 1);
});

test('a device deleted then created again gets the fresh reading again', async () => {
  const ctx = await setup({ devices: 'grid' });
  await ctx.begin();
  await ctx.remove('grid', 'caiso');
  await ctx.create('grid', 'caiso');
  await ctx.app.idle();
  assert.deepEqual(ctx.valuesOf(GRID('demand')), [24000, 24000]);
});

test('a reconnection (Gladys may have restarted): texts, Discovery and status sent again', async () => {
  const ctx = await setup({ devices: 'grid' });
  await ctx.begin();
  const texts = ctx.valuesOf(GRID('status')).length;
  const statuses = ctx.gladys.fake.connectionStatuses.length;
  const discovery = ctx.gladys.fake.bodies(
    'POST',
    '/api/v1/external_integration/discovered_device',
  ).length;
  await ctx.app.disconnected();
  await ctx.begin();
  assert.equal(ctx.valuesOf(GRID('status')).length, texts + 1);
  assert.equal(ctx.valuesOf(GRID('conditions')).length, 2);
  assert.ok(ctx.gladys.fake.connectionStatuses.length > statuses);
  assert.ok(
    ctx.gladys.fake.bodies('POST', '/api/v1/external_integration/discovered_device').length >
      discovery || discovery === 0,
  );
});

test('an answer arriving after a stop changes nothing (no data, no outcome)', async () => {
  const ctx = await setup({ devices: 'grid' });
  const live = ctx.world.outlook;
  // A source that ignores the abort and answers 5 s later.
  ctx.world.outlook = (...args) =>
    new Promise((resolve) => ctx.clock.timers.setTimeout(() => resolve(live(...args)), 5000));
  ctx.app.connected(() => ctx.gladys.getConfig());
  await ctx.wait(2 * SECOND);
  assert.equal(ctx.sources.count('outlook'), 1);
  ctx.app.disconnected();
  await ctx.wait(6 * SECOND);
  assert.equal(ctx.app.src.outlook.data, undefined);
  assert.equal(ctx.app.src.outlook.outcome, undefined);
  assert.equal(ctx.app.lastOk.outlook, undefined);
});

test('a restart long after the last good read: "waiting", never "connected" from /data', async () => {
  const store = createMemoryStore({
    asked: { outlook: NOW - MINUTE },
    lastOk: { outlook: NOW - 3 * HOUR },
  });
  const ctx = await setup({ store, devices: 'grid' });
  await ctx.begin();
  assert.equal(ctx.sources.count('outlook'), 0);
  assert.equal(ctx.status().connected, false);
  assert.match(statusText(ctx), /^En attente de la première lecture \(dans 4 min\)/);
});

test('/data "published" values that are not dates are ignored, never a reason to skip a reading', async () => {
  const store = createMemoryStore({
    published: { [GRID('demand')]: '99999999999999999', [GRID('co2')]: null },
  });
  const ctx = await setup({ store, devices: 'grid' });
  await ctx.begin();
  assert.deepEqual(ctx.valuesOf(GRID('demand')), [24000]);
  assert.deepEqual(ctx.valuesOf(GRID('co2')), [6600]);
});

test('strict numbers: an infinite or NaN number is unknown', () => {
  assert.equal(strictNumber(Infinity), undefined);
  assert.equal(strictNumber(-Infinity), undefined);
  assert.equal(strictNumber(NaN), undefined);
  assert.equal(strictNumber(0), 0);
});

test('ZIP: a stored file above the cap is refused; a bomb is cut by the inflater itself', () => {
  assert.throws(
    () => unzipOne(zipOne('a.csv', 'x'.repeat(200), { deflate: false }), 100),
    FormatError,
  );
  // A file declared 50 bytes that inflates to 10 MB: the inflater stops at the cap.
  const small = zipOne('a.csv', 'y'.repeat(50));
  const body = deflateRawSync(Buffer.alloc(10 * 1024 * 1024, 0x41));
  const local = small.subarray(0, 35);
  const central = Buffer.from(small.subarray(small.length - 22 - 51, small.length - 22));
  central.writeUInt32LE(body.length, 20);
  const end = Buffer.from(small.subarray(small.length - 22));
  end.writeUInt32LE(35 + body.length, 16);
  assert.throws(() => unzipOne(Buffer.concat([local, body, central, end]), 1024), /cannot inflate/);
});

// --- Review r1 -----------------------------------------------------------------------

test('a copy kept by a cache (Date + Age) is as old as it is: 2 h old is stale, never published', async () => {
  for (const age of [7200, 25 * 60]) {
    const ctx = await setup({ devices: 'grid' });
    ctx.world.outlook = () => {
      const date = ctx.clock.now() - age * SECOND;
      const slot = slotOf(date - 3 * MINUTE);
      return answer(outlookBody({ slot }), {
        date,
        lastModified: slot + 3 * MINUTE,
        headers: { age: String(age) },
      });
    };
    await ctx.begin();
    assert.deepEqual(ctx.valuesOf(GRID('demand')), [], `Age ${age}`);
    assert.match(ctx.valuesOf(GRID('status')).at(-1), /^Périmé/);
    assert.equal(ctx.status().connected, false);
  }
  // The real CloudFront case: Date 21 s behind, Age 22: fresh.
  const ctx = await setup({ devices: 'grid' });
  const live = ctx.world.outlook;
  ctx.world.outlook = (...args) => {
    const r = live(...args);
    const h = new Headers(r.headers);
    h.set('date', new Date(ctx.clock.now() - 21 * SECOND).toUTCString());
    h.set('age', '22');
    return new Response(r.body, { status: 200, headers: h });
  };
  await ctx.begin();
  assert.deepEqual(ctx.valuesOf(GRID('demand')), [24000]);
});

test('one request at a time, even when a device is created during a read', async () => {
  const ctx = await setup({ devices: 'grid' });
  let inFlight = 0;
  let peak = 0;
  const slow = (key) => {
    const live = ctx.world[key];
    ctx.world[key] = (...args) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) =>
        ctx.clock.timers.setTimeout(() => {
          inFlight -= 1;
          resolve(live(...args));
        }, 3000),
      );
    };
  };
  slow('outlook');
  slow('oasis');
  ctx.app.connected(() => ctx.gladys.getConfig());
  await ctx.wait(2 * SECOND);
  assert.equal(ctx.sources.count('outlook'), 1);
  assert.equal(inFlight, 1, 'the Outlook still answering');
  await ctx.create('hub', 'np15');
  await ctx.wait(10 * SECOND);
  await ctx.app.idle();
  assert.equal(ctx.sources.count('oasis'), 1);
  assert.equal(peak, 1);
});

test('a last good read dated in the future in /data (clock set back) is not believed', async () => {
  const store = createMemoryStore({
    asked: { outlook: NOW - MINUTE },
    lastOk: { outlook: NOW + HOUR },
  });
  const ctx = await setup({ store, devices: 'grid' });
  await ctx.begin();
  assert.equal(ctx.status().connected, false);
  assert.match(statusText(ctx), /^En attente de la première lecture/);
});

test('a state is never sent to a feature the device does not have', async () => {
  const [grid] = (await import('./helpers/app.js')).discovered();
  grid.features = grid.features.filter((f) => !f.external_id.endsWith(':demand'));
  const ctx = await setup({ devices: [grid] });
  await ctx.begin();
  assert.deepEqual(ctx.valuesOf(GRID('demand')), []);
  assert.deepEqual(ctx.valuesOf(GRID('co2')), [6600]);
});

test('/data trigger states out of range are ignored: a level 99 is no reference', async () => {
  const store = createMemoryStore({ triggers: { alert: { level: 99, slot: NOW - HOUR } } });
  const ctx = await setup({ store, devices: 'grid' });
  await ctx.begin();
  assert.deepEqual(ctx.gladys.fake.sceneEvents, []);
  assert.equal(ctx.store.data.triggers.alert.level, 0);
});

test('a disconnection ends a getConfig still in flight: its answer starts nothing', async () => {
  const ctx = await setup({ devices: 'grid' });
  let release;
  ctx.app.connected(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await ctx.wait(SECOND);
  await ctx.app.disconnected();
  release({});
  await ctx.wait(10 * SECOND);
  await ctx.app.idle();
  assert.equal(ctx.app.running, false);
  assert.equal(ctx.sources.requests.length, 0);
});

test('after stop(), a publication already started sends no text and no event', async () => {
  const ctx = await setup({ devices: 'grid' });
  await ctx.begin();
  ctx.world.state.outlook = { set: { gridstatus: ['Flex Alert'] } };
  const publish = ctx.gladys.publishStates.bind(ctx.gladys);
  ctx.gladys.publishStates = (list) =>
    new Promise((resolve) => ctx.clock.timers.setTimeout(resolve, 2000)).then(() => publish(list));
  await ctx.wait(5 * MINUTE + 500);
  const before = ctx.gladys.fake.states.length;
  const stopped = ctx.app.stop();
  await ctx.wait(10 * SECOND);
  await stopped;
  const after = ctx.gladys.fake.states.slice(before);
  // The values were already on their way; no text nor event after the stop.
  assert.ok(
    after.every((st) => st.text === undefined),
    JSON.stringify(after),
  );
  assert.deepEqual(ctx.gladys.fake.sceneEvents, []);
});

test('an error answered after a stop changes nothing (no pause, no outcome)', async () => {
  const ctx = await setup({ devices: 'grid' });
  ctx.world.outlook = () =>
    new Promise((resolve) =>
      ctx.clock.timers.setTimeout(() => resolve(answer('busy', { status: 503 })), 5000),
    );
  ctx.app.connected(() => ctx.gladys.getConfig());
  await ctx.wait(2 * SECOND);
  ctx.app.disconnected();
  await ctx.wait(6 * SECOND);
  assert.equal(ctx.app.src.outlook.pause, undefined);
  assert.equal(ctx.app.src.outlook.outcome, undefined);
});

test('a file with only a slot (every value unreadable) still turns stale on time, without a read', async () => {
  const ctx = await setup({ devices: 'grid', config: { interval_minutes: 60 } });
  const slot = slotOf(NOW - 3 * MINUTE);
  const nulls = {
    CurrentSystemDemand: null,
    CurrentNetDemand: null,
    renewablesPercent: null,
    currentCo2intensity: null,
    currentCo2: null,
    gridstatus: null,
  };
  ctx.world.outlook = () =>
    answer(outlookBody({ slot, set: nulls }), {
      date: ctx.clock.now(),
      lastModified: slot + 3 * MINUTE,
    });
  await ctx.begin();
  assert.match(ctx.valuesOf(GRID('status')).at(-1), /^Relevé du/);
  await ctx.wait(20 * MINUTE);
  assert.equal(ctx.sources.count('outlook'), 1);
  assert.match(ctx.valuesOf(GRID('status')).at(-1), /^Périmé/);
});

test('ZIP: a protected entry is refused', () => {
  const zip = zipOne('a.csv', 'hello', { deflate: false });
  const cd = zip.length - 22 - 46 - 5;
  zip.writeUInt16LE(1, cd + 8);
  assert.throws(() => unzipOne(zip, 100), /protected entry/);
});

test('/data that hangs on a save: said in the status, saves never pile up', async () => {
  const store = createMemoryStore();
  const ctx = await setup({ store, devices: 'grid' });
  await ctx.begin();
  let calls = 0;
  store.save = () => {
    calls += 1;
    return new Promise(() => {});
  };
  await ctx.wait(10 * MINUTE + 20 * SECOND);
  assert.equal(calls, 1, 'one save waits, the others fold into it');
  assert.match(statusText(ctx), /\/data ne répond pas/);
  // The reads keep their pace meanwhile.
  assert.equal(ctx.sources.count('outlook'), 3);
});

test('a restart during a pause: the status says the pause and its cause', async () => {
  const store = createMemoryStore({
    asked: { oasis: NOW - MINUTE },
    pauses: { oasis: { until: NOW + 20 * MINUTE, count: 2, code: 'rate_limited', status: 429 } },
  });
  const ctx = await setup({ store, devices: 'hubs' });
  await ctx.begin();
  assert.equal(ctx.sources.count('oasis'), 0);
  assert.match(statusText(ctx), /prix OASIS : trop de requêtes \(HTTP 429\), pause de 20 min/);
});

test('the repeated hour of November: PDT then PST in the texts', async () => {
  const at = Date.UTC(2026, 10, 1, 8, 59);
  const ctx = await setup({ devices: 'grid', clock: testClock({ start: at }) });
  await ctx.begin();
  await ctx.wait(HOUR);
  const texts = ctx.valuesOf(GRID('status'));
  assert.ok(texts.includes('Relevé du 01/11 01:55 PDT'), JSON.stringify(texts));
  assert.ok(texts.includes('Relevé du 01/11 01:55 PST'), JSON.stringify(texts));
});

test('a long status text is cut at a word, with an ellipsis, never inside a word', async () => {
  const { bound, gridStatus } = await import('../src/i18n.js');
  assert.equal(bound('short text'), 'short text');
  const cut = bound('word '.repeat(50));
  assert.ok(cut.length <= 160);
  assert.match(cut, / word…$/);
  assert.equal(bound('x'.repeat(200)).length, 160);
  const all = gridStatus('fr', {
    code: 'fresh',
    slot: Date.UTC(2026, 9, 30, 5, 55),
    missing: ['demand', 'net_demand', 'renewables', 'carbon_intensity', 'co2', 'conditions'],
    noLevel: true,
  });
  assert.ok(all.length <= 160, all);
  const lastWord = all
    .replace(/…$/, '')
    .split(/[\s,;]+/)
    .at(-1);
  assert.ok(
    /…$/.test(all) === false ||
      ["d'alerte", 'reconnu', 'conditions', 'CO2', 'carbone', 'intensité', 'renouvelable'].includes(
        lastWord,
      ),
    all,
  );
});

test('/data pauses that are not ours (count 0, unknown code) are ignored: read at once', async () => {
  for (const pause of [
    { until: NOW + HOUR, count: 0, code: 'rate_limited' },
    { until: NOW + HOUR, count: 2, code: 'maintenance' },
  ]) {
    const store = createMemoryStore({ pauses: { oasis: pause } });
    const ctx = await setup({ store, devices: 'hubs' });
    await ctx.begin();
    assert.equal(ctx.sources.count('oasis'), 1, JSON.stringify(pause));
  }
});

// --- Review r2 -----------------------------------------------------------------------

test('a negative Age never makes an old reading fresh', async () => {
  const { parseAge } = await import('../src/http.js');
  assert.equal(parseAge('-3600'), 0);
  assert.equal(parseAge('22'), 22_000);
  assert.equal(parseAge('99999999'), 24 * HOUR);
  const ctx = await setup({ devices: 'grid' });
  ctx.world.outlook = () => {
    const slot = slotOf(ctx.clock.now() - 70 * MINUTE);
    return answer(outlookBody({ slot }), {
      date: ctx.clock.now(),
      lastModified: slot + 3 * MINUTE,
      headers: { age: '-3600' },
    });
  };
  await ctx.begin();
  assert.deepEqual(ctx.valuesOf(GRID('demand')), []);
});

test('stop() while a scene event is being sent: the next ones never leave', async () => {
  const ctx = await setup({ devices: 'hubs', config: { low_price_threshold: 20 } });
  const prices = new Map();
  let price = 50;
  ctx.world.state.price = (hub, start) => {
    if (!prices.has(start)) prices.set(start, price);
    return prices.get(start);
  };
  await ctx.begin();
  let sent = 0;
  let stopping;
  const publish = ctx.gladys.publishSceneEvent.bind(ctx.gladys);
  ctx.gladys.publishSceneEvent = async (key, data) => {
    sent += 1;
    if (sent === 1) stopping = ctx.app.stop();
    await new Promise((resolve) => setImmediate(resolve));
    return publish(key, data);
  };
  price = 10;
  await ctx.wait(10 * MINUTE);
  await stopping;
  await ctx.wait(SECOND);
  assert.equal(sent, 1, 'three hubs went below; only the event in flight left');
});

test('a publication that starts after stop() sends nothing, values included', async () => {
  const ctx = await setup();
  await ctx.begin();
  ctx.app.forgetDevice({ external_id: 'ext:caiso:hub:np15' });
  await ctx.app.stop();
  const n = ctx.gladys.fake.states.length;
  await ctx.app.publishValues();
  assert.equal(ctx.gladys.fake.states.length, n);
});

test('saves asked while one hangs are written once it ends; "/data does not answer" then clears', async () => {
  const store = createMemoryStore();
  const ctx = await setup({ store });
  const save = store.save.bind(store);
  let first = true;
  store.save = async (data) => {
    if (first) {
      first = false;
      await new Promise((resolve) => ctx.clock.timers.setTimeout(resolve, 24 * SECOND));
    }
    return save(data);
  };
  ctx.app.connected(() => ctx.gladys.getConfig());
  await ctx.wait(12 * SECOND);
  assert.match(statusText(ctx), /\/data ne répond pas/);
  await ctx.wait(20 * SECOND);
  await ctx.app.idle();
  assert.equal(store.data.asked.oasis, ctx.app.src.oasis.askedWall, 'the folded save was written');
  assert.equal(store.data.asked.outlook, ctx.app.src.outlook.askedWall);
  await ctx.wait(5 * MINUTE);
  await ctx.app.idle();
  assert.doesNotMatch(statusText(ctx), /ne répond pas/);
});

test('a status cut falls between two words, never inside one', async () => {
  const { bound } = await import('../src/i18n.js');
  const text =
    'Reading of 10/29 23:50 PDT; not published: demand, net demand, renewables, carbon intensity';
  for (const max of [30, 45, 60, 75]) {
    const out = bound(text, max);
    assert.ok(out.length <= max, out);
    const head = out.replace(/…$/, '');
    assert.ok(text.startsWith(head), out);
    assert.match(text[head.length] ?? ' ', /[\s;,:]/, `${max}: ${out}`);
  }
});
