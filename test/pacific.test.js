// -----------------------------------------------------------------------------
// Pacific local times -> UTC, exactly, around the changes of time of 2026
// (8 March: 02:00 -> 03:00; 1 November: 02:00 -> 01:00), the strict parsing
// of the three time formats of the ISO, and the texts shown.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidates,
  oasisTime,
  pacificClock,
  pacificText,
  parseGmt,
  parseSlot,
  parseStamp,
  resolveLocal,
  toLocal,
} from '../src/pacific.js';

const MIN = 60_000;
const H = 60 * MIN;
const iso = (list) => list.map((t) => new Date(t).toISOString());

test('an ordinary local time has one instant: PDT in October, PST in December', () => {
  assert.deepEqual(iso(candidates(Date.UTC(2026, 9, 29, 22, 55))), ['2026-10-30T05:55:00.000Z']);
  assert.deepEqual(iso(candidates(Date.UTC(2026, 11, 24, 23, 0))), ['2026-12-25T07:00:00.000Z']);
  // Midnight, both sides of the date line of UTC.
  assert.deepEqual(iso(candidates(Date.UTC(2026, 9, 30, 0, 0))), ['2026-10-30T07:00:00.000Z']);
  assert.deepEqual(iso(candidates(Date.UTC(2026, 11, 31, 23, 59))), ['2027-01-01T07:59:00.000Z']);
});

test('the hour repeated on 1 November has two instants; the hour skipped on 8 March none', () => {
  assert.deepEqual(iso(candidates(Date.UTC(2026, 10, 1, 1, 30))), [
    '2026-11-01T08:30:00.000Z',
    '2026-11-01T09:30:00.000Z',
  ]);
  assert.deepEqual(candidates(Date.UTC(2026, 2, 8, 2, 30)), []);
  // Right around the edges.
  assert.deepEqual(iso(candidates(Date.UTC(2026, 10, 1, 0, 59))), ['2026-11-01T07:59:00.000Z']);
  assert.deepEqual(iso(candidates(Date.UTC(2026, 10, 1, 2, 0))), ['2026-11-01T10:00:00.000Z']);
  assert.deepEqual(iso(candidates(Date.UTC(2026, 2, 8, 1, 59))), ['2026-03-08T09:59:00.000Z']);
  assert.deepEqual(iso(candidates(Date.UTC(2026, 2, 8, 3, 0))), ['2026-03-08T10:00:00.000Z']);
});

test('the repeated hour: the anchor (Last-Modified) picks the instant; without it, unreadable', () => {
  const naive = Date.UTC(2026, 10, 1, 1, 55);
  // Written at 01:58 PDT (08:58Z): the first 01:55.
  assert.equal(resolveLocal(naive, Date.UTC(2026, 10, 1, 8, 58)), Date.UTC(2026, 10, 1, 8, 55));
  // Written at 01:58 PST (09:58Z): the second 01:55.
  assert.equal(resolveLocal(naive, Date.UTC(2026, 10, 1, 9, 58)), Date.UTC(2026, 10, 1, 9, 55));
  // A file frozen since the first 01:55, read an hour later: still the first one.
  assert.equal(resolveLocal(naive, Date.UTC(2026, 10, 1, 8, 58)), Date.UTC(2026, 10, 1, 8, 55));
  assert.equal(resolveLocal(naive, NaN), undefined);
  assert.equal(resolveLocal(naive, undefined), undefined);
  // An ordinary time without anchor: its only instant.
  assert.equal(resolveLocal(Date.UTC(2026, 9, 29, 22, 55), NaN), Date.UTC(2026, 9, 30, 5, 55));
  // A slot after its anchor (beyond 5 minutes): unreadable, never a guess.
  assert.equal(
    resolveLocal(Date.UTC(2026, 9, 29, 22, 55), Date.UTC(2026, 9, 30, 5, 49)),
    undefined,
  );
  assert.equal(
    resolveLocal(Date.UTC(2026, 9, 29, 22, 55), Date.UTC(2026, 9, 30, 5, 50)),
    Date.UTC(2026, 9, 30, 5, 55),
  );
  // The skipped hour, with or without anchor.
  assert.equal(resolveLocal(Date.UTC(2026, 2, 8, 2, 30), Date.UTC(2026, 2, 8, 10)), undefined);
  assert.equal(resolveLocal(NaN, 0), undefined);
});

test('the three time formats: strict, no 30 February, no 24:00', () => {
  assert.equal(parseSlot('10/29/2026 22:55'), Date.UTC(2026, 9, 29, 22, 55));
  for (const bad of [
    '02/30/2026 10:00',
    '13/01/2026 10:00',
    '10/29/2026 24:00',
    '10/29/2026 22:60',
    '10/29/2026 22:55:00',
    '2026-10-29 22:55',
    ' 10/29/2026 22:55',
    '',
    null,
    20261029,
  ]) {
    assert.equal(parseSlot(bad), undefined, String(bad));
  }
  assert.equal(parseStamp('20261029225456'), Date.UTC(2026, 9, 29, 22, 54, 56));
  for (const bad of ['20260230120000', '2026102922545', '202610292254560', '20261029225460', 12]) {
    assert.equal(parseStamp(bad), undefined, String(bad));
  }
  assert.equal(parseGmt('2026-10-30T05:25:00-00:00'), Date.UTC(2026, 9, 30, 5, 25));
  for (const bad of [
    '2026-10-30T05:25:00Z',
    '2026-10-30T05:25:00-07:00',
    '2026-10-30 05:25:00-00:00',
    '2026-02-30T05:25:00-00:00',
    undefined,
  ]) {
    assert.equal(parseGmt(bad), undefined, String(bad));
  }
});

test('texts: Pacific time in the language of the form; the OASIS query format', () => {
  const at = Date.UTC(2026, 9, 30, 5, 55);
  assert.equal(pacificText(at, 'fr'), '29/10 22:55');
  assert.equal(pacificText(at, 'en'), '10/29 22:55');
  assert.equal(pacificClock(at + 5 * MIN), '23:00');
  assert.equal(toLocal(at), Date.UTC(2026, 9, 29, 22, 55));
  // Winter: 8 hours.
  assert.equal(pacificClock(Date.UTC(2026, 11, 1, 8)), '00:00');
  assert.equal(oasisTime(Date.UTC(2026, 9, 30, 5, 25)), '20261030T05:25-0000');
  assert.equal(oasisTime(Date.UTC(2026, 0, 2, 3, 4) + 59_999), '20260102T03:04-0000');
  assert.ok(H > 0);
});
