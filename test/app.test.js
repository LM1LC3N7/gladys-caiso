// -----------------------------------------------------------------------------
// The app on the SDK's fake Gladys, scripted sources and a virtual clock that
// moves at every read: what is read and when (the pace kept across restarts,
// never sooner, never a round skipped), what is published (each reading once,
// only while fresh, never a text or an unknown as 0), the texts and the
// status (never "fresh" once stale), the pauses, a source never blocking the
// other, getConfig retried, forms saved in a burst, /data slow, frozen,
// unreadable or unwritable.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import {
  GRID,
  HOUR,
  HUB,
  MINUTE,
  NOW,
  SECOND,
  answer,
  oasisError,
  outlookBody,
  setup,
  slotOf,
} from './helpers/app.js';
import { testClock } from './helpers/clock.js';

const statusText = (ctx) => ctx.status().message?.fr ?? '';
const gaps = (list) => list.slice(1).map((r, i) => r.mono - list[i].mono);

test('no device: nothing is read, the status says so; an idle hour wakes nothing up', async () => {
  const ctx = await setup({ devices: [] });
  let cycles = 0;
  const cycle = ctx.app.cycle.bind(ctx.app);
  ctx.app.cycle = (...args) => {
    cycles += 1;
    return cycle(...args);
  };
  await ctx.begin();
  assert.equal(ctx.sources.requests.length, 0);
  assert.equal(ctx.status().connected, false);
  assert.match(statusText(ctx), /^Aucun appareil créé : rien n’est lu/);
  // The Discovery list is there anyway (fixed, no read needed).
  assert.deepEqual(
    ctx.gladys.fake.discoveredDevices.map((d) => d.external_id),
    ['ext:caiso:grid:caiso', 'ext:caiso:hub:np15', 'ext:caiso:hub:sp15', 'ext:caiso:hub:zp26'],
  );
  await ctx.wait(HOUR);
  assert.equal(cycles, 0);
  assert.equal(ctx.sources.requests.length, 0);
  assert.ok(ctx.clock.pending <= 1, `${ctx.clock.pending} timers pending`);
});

