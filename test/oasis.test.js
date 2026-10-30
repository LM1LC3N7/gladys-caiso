// -----------------------------------------------------------------------------
// OASIS: the query (one for the three hubs, a bounded window), the ZIP opened
// strictly (bomb, CRC, truncation, several files), the CSV of the prices (only
// the LMP of our hubs, 5-minute intervals in GMT, strict decimals within
// bounds, conflicting duplicates dropped) and the XML errors.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { oasisQuery, parseOasis, priceAt } from '../src/oasis.js';
import { FormatError } from '../src/outlook.js';
import { crc32, unzipOne } from '../src/zip.js';
import { NODES, OASIS_HEADER, oasisError, oasisRow, oasisZip } from './helpers/app.js';
import { zipOne } from './helpers/zip.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 30, 5, 30);
const csvZip = (rows, header = OASIS_HEADER) => zipOne('x.csv', [header, ...rows].join('\r\n'));

test('the query: the LMP of the three hubs, from 30 min back to 15 min ahead, on 5-minute bounds', () => {
  const url = new URL(oasisQuery(Date.UTC(2026, 9, 30, 6, 1, 30), 'https://oasis.test/SingleZip'));
  assert.equal(url.origin + url.pathname, 'https://oasis.test/SingleZip');
  const p = Object.fromEntries(url.searchParams);
  assert.deepEqual(p, {
    resultformat: '6',
    queryname: 'PRC_INTVL_LMP',
    version: '3',
    market_run_id: 'RTM',
    node: 'TH_NP15_GEN-APND,TH_SP15_GEN-APND,TH_ZP26_GEN-APND',
    startdatetime: '20261030T05:30-0000',
    enddatetime: '20261030T06:20-0000',
  });
  assert.match(oasisQuery(T0), /^https:\/\/oasis\.caiso\.com\/oasisapi\/SingleZip\?/);
});

test('the prices of each hub, sorted; the components and the other nodes ignored', () => {
  const zip = oasisZip({
    from: T0,
    to: T0 + 15 * MIN,
    price: (hub, start) => ({ np15: 40, sp15: -12.5, zp26: 0 })[hub] + (start - T0) / MIN,
    extra: [oasisRow({ start: T0, node: 'OTHER_NODE', value: 999 })],
  });
  const r = parseOasis(zip);
  assert.equal(r.kind, 'prices');
  assert.equal(r.dropped, 0);
  assert.deepEqual(
    r.prices.np15.map((s) => [s.start, s.value]),
    [
      [T0, 40],
      [T0 + 5 * MIN, 45],
      [T0 + 10 * MIN, 50],
    ],
  );
  assert.equal(r.prices.sp15[0].value, -12.5);
  // 0 is a real price (a value of the file), never an unknown.
  assert.equal(r.prices.zp26[0].value, 0);
});

test('a row is kept only when all of it reads; two prices for one interval drop it', () => {
  const node = NODES.np15;
  const rows = [
    oasisRow({ start: T0, node, value: 'N/A' }),
    oasisRow({ start: T0 + 5 * MIN, node, value: '' }),
    oasisRow({ start: T0 + 10 * MIN, end: T0 + 25 * MIN, node, value: 30 }),
    oasisRow({ start: T0 + 15 * MIN, node, value: 30001 }),
    oasisRow({ start: T0 + 20 * MIN, node, value: -10001 }),
    oasisRow({ start: T0 + 25 * MIN, node, value: '1e2' }),
    oasisRow({ start: T0 + 30 * MIN, node, value: 31 }),
    oasisRow({ start: T0 + 30 * MIN, node, value: 32 }),
    oasisRow({ start: T0 + 35 * MIN, node, value: 33 }),
    oasisRow({ start: T0 + 35 * MIN, node, value: 33 }),
    oasisRow({ start: T0 + 40 * MIN, node, value: 34 }).replace('-00:00', 'Z'),
  ];
  const r = parseOasis(csvZip(rows));
  assert.deepEqual(r.prices.np15, [{ start: T0 + 35 * MIN, end: T0 + 40 * MIN, value: 33 }]);
  assert.equal(r.dropped, 8);
  assert.deepEqual(r.prices.sp15, []);
});

