// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, scripted sources (a fetch that
// answers from builders shaped like the real files of the ISO, numbers made
// up) and a virtual clock (test/helpers/clock.js).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CaisoApp } from '../../src/app.js';
import { allDevices } from '../../src/devices.js';
import { toLocal } from '../../src/pacific.js';
import { createMemoryStore } from '../../src/store.js';
import { wire } from '../../src/wire.js';
import { settle, testClock } from './clock.js';
import { zipOne } from './zip.js';

export const SELECTOR = 'caiso';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
/** 2026-10-30 06:01 UTC = 23:01 PDT on the 29th. */
export const NOW = Date.UTC(2026, 9, 30, 6, 1);
export const URLS = {
  outlook: 'https://outlook.test/current/stats.txt',
  oasis: 'https://oasis.test/oasisapi/SingleZip',
};
export const F = (kind, id, key) => `ext:${SELECTOR}:${kind}:${id}:${key}`;
export const D = (kind, id) => `ext:${SELECTOR}:${kind}:${id}`;
export const GRID = (key) => F('grid', 'caiso', key);
export const HUB = (hub, key = 'price') => F('hub', hub, key);

const pad = (n) => String(n).padStart(2, '0');
const SLOT = 5 * MINUTE;
/** The 5-minute slot holding `at`. */
export const slotOf = (at) => Math.floor(at / SLOT) * SLOT;

