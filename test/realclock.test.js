// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout, sped
// up 20 times as the project rules ask: the 5 minutes of the interval are
// 15 s) and a real local HTTP server playing both sources: each source is
// asked at 0 and at the interval, never sooner, one request at a time, with a
// bounded number of timers. The app is stopped in a `finally`: a failure
// never leaves the test process alive.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CaisoApp } from '../src/app.js';
import { MINUTE } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { measurePeriod, realClock } from './helpers/clock.js';
import { discovered, oasisZip, outlookBody, quiet, slotOf } from './helpers/app.js';

const SPEED = 20;
const INTERVAL = 5 * MINUTE;

test('real clock x20: each source read at 0 and at the interval, never sooner; timers bounded', async () => {
  const clock = realClock({ speed: SPEED });
  // The decisions of the app (when it asks a source) and what the server sees.
  const asked = { outlook: { clock, calls: [] }, oasis: { clock, calls: [] } };
  const seen = { outlook: [], oasis: [] };
  let inFlight = 0;
  let overlap = false;
  const server = createServer((req, res) => {
    const now = clock.now();
    inFlight += 1;
    if (inFlight > 1) overlap = true;
    res.on('finish', () => {
      inFlight -= 1;
    });
    if (req.url.startsWith('/stats.txt')) {
      seen.outlook.push(clock.monotonic());
      const slot = slotOf(now - 3 * MINUTE);
      res.writeHead(200, {
        'content-type': 'text/plain',
        'last-modified': new Date(Math.min(slot + 3 * MINUTE, now)).toUTCString(),
      });
      res.end(outlookBody({ slot }));
      return;
    }
    seen.oasis.push(clock.monotonic());
    res.writeHead(200, { 'content-type': 'application/x-zip-compressed' });
    res.end(oasisZip({ from: slotOf(now) - 30 * MINUTE, to: slotOf(now) + 10 * MINUTE }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const gladys = createFakeGladys({
    selector: 'caiso',
    config: { language: 'en', interval_minutes: 5 },
    devices: discovered('en'),
  });
  await gladys.connect();
  const app = new CaisoApp({
    gladys,
    logger: quiet(),
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    urls: { outlook: `${base}/stats.txt`, oasis: `${base}/oasis` },
  });
  const readSource = app.readSource.bind(app);
  app.readSource = (source, gen, mono) => {
    asked[source].calls.push({ at: mono });
    return readSource(source, gen, mono);
  };
  const started = clock.monotonic();
  try {
    await app.connected(() => gladys.getConfig());
    for (const key of ['outlook', 'oasis']) {
      const gaps = await measurePeriod(asked[key], { count: 2, period: INTERVAL });
      assert.ok(asked[key].calls[0].at - started < MINUTE, `${key}: the first read at once`);
      for (const gap of gaps) assert.ok(gap >= INTERVAL, `${key}: never sooner: ${gaps}`);
      // Seen by the server too (the request leaves just after the decision).
      for (let i = 0; i < 400 && seen[key].length < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(seen[key].length, 2, key);
      assert.ok(seen[key][1] - seen[key][0] >= 0.9 * INTERVAL, `${key}: ${seen[key]}`);
    }
    assert.equal(overlap, false, 'one request at a time');
    assert.equal(gladys.fake.connectionStatus.connected, true);
    assert.ok(gladys.fake.lastState('ext:caiso:grid:caiso:demand') === 24000);
    assert.ok(gladys.fake.lastState('ext:caiso:hub:np15:price') === 50);
  } finally {
    await app.stop();
    clock.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  assert.ok(clock.timersSet <= 60, `${clock.timersSet} timers`);
});