test('the CSV: missing columns, too many rows, not UTF-8, neither CSV nor XML -> FormatError', () => {
  assert.throws(() => parseOasis(csvZip([], 'INTERVALSTARTTIME_GMT,VALUE')), FormatError);
  const many = Array.from({ length: 5001 }, () =>
    oasisRow({ start: T0, node: NODES.np15, value: 1 }),
  );
  assert.throws(() => parseOasis(csvZip(many)), FormatError);
  assert.throws(() => parseOasis(zipOne('x.csv', Buffer.from([0xff, 0xfe, 0x41]))), FormatError);
  assert.throws(() => parseOasis(zipOne('x.txt', OASIS_HEADER)), FormatError);
  // Columns in another order still read (looked up by name).
  const cols = OASIS_HEADER.split(',');
  const row = oasisRow({ start: T0, node: NODES.sp15, value: 7 }).split(',');
  const order = cols.map((_, i) => cols.length - 1 - i);
  const swapped = csvZip([order.map((i) => row[i]).join(',')], order.map((i) => cols[i]).join(','));
  assert.equal(parseOasis(swapped).prices.sp15[0].value, 7);
});

test('the XML errors: 1000 = no data; another code said; no code = format', () => {
  assert.deepEqual(parseOasis(oasisError(1000)), { kind: 'no_data' });
  assert.deepEqual(parseOasis(oasisError(1015, 'Too many requests')), {
    kind: 'error',
    code: '1015',
  });
  assert.throws(() => parseOasis(zipOne('x.xml', '<?xml version="1.0"?><a/>')), FormatError);
});

test('the ZIP: one file, stored or deflated, its CRC and length checked; a bomb is cut', () => {
  assert.equal(
    unzipOne(zipOne('a.csv', 'hello', { deflate: false }), 100).data.toString(),
    'hello',
  );
  assert.equal(unzipOne(zipOne('a.csv', 'hello'), 100).name, 'a.csv');
  // A declared size above the cap: refused before inflating.
  assert.throws(() => unzipOne(zipOne('a.csv', 'x'.repeat(200)), 100), FormatError);
  // A size declared small that inflates beyond the cap (a bomb): cut by the inflater.
  const bomb = zipOne('a.csv', 'y'.repeat(50));
  const body = deflateRawSync(Buffer.alloc(10 * 1024 * 1024, 0x41));
  const local = bomb.subarray(0, 30 + 5);
  const forged = Buffer.concat([local, body]);
  const central = bomb.subarray(bomb.length - 22 - 46 - 5, bomb.length - 22);
  const cd = Buffer.from(central);
  cd.writeUInt32LE(body.length, 20);
  const end = Buffer.from(bomb.subarray(bomb.length - 22));
  end.writeUInt32LE(forged.length, 16);
  assert.throws(() => unzipOne(Buffer.concat([forged, cd, end]), 1024), FormatError);
  // A flipped byte: CRC.
  const good = zipOne('a.csv', 'hello world', { deflate: false });
  const bad = Buffer.from(good);
  bad[30 + 5 + 2] ^= 0x01;
  assert.throws(() => unzipOne(bad, 100), FormatError);
  // Truncated, not a ZIP, empty, two files.
  assert.throws(() => unzipOne(good.subarray(0, good.length - 30), 100), FormatError);
  assert.throws(() => unzipOne(Buffer.from('<html>busy</html>'.repeat(3)), 100), FormatError);
  assert.throws(() => unzipOne(Buffer.alloc(0), 100), FormatError);
  const two = Buffer.from(good);
  two.writeUInt16LE(2, two.length - 22 + 10);
  assert.throws(() => unzipOne(two, 100), FormatError);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('priceAt: the interval holding the time, else the last one started; never one to come', () => {
  const list = [
    { start: T0, end: T0 + 5 * MIN, value: 1 },
    { start: T0 + 5 * MIN, end: T0 + 10 * MIN, value: 2 },
  ];
  assert.equal(priceAt(list, T0 - 1), undefined);
  assert.equal(priceAt(list, T0).value, 1);
  assert.equal(priceAt(list, T0 + 5 * MIN - 1).value, 1);
  assert.equal(priceAt(list, T0 + 5 * MIN).value, 2);
  assert.equal(priceAt(list, T0 + 60 * MIN).value, 2);
  assert.equal(priceAt([], T0), undefined);
  assert.equal(priceAt(undefined, T0), undefined);
});