/** "10/29/2026 23:00" (Pacific) for an instant. */
export function slotText(utc) {
  const d = new Date(toLocal(utc));
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "20261029225456" (Pacific) for an instant. */
export function stampText(utc) {
  const d = new Date(toLocal(utc));
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * A stats.txt of the Outlook: the keys of the real file (2026-10-30), in its
 * layout (a JSON object indented by 4), the numbers made up. `slot`: the UTC
 * instant of the slot; `set`: keys replaced; `drop`: keys left out.
 */
export function outlookBody({ slot, set = {}, drop = [] } = {}) {
  const data = {
    Unloaded_capacity_derated_max: 30000,
    todayForecastPeakDemand: 27000,
    CurrentSystemDemandWithoutPump: 23000,
    Required_reserve: 1100,
    Current_reserve: 2500,
    currentNuclear: 1100,
    currentGeothermal: 700,
    currentSolar: -60,
    currentImports: 2200,
    currentRenewables: 4800,
    currentCo2: 6600,
    CurrentSystemDemandWithoutPumpTS: stampText(slot - 40 * SECOND),
    CurrentNetDemandWithoutPumpTS: stampText(slot - 50 * SECOND),
    currentWind: 3700,
    CurrentSystemDemand: 24000,
    CurrentSystemDemandTS: stampText(slot - 4 * SECOND),
    currentNaturalGas: 12900,
    gridstatus: ['Normal'],
    slotDate: slotText(slot),
    renewablesPercentwoBatteries: 20,
    renewablesPercent: 20,
    CurrentNetDemand: 20500,
    CurrentNetDemandTS: stampText(slot - 49 * SECOND),
    currentBatteries: 1100,
    PS_VERSION: '1.26b',
    currentCo2intensity: 0.275,
    ...set,
  };
  for (const key of drop) delete data[key];
  return JSON.stringify(data, null, 4);
}

export const OASIS_HEADER =
  'INTERVALSTARTTIME_GMT,INTERVALENDTIME_GMT,OPR_DT,OPR_HR,NODE_ID_XML,NODE_ID,NODE,MARKET_RUN_ID,LMP_TYPE,XML_DATA_ITEM,PNODE_RESMRID,GRP_TYPE,POS,VALUE,OPR_INTERVAL,GROUP';

const gmt = (utc) => `${new Date(utc).toISOString().slice(0, 19)}-00:00`;
export const NODES = {
  np15: 'TH_NP15_GEN-APND',
  sp15: 'TH_SP15_GEN-APND',
  zp26: 'TH_ZP26_GEN-APND',
};

/** One CSV row of OASIS (the real columns): `type` LMP or a component. */
export function oasisRow({ start, end = start + SLOT, node, type = 'LMP', value }) {
  const item = { LMP: 'LMP_PRC', MCC: 'LMP_CONG_PRC', MCE: 'LMP_ENE_PRC' }[type] ?? 'LMP_X';
  return [
    gmt(start),
    gmt(end),
    '2026-10-29',
    '23',
    node,
    node,
    node,
    'RTM',
    type,
    item,
    node,
    'ALL_APNODES',
    '0',
    String(value),
    '1',
    '1',
  ].join(',');
}

/**
 * The ZIP of an OASIS answer: for each 5-minute slot from `from` to `to`
 * (excluded), the LMP of each hub (`price(hub, start)`), plus a component row.
 */
export function oasisZip({ from, to, price = () => 50, hubs = Object.keys(NODES), extra = [] }) {
  const rows = [];
  for (let start = from; start < to; start += SLOT) {
    for (const hub of hubs) {
      const value = price(hub, start);
      if (value === undefined) continue;
      rows.push(oasisRow({ start, node: NODES[hub], value }));
      rows.push(oasisRow({ start, node: NODES[hub], type: 'MCC', value: -1.5 }));
    }
  }
  const csv = [OASIS_HEADER, ...rows, ...extra].join('\n');
  return zipOne('20261029_20261029_PRC_INTVL_LMP_RTM_20261029_23_01_48_v3.csv', csv);
}

/** The XML error OASIS sends inside a ZIP (the real layout, the disclaimer cut). */
export function oasisError(code = 1000, text = 'No data returned for the specified selection') {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<m:OASISReport xmlns:m="http://www.caiso.com/soa/OASISReport_v1.xsd">
<m:MessageHeader>
\t<m:TimeDate>2026-10-30T06:02:03.362Z</m:TimeDate>
\t<m:Source>OASIS</m:Source>
\t<m:Version>v20131201</m:Version>
</m:MessageHeader>
<m:MessagePayload>
<m:RTO>
<m:name>CAISO</m:name>
<m:ERROR>
<m:ERR_CODE>${code}</m:ERR_CODE>
<m:ERR_DESC>${text}</m:ERR_DESC>
</m:ERROR>
</m:RTO>
</m:MessagePayload>
</m:OASISReport>`;
  return zipOne('20261029_20261029_PRC_INTVL_LMP_RTM_20261029_23_02_03_v3.xml', xml);
}

// --- Sources ---------------------------------------------------------------------------

/** A Response as the ISO's servers send: Date always, Last-Modified when given. */
export function answer(body, { status = 200, headers = {}, date, lastModified, type } = {}) {
  const h = { ...headers };
  if (date !== undefined) h.date = new Date(date).toUTCString();
  if (lastModified !== undefined) h['last-modified'] = new Date(lastModified).toUTCString();
  if (type) h['content-type'] = type;
  return new Response(status === 304 ? null : body, { status, headers: h });
}

/**
 * The sources: `world.outlook(request)` / `world.oasis(request)` -> a
 * Response, 'hang' (never answers), an Error (network) or a promise of one of
 * these. `requests` lists every request with its time and URL.
 */
export function createSources(clock, world = {}) {
  const sources = { world, requests: [] };
  const keyOf = (url) =>
    url.startsWith(URLS.outlook) ? 'outlook' : url.startsWith(URLS.oasis) ? 'oasis' : undefined;
  sources.fetch = async (url, init) => {
    const key = keyOf(String(url));
    const request = {
      key,
      url: String(url),
      at: clock.now(),
      mono: clock.monotonic(),
      headers: init?.headers ?? {},
    };
    sources.requests.push(request);
    let reply = await sources.world[key]?.(request, init);
    if (reply === 'hang') {
      reply = await new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    }
    if (reply instanceof Error) throw reply;
    if (reply instanceof Response) return reply;
    return answer('not found', { status: 404 });
  };
  sources.count = (key) => sources.requests.filter((r) => r.key === key).length;
  sources.of = (key) => sources.requests.filter((r) => r.key === key);
  return sources;
}

/**
 * Sources that follow the clock: the Outlook of the slot that just ended
 * (written 3 minutes after it, as the ISO does), OASIS prices from 30
 * minutes back to 10 minutes ahead. `state` changes what they say.
 */
export function liveWorld(clock, state = {}) {
  const s = {
    price: () => 50,
    outlook: {},
    lag: 0,
    ...state,
  };
  const world = {
    state: s,
    outlook: () => {
      const now = clock.now();
      const slot = s.frozenSlot ?? slotOf(now - 3 * MINUTE - s.lag);
      return answer(outlookBody({ slot, ...s.outlook }), {
        date: now,
        lastModified: Math.min(slot + 3 * MINUTE, now),
        type: 'text/plain',
        headers: { etag: `"${slot}"` },
      });
    },
    oasis: () => {
      const now = clock.now() - s.lag;
      const body = s.oasisBody
        ? s.oasisBody()
        : oasisZip({
            from: slotOf(now) - 30 * MINUTE,
            to: slotOf(now) + 10 * MINUTE,
            price: s.price,
          });
      return answer(body, { date: clock.now(), type: 'application/x-zip-compressed' });
    },
  };
  return world;
}

export const quiet = () => {
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  return { lines, info: log, warn: log, error: log, debug: log };
};

/** The devices of the Discovery list as the user creates them. */
export function discovered(language = 'fr') {
  const fake = {
    externalIds: (type, id) => ({
      device: `ext:${SELECTOR}:${type}:${id}`,
      feature: (key) => `ext:${SELECTOR}:${type}:${id}:${key}`,
    }),
  };
  return allDevices(fake, language);
}

/**
 * `devices`: 'all' | 'grid' | 'hubs' | [] | devices (created before the start).
 */
export async function setup({
  store = createMemoryStore(),
  config = {},
  start = NOW,
  clock = testClock({ start }),
  world,
  devices = 'all',
} = {}) {
  const list =
    devices === 'all'
      ? discovered()
      : devices === 'grid'
        ? discovered().slice(0, 1)
        : devices === 'hubs'
          ? discovered().slice(1)
          : devices;
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices: structuredClone(list) });
  await gladys.connect();
  const w = world ?? liveWorld(clock);
  const sources = createSources(clock, w);
  const logger = quiet();
  const app = new CaisoApp({
    gladys,
    logger,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    fetchImpl: sources.fetch,
    urls: URLS,
  });
  // The handlers as index.js wires them; 'connected' is driven by `begin()`.
  wire(gladys, app, logger);
  gladys.removeAllListeners('connected');
  gladys.removeAllListeners('disconnected');
  // The virtual time moves by steps of at most 1 s, with turns of the event
  // loop between them: a timer armed at the end of a chain of promises (a
  // fetch, a save) is never left behind by a long jump.
  const wait = async (ms) => {
    let left = ms;
    do {
      const step = Math.min(left, SECOND);
      await clock.advance(step);
      await settle(4);
      left -= step;
    } while (left > 0);
    await settle(6);
  };
  const begin = async () => {
    await app.connected(() => gladys.getConfig());
    await wait(0);
    await app.idle();
    await settle(10);
  };
  const create = async (kind, id) => {
    const device = discovered(app.config.language).find((d) => d.external_id === D(kind, id));
    await gladys.fake.deviceCreated(structuredClone(device));
    await settle(10);
    return device;
  };
  const remove = async (kind, id) => {
    const device = gladys.devices.find((d) => d.external_id === D(kind, id));
    await gladys.fake.deviceDeleted(structuredClone(device));
    await settle(10);
  };
  const statesOf = (fid) => gladys.fake.states.filter((s) => s.device_feature_external_id === fid);
  const valuesOf = (fid) => statesOf(fid).map((s) => s.state ?? s.text);
  const status = () => gladys.fake.connectionStatus;
  return {
    app,
    gladys,
    clock,
    store,
    sources,
    world: w,
    logger,
    wait,
    begin,
    create,
    remove,
    statesOf,
    valuesOf,
    status,
  };
}
