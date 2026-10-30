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