test('the grid: the Outlook read at once, every value once, in the units of the core; OASIS never asked', async () => {
  const ctx = await setup({ devices: 'grid' });
  await ctx.begin();
  assert.equal(ctx.sources.count('outlook'), 1);
  assert.equal(ctx.sources.count('oasis'), 0);
  const headers = ctx.sources.requests[0].headers;
  assert.match(headers['User-Agent'], /^gladys-caiso\/0\.1\.0 \(\+https:\/\/github\.com\//);
  assert.equal(headers.Accept, 'application/json, text/plain;q=0.9');
  assert.deepEqual(ctx.valuesOf(GRID('demand')), [24000]);
  assert.deepEqual(ctx.valuesOf(GRID('net_demand')), [20500]);
  assert.deepEqual(ctx.valuesOf(GRID('renewables')), [20]);
  assert.deepEqual(ctx.valuesOf(GRID('carbon_intensity')), [275]);
  assert.deepEqual(ctx.valuesOf(GRID('co2')), [6600]);
  assert.deepEqual(ctx.valuesOf(GRID('alert_level')), [0]);
  assert.deepEqual(ctx.valuesOf(GRID('conditions')), ['Normal']);
  assert.deepEqual(ctx.valuesOf(GRID('status')), ['Relevé du 29/10 22:55 PDT']);
  for (const state of ctx.gladys.fake.states) assert.equal(state.created_at, undefined);
  assert.equal(ctx.status().connected, true);
  // Only the note on where the alert level comes from.
  assert.match(statusText(ctx), /^Niveau d'alerte : champ gridstatus, parfois en retard/);
  assert.match(ctx.status().message.en, /caiso\.com\/emergency-notifications$/);
  // The next read sends back the ETag; a new slot is a new reading.
  await ctx.wait(5 * MINUTE);
  assert.equal(ctx.sources.count('outlook'), 2);
  assert.equal(
    ctx.sources.of('outlook')[1].headers['If-None-Match'],
    `"${slotOf(NOW - 3 * MINUTE)}"`,
  );
  assert.equal(ctx.valuesOf(GRID('demand')).length, 2);
  // The same text is never sent twice.
  assert.equal(ctx.valuesOf(GRID('conditions')).length, 1);
});

test('the hubs: one OASIS query for the three, the price of the current interval, "wholesale" said', async () => {
  const ctx = await setup({ devices: 'hubs' });
  ctx.world.state.price = (hub, start) =>
    ({ np15: 40, sp15: -12.5, zp26: 0 })[hub] + (start - NOW) / 1e6;
  await ctx.begin();
  assert.equal(ctx.sources.count('oasis'), 1);
  assert.equal(ctx.sources.count('outlook'), 0);
  const url = new URL(ctx.sources.of('oasis')[0].url);
  assert.equal(url.searchParams.get('node'), 'TH_NP15_GEN-APND,TH_SP15_GEN-APND,TH_ZP26_GEN-APND');
  assert.equal(url.searchParams.get('startdatetime'), '20261030T05:30-0000');
  const at = slotOf(NOW);
  assert.deepEqual(ctx.valuesOf(HUB('np15')), [40 + (at - NOW) / 1e6]);
  assert.deepEqual(ctx.valuesOf(HUB('sp15')), [-12.5 + (at - NOW) / 1e6]);
  assert.equal(ctx.valuesOf(HUB('zp26')).length, 1);
  assert.deepEqual(ctx.valuesOf(HUB('np15', 'status')), [
    'Prix de gros, pas votre tarif ; intervalle 29/10 23:00-23:05 PDT',
  ]);
  assert.equal(ctx.status().connected, true);
  assert.match(statusText(ctx), /prix de gros du marché, pas votre tarif/);
  assert.match(ctx.status().message.en, /wholesale market prices, not your retail rate/);
});

test('a price interval that starts between two reads is published from memory, without a request', async () => {
  const ctx = await setup({ devices: 'hubs', config: { interval_minutes: 15 } });
  ctx.world.state.price = (hub, start) => (start - slotOf(NOW)) / MINUTE + 10;
  await ctx.begin();
  assert.deepEqual(ctx.valuesOf(HUB('np15')), [10]);
  // 06:05: the next interval (already in the answer) is the current one.
  await ctx.wait(4 * MINUTE + 2 * SECOND);
  assert.deepEqual(ctx.valuesOf(HUB('np15')), [10, 15]);
  assert.equal(ctx.sources.count('oasis'), 1);
  assert.match(ctx.valuesOf(HUB('np15', 'status')).at(-1), /intervalle 29\/10 23:05-23:10/);
  // 06:10: nothing newer in memory; the 06:05 interval stays current until
  // 10 minutes after its end, then the texts say stale (the read at 06:16 comes first).
  await ctx.wait(11 * MINUTE);
  assert.equal(ctx.sources.count('oasis'), 2);
  assert.deepEqual(ctx.valuesOf(HUB('np15')).slice(0, 2), [10, 15]);
});

test('a frozen Outlook: published once, then stale at 20 minutes without a read, said everywhere', async () => {
  const ctx = await setup({ devices: 'grid', config: { interval_minutes: 60 } });
  ctx.world.state.frozenSlot = slotOf(NOW - 3 * MINUTE);
  await ctx.begin();
  assert.deepEqual(ctx.valuesOf(GRID('demand')), [24000]);
  assert.equal(ctx.status().connected, true);
  await ctx.wait(15 * MINUTE);
  assert.equal(ctx.sources.count('outlook'), 1, 'no read: the interval is 60 min');
  assert.match(
    ctx.valuesOf(GRID('status')).at(-1),
    /^Périmé, rien publié : dernier relevé du 29\/10 22:55/,
  );
  assert.equal(ctx.status().connected, false);
  assert.match(statusText(ctx), /Today's Outlook : données en retard ou figées, rien publié/);
  // Read again at 60 min: the same slot, nothing published again, still stale.
  await ctx.wait(50 * MINUTE);
  assert.equal(ctx.sources.count('outlook'), 2);
  assert.deepEqual(ctx.valuesOf(GRID('demand')), [24000]);
  assert.equal(ctx.status().connected, false);
  for (const fid of [GRID('demand'), GRID('alert_level'), GRID('renewables')]) {
    assert.ok(!ctx.valuesOf(fid).includes(0) || fid === GRID('alert_level'));
  }
});

test('a file late by more than 20 minutes is never published; a slot in the future neither', async () => {
  for (const lag of [21 * MINUTE, -15 * MINUTE]) {
    const ctx = await setup({ devices: 'grid' });
    ctx.world.state.lag = lag;
    await ctx.begin();
    assert.deepEqual(ctx.valuesOf(GRID('demand')), [], `lag ${lag}`);
    assert.deepEqual(ctx.valuesOf(GRID('alert_level')), []);
    assert.equal(ctx.status().connected, false);
  }
});

test('a demand whose own time is stale is left out while the rest is published, and said', async () => {
  const ctx = await setup({ devices: 'grid' });
  const slot = slotOf(NOW - 3 * MINUTE);
  ctx.world.state.outlook = {
    set: { CurrentSystemDemandTS: new Date(slot).toISOString() && '20261029222000' },
  };
  await ctx.begin();
  assert.deepEqual(ctx.valuesOf(GRID('demand')), []);
  assert.deepEqual(ctx.valuesOf(GRID('renewables')), [20]);
  assert.match(ctx.valuesOf(GRID('status')).at(-1), /non publié : demande$/);
  assert.match(statusText(ctx), /des valeurs illisibles, non publiées/);
});

test('unreadable values and unknown conditions: never published, never 0; the words of the ISO shown', async () => {
  const ctx = await setup({ devices: 'grid', config: { language: 'en' } });
  ctx.world.state.outlook = { set: { CurrentSystemDemand: null, gridstatus: ['Grid Warning'] } };
  await ctx.begin();
  assert.deepEqual(ctx.valuesOf(GRID('demand')), []);
  assert.deepEqual(ctx.valuesOf(GRID('alert_level')), []);
  assert.deepEqual(ctx.valuesOf(GRID('conditions')), ['Grid Warning']);
  assert.equal(
    ctx.valuesOf(GRID('status')).at(-1),
    'Reading of 10/29 22:55 PDT; not published: demand; no alert level recognized',
  );
  assert.match(
    ctx.status().message.en,
    /grid conditions not recognized, left out of the alert level: "Grid Warning"/,
  );
  assert.equal(ctx.status().connected, true);
});

test('pace: never sooner than the interval; Discovery, saves, device updates, reconnections ask nothing', async () => {
  const ctx = await setup({ config: { interval_minutes: 10 } });
  await ctx.begin();
  assert.equal(ctx.sources.requests.length, 2);
  await ctx.wait(2 * MINUTE);
  await ctx.gladys.fake.scanRequest();
  await ctx.gladys.fake.configUpdated({ interval_minutes: 10 });
  await ctx.gladys.fake.deviceUpdated(structuredClone(ctx.gladys.devices[0]));
  await ctx.app.disconnected();
  await ctx.begin();
  await ctx.wait(SECOND);
  assert.equal(ctx.sources.requests.length, 2);
  await ctx.wait(8 * MINUTE - 2 * SECOND);
  assert.equal(ctx.sources.requests.length, 2);
  await ctx.wait(2 * SECOND);
  assert.equal(ctx.sources.requests.length, 4);
  await ctx.wait(40 * MINUTE);
  for (const key of ['outlook', 'oasis']) {
    const list = ctx.sources.of(key);
    assert.equal(list.length, 6, key);
    for (const gap of gaps(list))
      assert.ok(gap >= 10 * MINUTE && gap < 10 * MINUTE + SECOND, `${key} ${gap}`);
  }
  // One request at a time: the second source asked after the first answered.
  assert.ok(ctx.sources.of('oasis')[0].mono > ctx.sources.of('outlook')[0].mono);
});

test('timers that fire a little early never skip a round', async () => {
  const base = testClock({ start: NOW });
  const clock = {
    ...base,
    timers: {
      ...base.timers,
      setTimeout: (fn, ms, ...args) => base.timers.setTimeout(fn, ms > 3 ? ms - 3 : ms, ...args),
    },
  };
  const ctx = await setup({ clock });
  await ctx.begin();
  await ctx.wait(HOUR + SECOND);
  assert.equal(ctx.sources.count('outlook'), 13);
  assert.equal(ctx.sources.count('oasis'), 13);
  for (const gap of gaps(ctx.sources.of('outlook'))) {
    assert.ok(gap >= 5 * MINUTE && gap < 5 * MINUTE + SECOND, String(gap));
  }
});

test('a restart keeps the pace from /data and never publishes the same reading again', async () => {
  const store = createMemoryStore();
  const clock = testClock({ start: NOW });
  const first = await setup({ store, clock, devices: 'grid' });
  await first.begin();
  assert.equal(first.sources.count('outlook'), 1);
  await first.wait(2 * MINUTE);
  await first.app.stop();
  assert.ok(store.data.asked.outlook > 0);
  // The same clock goes on: a new process 2 minutes later.
  const second = await setup({ store, clock, devices: 'grid' });
  second.world.state.frozenSlot = slotOf(NOW - 3 * MINUTE);
  await second.begin();
  assert.equal(second.sources.count('outlook'), 0);
  assert.equal(second.status().connected, true);
  assert.match(
    statusText(second),
    /^Dernière lecture réussie avant le redémarrage ; prochaine lecture dans 3 min/,
  );
  await second.wait(3 * MINUTE - 2 * SECOND);
  assert.equal(second.sources.count('outlook'), 0);
  await second.wait(3 * SECOND);
  assert.equal(second.sources.count('outlook'), 1);
  // The same slot as before the restart: not published again.
  assert.deepEqual(second.valuesOf(GRID('demand')), []);
  // A date in the future in /data is brought back to now.
  store.data.asked.outlook = NOW + 10 * HOUR;
  const third = await setup({ store, clock, devices: 'grid' });
  await third.begin();
  assert.equal(third.sources.count('outlook'), 0);
  await third.wait(5 * MINUTE + SECOND);
  assert.equal(third.sources.count('outlook'), 1);
});

test('429: paused to its end (Retry-After honoured, 6 h at most), read right then; the other source goes on', async () => {
  const ctx = await setup();
  let refuse = 1;
  const live = ctx.world.oasis;
  ctx.world.oasis = (r, init) =>
    refuse-- > 0
      ? answer('<html>slow down</html>', { status: 429, headers: { 'retry-after': '600' } })
      : live(r, init);
  await ctx.begin();
  assert.equal(ctx.sources.count('oasis'), 1);
  assert.match(statusText(ctx), /prix OASIS : trop de requêtes \(HTTP 429\), pause de 10 min/);
  assert.equal(ctx.store.data.pauses.oasis.code, 'rate_limited');
  await ctx.wait(10 * MINUTE - 2 * SECOND);
  assert.equal(ctx.sources.count('oasis'), 1);
  assert.equal(ctx.sources.count('outlook'), 2, 'the Outlook keeps its pace');
  await ctx.wait(3 * SECOND);
  assert.equal(ctx.sources.count('oasis'), 2, 'read right at the end of the pause');
  assert.equal(ctx.valuesOf(HUB('np15')).length, 1);
  assert.equal(ctx.store.data.pauses.oasis, undefined);
  // Then at its own pace again.
  await ctx.wait(5 * MINUTE);
  assert.equal(ctx.sources.count('oasis'), 3);
});

test('pauses: 5 min doubled without Retry-After, 6 h at most, kept across a restart, never from a future date', async () => {
  const store = createMemoryStore();
  const clock = testClock({ start: NOW });
  const ctx = await setup({ store, clock, devices: 'hubs' });
  ctx.world.oasis = () => answer('busy', { status: 503 });
  await ctx.begin();
  assert.ok(Math.abs(store.data.pauses.oasis.until - NOW - 5 * MINUTE) < SECOND, 'first 5 min');
  await ctx.wait(5 * MINUTE + SECOND);
  assert.equal(ctx.sources.count('oasis'), 2);
  assert.ok(Math.abs(store.data.pauses.oasis.until - clock.now() - 10 * MINUTE) < 2 * SECOND);
  ctx.world.oasis = () => answer('x', { status: 429, headers: { 'retry-after': '99999999' } });
  await ctx.wait(10 * MINUTE + SECOND);
  assert.equal(ctx.sources.count('oasis'), 3);
  assert.ok(Math.abs(store.data.pauses.oasis.until - clock.now() - 6 * HOUR) < 3 * SECOND);
  await ctx.app.stop();
  // Restarted: the pause holds; a pause in /data beyond 6 h is brought back to 6 h.
  store.data.pauses.oasis.until = clock.now() + 100 * HOUR;
  const again = await setup({ store, clock, devices: 'hubs' });
  await again.begin();
  await again.wait(6 * HOUR - MINUTE);
  assert.equal(again.sources.count('oasis'), 0);
  await again.wait(2 * MINUTE);
  assert.equal(again.sources.count('oasis'), 1);
});

test('one source failing, hanging or paused never blocks the other', async () => {
  const ctx = await setup();
  ctx.world.outlook = () => 'hang';
  await ctx.app.connected(() => ctx.gladys.getConfig());
  await ctx.wait(25 * SECOND);
  await ctx.app.idle();
  assert.equal(ctx.sources.count('oasis'), 1);
  assert.equal(ctx.valuesOf(HUB('sp15')).length, 1);
  assert.match(statusText(ctx), /Today's Outlook : pas de réponse à temps/);
  assert.equal(ctx.status().connected, true);
  ctx.world.outlook = () => new Error('ECONNRESET');
  await ctx.wait(5 * MINUTE);
  assert.match(statusText(ctx), /Today's Outlook : injoignable/);
  assert.equal(ctx.sources.count('oasis'), 2);
});

test('both sources failing: never "connected"', async () => {
  const ctx = await setup();
  ctx.world.outlook = () => answer('no', { status: 404 });
  ctx.world.oasis = () => answer(Buffer.from('<html>maintenance</html>'), { status: 200 });
  await ctx.begin();
  assert.equal(ctx.status().connected, false);
  assert.match(statusText(ctx), /Today's Outlook : réponse HTTP 404/);
  assert.match(statusText(ctx), /prix OASIS : format inattendu, rien publié/);
  assert.equal(ctx.gladys.fake.states.filter((s) => s.state !== undefined).length, 0);
});

test('OASIS "no data" and error codes: nothing published, said; older prices age out on their own', async () => {
  const ctx = await setup({ devices: 'hubs' });
  await ctx.begin();
  assert.equal(ctx.valuesOf(HUB('np15')).length, 1);
  ctx.world.oasis = () => answer(oasisError(1000), { date: ctx.clock.now() });
  await ctx.wait(5 * MINUTE);
  assert.equal(ctx.sources.count('oasis'), 2);
  // The interval 06:05 was in the first answer: published at 06:05, from memory.
  assert.equal(ctx.valuesOf(HUB('np15')).length, 2);
  await ctx.wait(20 * MINUTE);
  assert.equal(ctx.valuesOf(HUB('np15')).length, 2);
  assert.match(
    ctx.valuesOf(HUB('np15', 'status')).at(-1),
    /^Périmé, rien publié : dernier intervalle/,
  );
  assert.match(statusText(ctx), /prix OASIS : pas de prix pour l'intervalle en cours, rien publié/);
  assert.equal(ctx.status().connected, false);
  ctx.world.oasis = () => answer(oasisError(1015, 'Busy'), { date: ctx.clock.now() });
  await ctx.wait(5 * MINUTE);
  assert.match(statusText(ctx), /prix OASIS : erreur 1015 d'OASIS, rien publié/);
});

test('304: the reading keeps its date (never republished as new) and goes stale on time', async () => {
  const ctx = await setup({ devices: 'grid' });
  await ctx.begin();
  ctx.world.outlook = () => answer(null, { status: 304, date: ctx.clock.now() });
  await ctx.wait(5 * MINUTE);
  assert.equal(ctx.sources.count('outlook'), 2);
  assert.equal(ctx.valuesOf(GRID('demand')).length, 1);
  assert.equal(ctx.status().connected, true);
  await ctx.wait(10 * MINUTE);
  assert.equal(ctx.status().connected, false);
  assert.match(ctx.valuesOf(GRID('status')).at(-1), /^Périmé/);
});

test('getConfig failing in "connected": tried again without end (5 s, 10 s, ...), said, then the reads start', async () => {
  const ctx = await setup({ devices: 'grid' });
  let fails = 3;
  const getConfig = () =>
    fails-- > 0 ? Promise.reject(new Error('boom')) : ctx.gladys.getConfig();
  await ctx.app.connected(getConfig);
  await ctx.wait(0);
  assert.equal(ctx.status().connected, false);
  assert.match(statusText(ctx), /^Configuration illisible depuis Gladys : nouvel essai dans 5 s$/);
  assert.equal(ctx.sources.requests.length, 0);
  await ctx.wait(5 * SECOND);
  assert.match(statusText(ctx), /nouvel essai dans 10 s/);
  await ctx.wait(10 * SECOND);
  assert.match(statusText(ctx), /nouvel essai dans 20 s/);
  await ctx.wait(21 * SECOND);
  await ctx.app.idle();
  assert.equal(ctx.sources.count('outlook'), 1);
  assert.equal(ctx.status().connected, true);
});

test('forms saved in a burst apply one after the other: the last one wins (interval, threshold, language)', async () => {
  const ctx = await setup({ devices: 'grid' });
  await ctx.begin();
  // A slow Gladys: every Discovery publication takes 300 ms.
  const publish = ctx.gladys.publishDiscoveredDevices.bind(ctx.gladys);
  ctx.gladys.publishDiscoveredDevices = (list) =>
    new Promise((resolve) => ctx.clock.timers.setTimeout(resolve, 300 * 1)).then(() =>
      publish(list),
    );
  const forms = [
    { interval_minutes: 30, language: 'en' },
    { interval_minutes: 60, low_price_threshold: 5 },
    { interval_minutes: 10, language: 'en', low_price_threshold: -3 },
  ];
  for (const form of forms) ctx.gladys.fake.configUpdated(form);
  await ctx.wait(2 * SECOND);
  await ctx.app.idle();
  assert.equal(ctx.app.config.intervalMinutes, 10);
  assert.equal(ctx.app.config.threshold, -3);
  assert.equal(ctx.app.config.language, 'en');
  assert.equal(ctx.gladys.fake.discoveredDevices[0].name, 'California grid (CAISO)');
  assert.equal(ctx.sources.count('outlook'), 1, 'saving the form reads nothing');
  await ctx.wait(10 * MINUTE);
  assert.equal(ctx.sources.count('outlook'), 2, 'the last interval rules');
});

test('a device created: its source read when the pace allows, the readings in memory sent at once', async () => {
  const ctx = await setup({ devices: 'grid' });
  await ctx.begin();
  await ctx.wait(MINUTE);
  await ctx.create('hub', 'np15');
  await ctx.app.idle();
  await ctx.wait(0);
  assert.equal(ctx.sources.count('oasis'), 1, 'never asked: read now');
  assert.equal(ctx.valuesOf(HUB('np15')).length, 1);
  await ctx.wait(MINUTE);
  await ctx.create('hub', 'sp15');
  await ctx.app.idle();
  assert.equal(ctx.sources.count('oasis'), 1, 'asked a minute ago: not again');
  assert.equal(ctx.valuesOf(HUB('sp15')).length, 1, 'from memory, at once');
  // Deleted: its source is no longer read.
  await ctx.remove('grid', 'caiso');
  const before = ctx.sources.count('outlook');
  await ctx.wait(30 * MINUTE);
  assert.equal(ctx.sources.count('outlook'), before);
  assert.ok(ctx.sources.count('oasis') >= 6);
});

test('stale data is never sent to a device created afterwards, nor at a reconnection', async () => {
  const ctx = await setup({ devices: 'grid', config: { interval_minutes: 60 } });
  ctx.world.state.frozenSlot = slotOf(NOW - 3 * MINUTE);
  await ctx.begin();
  await ctx.wait(30 * MINUTE);
  const fid = GRID('demand');
  await ctx.remove('grid', 'caiso');
  await ctx.create('grid', 'caiso');
  await ctx.app.idle();
  assert.deepEqual(ctx.valuesOf(fid), [24000]);
  await ctx.app.disconnected();
  await ctx.begin();
  assert.deepEqual(ctx.valuesOf(fid), [24000]);
  assert.match(ctx.valuesOf(GRID('status')).at(-1), /^Périmé/);
});

test('trigger grid_alert: the first level is a reference, one event per change, none after a restart, unknown is not a change', async () => {
  const store = createMemoryStore();
  const clock = testClock({ start: NOW });
  const ctx = await setup({ store, clock, devices: 'grid' });
  const say = (list) => {
    ctx.world.state.outlook = { set: { gridstatus: list } };
  };
  await ctx.begin();
  assert.equal(ctx.gladys.fake.sceneEvents.length, 0);
  say(['Flex Alert']);
  await ctx.wait(5 * MINUTE);
  assert.deepEqual(ctx.gladys.fake.sceneEvents, [
    {
      key: 'grid_alert',
      data: { level: 'flex_alert', previous_level: 'normal', conditions: 'Flex Alert' },
    },
  ]);
  await ctx.wait(5 * MINUTE);
  assert.equal(ctx.gladys.fake.sceneEvents.length, 1, 'the same level: nothing');
  say(['Grid Warning']);
  await ctx.wait(5 * MINUTE);
  say(['Flex Alert']);
  await ctx.wait(5 * MINUTE);
  assert.equal(ctx.gladys.fake.sceneEvents.length, 1, 'unknown in between: not a change');
  await ctx.app.stop();
  const again = await setup({ store, clock, devices: 'grid' });
  again.world.state.outlook = { set: { gridstatus: ['Flex Alert'] } };
  await again.begin();
  await again.wait(5 * MINUTE);
  assert.equal(again.gladys.fake.sceneEvents.length, 0, 'after a restart: the same level, nothing');
  again.world.state.outlook = {
    set: { gridstatus: ['Restricted Maintenance Operations', 'EEA 1'] },
  };
  await again.wait(5 * MINUTE);
  assert.deepEqual(again.gladys.fake.sceneEvents.at(-1).data, {
    level: 'eea1',
    previous_level: 'flex_alert',
    conditions: 'Restricted Maintenance Operations, EEA 1',
  });
});

test('trigger grid_alert: a new wording next to Transmission Emergency or "Normal" is unknown, never "back to normal"', async () => {
  // Review r3: during an EEA 3, CAISO writes "EEA-3" next to Transmission
  // Emergency. Before, the level fell to 0 and "eea3 -> normal" fired.
  const ctx = await setup({ devices: 'grid', config: { language: 'en' } });
  const say = (list) => {
    ctx.world.state.outlook = { set: { gridstatus: list } };
  };
  await ctx.begin();
  say(['EEA 3', 'EEA 2', 'EEA 1', 'EEA Watch', 'Transmission Emergency']);
  await ctx.wait(5 * MINUTE);
  assert.deepEqual(ctx.valuesOf(GRID('alert_level')), [0, 6]);
  const events = () =>
    ctx.gladys.fake.sceneEvents.map((e) => e.data.previous_level + '>' + e.data.level);
  assert.deepEqual(events(), ['normal>eea3']);
  for (const list of [
    ['EEA-3', 'EEA-2', 'Transmission Emergency'],
    ['Transmission Emergency', 'EEA 3 - cancelled'],
    ['Normal', 'EEA-3'],
  ]) {
    say(list);
    await ctx.wait(5 * MINUTE);
    assert.deepEqual(ctx.valuesOf(GRID('alert_level')), [0, 6], JSON.stringify(list));
    assert.deepEqual(events(), ['normal>eea3'], JSON.stringify(list));
    assert.equal(ctx.valuesOf(GRID('conditions')).at(-1), list.join(', '));
    assert.match(ctx.valuesOf(GRID('status')).at(-1), /; no alert level recognized$/);
  }
  assert.match(
    ctx.status().message.en,
    /grid conditions not recognized, left out of the alert level: "EEA-3"/,
  );
  // Transmission Emergency truly alone: 0, and then the event.
  say(['Transmission Emergency']);
  await ctx.wait(5 * MINUTE);
  assert.deepEqual(ctx.valuesOf(GRID('alert_level')), [0, 6, 0]);
  assert.deepEqual(events(), ['normal>eea3', 'eea3>normal']);
});

test('trigger grid_alert: a stale reading never fires; a refused event is sent at the next reading', async () => {
  const ctx = await setup({ devices: 'grid' });
  await ctx.begin();
  ctx.world.state.outlook = { set: { gridstatus: ['EEA Watch'] } };
  ctx.world.state.lag = 25 * MINUTE;
  await ctx.wait(5 * MINUTE);
  assert.equal(ctx.gladys.fake.sceneEvents.length, 0);
  ctx.world.state.lag = 0;
  const publish = ctx.gladys.publishSceneEvent.bind(ctx.gladys);
  let refuse = 1;
  ctx.gladys.publishSceneEvent = (...args) =>
    refuse-- > 0 ? Promise.reject(new Error('down')) : publish(...args);
  await ctx.wait(5 * MINUTE);
  assert.equal(ctx.gladys.fake.sceneEvents.length, 0);
  await ctx.wait(5 * MINUTE);
  assert.deepEqual(
    ctx.gladys.fake.sceneEvents.map((e) => e.data.level),
    ['eea_watch'],
  );
});

test('trigger low_price: a reference first, "started" below the threshold, "ended" back at it; a new threshold is a reference', async () => {
  const ctx = await setup({ devices: 'hubs' });
  // The price of an interval is the one OASIS gave when it first answered for it.
  let price = 20;
  const prices = new Map();
  ctx.world.state.price = (hub, start) => {
    if (hub !== 'np15') return 30;
    if (!prices.has(start)) prices.set(start, price);
    return prices.get(start);
  };
  await ctx.begin();
  assert.equal(ctx.gladys.fake.sceneEvents.length, 0);
  price = -4.5;
  // The intervals already answered keep their price; the first new one is below.
  await ctx.wait(10 * MINUTE);
  assert.deepEqual(ctx.gladys.fake.sceneEvents, [
    { key: 'low_price', data: { hub: 'np15', phase: 'started', price: -4.5, threshold: 0 } },
  ]);
  await ctx.wait(10 * MINUTE);
  assert.equal(ctx.gladys.fake.sceneEvents.length, 1, 'still below: nothing');
  price = 0;
  await ctx.wait(10 * MINUTE);
  assert.deepEqual(ctx.gladys.fake.sceneEvents.at(-1).data, {
    hub: 'np15',
    phase: 'ended',
    price: 0,
    threshold: 0,
  });
  // A new threshold: the next interval is a reference, never an event.
  await ctx.gladys.fake.configUpdated({ low_price_threshold: 25 });
  await ctx.wait(10 * MINUTE);
  assert.equal(ctx.gladys.fake.sceneEvents.length, 2);
  assert.equal(ctx.store.data.triggers.prices.np15.threshold, 25);
  assert.equal(ctx.store.data.triggers.prices.np15.below, true);
  price = 26;
  await ctx.wait(10 * MINUTE);
  assert.deepEqual(ctx.gladys.fake.sceneEvents.at(-1).data, {
    hub: 'np15',
    phase: 'ended',
    price: 26,
    threshold: 25,
  });
  // The other hubs (30, never below 0 nor 25) never fired.
  assert.ok(ctx.gladys.fake.sceneEvents.every((e) => e.data.hub === 'np15'));
});

test('/data frozen: the reads go on (each save awaited 5 s at most) and stop() ends within its bound', async () => {
  const store = createMemoryStore();
  store.hold = new Promise(() => {});
  const ctx = await setup({ store, devices: 'grid' });
  await ctx.app.connected(() => ctx.gladys.getConfig());
  await ctx.wait(6 * SECOND);
  assert.equal(ctx.sources.count('outlook'), 1);
  await ctx.wait(10 * SECOND);
  assert.equal(ctx.valuesOf(GRID('demand')).length, 1);
  await ctx.wait(5 * MINUTE + 6 * SECOND);
  assert.equal(ctx.sources.count('outlook'), 2);
  let stopped = false;
  ctx.app.stop().then(() => {
    stopped = true;
  });
  await ctx.wait(9 * SECOND);
  assert.equal(stopped, true);
});

test('/data frozen at the start: the start goes on, the file is unreadable (never empty), said', async () => {
  const store = createMemoryStore({ asked: { outlook: NOW } });
  store.loadHold = new Promise(() => {});
  const ctx = await setup({ store, devices: 'grid' });
  const started = ctx.app.connected(() => ctx.gladys.getConfig());
  await ctx.wait(6 * SECOND);
  await started;
  await ctx.app.idle();
  assert.equal(ctx.app.dataUnreadable, true);
  assert.equal(store.asides, 1);
  assert.match(statusText(ctx), /\/data illisible : fichier mis de côté/);
});

test('/data unreadable whose setting aside never ends: the start goes on (bounded), nothing written', async () => {
  const store = createMemoryStore({ asked: { outlook: NOW } });
  store.broken = true;
  store.setAside = () => new Promise(() => {});
  const ctx = await setup({ store, devices: 'grid' });
  const started = ctx.app.connected(() => ctx.gladys.getConfig());
  await ctx.wait(6 * SECOND);
  await started;
  await ctx.wait(SECOND);
  await ctx.app.idle();
  assert.equal(ctx.sources.count('outlook'), 1);
  assert.equal(ctx.valuesOf(GRID('demand')).length, 1);
  assert.equal(store.saves, 0);
  assert.match(
    statusText(ctx),
    /\/data illisible et impossible à mettre de côté : rien n’y est écrit/,
  );
  assert.doesNotMatch(statusText(ctx), /fichier mis de côté/);
});

test('/data unreadable: set aside, never overwritten; /data that cannot be written: said', async () => {
  const store = createMemoryStore({ asked: { outlook: NOW - HOUR } });
  store.broken = true;
  store.failAside = true;
  const ctx = await setup({ store, devices: 'grid' });
  await ctx.begin();
  assert.equal(store.saves, 0, 'never written over');
  assert.match(statusText(ctx), /\/data illisible et impossible à mettre de côté/);
  assert.doesNotMatch(statusText(ctx), /fichier mis de côté/);
  const other = createMemoryStore();
  other.failSave = true;
  const ctx2 = await setup({ store: other, devices: 'grid' });
  await ctx2.begin();
  assert.equal(ctx2.valuesOf(GRID('demand')).length, 1);
  assert.match(statusText(ctx2), /\/data non inscriptible/);
});

test('a disconnection aborts the request in flight: nothing published after it; the pace is kept', async () => {
  const ctx = await setup({ devices: 'grid' });
  ctx.world.outlook = () => 'hang';
  await ctx.app.connected(() => ctx.gladys.getConfig());
  await ctx.wait(SECOND);
  assert.equal(ctx.sources.count('outlook'), 1);
  await ctx.app.disconnected();
  await ctx.wait(SECOND);
  assert.equal(ctx.gladys.fake.states.length, 0);
  ctx.world.outlook = () => answer('{}', { status: 500 });
  await ctx.begin();
  assert.equal(ctx.sources.count('outlook'), 1, 'asked a second ago: not again');
  assert.equal(ctx.gladys.fake.states.length, 0);
});

test('a slow Gladys: a reading is never published twice by a start during its publication', async () => {
  const ctx = await setup({ devices: 'grid' });
  const publish = ctx.gladys.publishStates.bind(ctx.gladys);
  ctx.gladys.publishStates = (list) =>
    new Promise((resolve) => ctx.clock.timers.setTimeout(resolve, 300)).then(() => publish(list));
  await ctx.app.connected(() => ctx.gladys.getConfig());
  await ctx.wait(100);
  ctx.gladys.fake.configUpdated({ language: 'fr' });
  await ctx.app.disconnected();
  await ctx.app.connected(() => ctx.gladys.getConfig());
  await ctx.wait(2 * SECOND);
  await ctx.app.idle();
  assert.deepEqual(ctx.valuesOf(GRID('demand')), [24000]);
});

test('without a usable Date header, our clock is the reference', async () => {
  const ctx = await setup({ devices: 'grid' });
  const slot = slotOf(NOW - 3 * MINUTE);
  ctx.world.outlook = () =>
    answer(outlookBody({ slot }), { lastModified: slot + 3 * MINUTE, type: 'text/plain' });
  await ctx.begin();
  assert.deepEqual(ctx.valuesOf(GRID('demand')), [24000]);
  // Nor a Last-Modified: an ordinary time still reads (the repeated hour would not).
  const other = await setup({ devices: 'grid' });
  other.world.outlook = () => answer(outlookBody({ slot }), { type: 'text/plain' });
  await other.begin();
  assert.deepEqual(other.valuesOf(GRID('demand')), [24000]);
});
