// -----------------------------------------------------------------------------
// OASIS answers -> the real-time 5-minute prices of the trading hubs (pure).
// The query URL, the ZIP opened (src/zip.js), then either the CSV of the
// prices (times in GMT, unambiguous) or the XML error OASIS puts in the ZIP
// instead ("1000 No data returned for the specified selection").
//
// A row is kept only if everything about it is readable: a hub of ours, the
// LMP itself (not one of its components), a 5-minute interval in GMT, a
// strict decimal price within bounds. Two different prices for the same hub
// and interval: that interval is unreadable.
// -----------------------------------------------------------------------------

import {
  HUBS,
  OASIS_AHEAD,
  OASIS_BACK,
  OASIS_MAX_ROWS,
  OASIS_MAX_UNPACKED,
  OASIS_URL,
  MINUTE,
  PRICE_MAX,
  PRICE_MIN,
} from './constants.js';
import { FormatError, strictNumber } from './outlook.js';
import { oasisTime, parseGmt } from './pacific.js';
import { unzipOne } from './zip.js';

const SLOT = 5 * MINUTE;
const NODE_TO_HUB = new Map(Object.entries(HUBS).map(([hub, node]) => [node, hub]));

/** The query of the real-time 5-minute LMP of the three hubs, around `now` (epoch ms). */
export function oasisQuery(now, base = OASIS_URL) {
  const start = Math.floor((now - OASIS_BACK) / SLOT) * SLOT;
  const end = Math.ceil((now + OASIS_AHEAD) / SLOT) * SLOT;
  const params = [
    ['resultformat', '6'],
    ['queryname', 'PRC_INTVL_LMP'],
    ['version', '3'],
    ['market_run_id', 'RTM'],
    ['node', Object.values(HUBS).join(',')],
    ['startdatetime', oasisTime(start)],
    ['enddatetime', oasisTime(end)],
  ];
  return `${base}?${params.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

/** Splits one CSV line (OASIS quotes nothing it sends here; quotes are still honoured). */
function cells(line) {
  const out = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cell);
      cell = '';
    } else cell += ch;
  }
  out.push(cell);
  return out;
}

/**
 * @param {Buffer} zip the body of the answer
 * @returns {{ kind: 'prices', prices: Record<string, { start: number, end: number, value: number }[]>,
 *   dropped: number } | { kind: 'no_data' } | { kind: 'error', code: string }}
 */
export function parseOasis(zip) {
  const { name, data } = unzipOne(zip, OASIS_MAX_UNPACKED);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new FormatError('not UTF-8');
  }
  if (/\.xml$/i.test(name) || text.trimStart().startsWith('<')) {
    const code = /<m:ERR_CODE>\s*(\d{1,6})\s*<\/m:ERR_CODE>/.exec(text.slice(0, 64 * 1024))?.[1];
    if (code === '1000') return { kind: 'no_data' };
    if (code) return { kind: 'error', code };
    throw new FormatError('XML without an error code');
  }
  if (!/\.csv$/i.test(name)) throw new FormatError('neither CSV nor XML');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = cells(lines[0] ?? '');
  const col = (key) => header.indexOf(key);
  const at = {
    start: col('INTERVALSTARTTIME_GMT'),
    end: col('INTERVALENDTIME_GMT'),
    node: col('NODE'),
    type: col('LMP_TYPE'),
    value: col('VALUE'),
  };
  if (Object.values(at).some((i) => i < 0)) throw new FormatError('missing columns');
  if (lines.length - 1 > OASIS_MAX_ROWS) throw new FormatError('too many rows');
  const slots = new Map();
  const bad = new Set();
  let dropped = 0;
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;
    const row = cells(line);
    if (row[at.type] !== 'LMP') continue;
    const hub = NODE_TO_HUB.get(row[at.node]);
    if (!hub) continue;
    const start = parseGmt(row[at.start]);
    const end = parseGmt(row[at.end]);
    const value = strictNumber(row[at.value]);
    if (
      start === undefined ||
      end === undefined ||
      end - start !== SLOT ||
      value === undefined ||
      value < PRICE_MIN ||
      value > PRICE_MAX
    ) {
      dropped += 1;
      continue;
    }
    const key = `${hub}:${start}`;
    const seen = slots.get(key);
    if (seen && seen.value !== value) {
      bad.add(key);
      continue;
    }
    slots.set(key, { hub, start, end, value });
  }
  const prices = Object.fromEntries(Object.keys(HUBS).map((hub) => [hub, []]));
  for (const [key, slot] of slots) {
    if (bad.has(key)) {
      dropped += 1;
      continue;
    }
    prices[slot.hub].push({ start: slot.start, end: slot.end, value: slot.value });
  }
  for (const list of Object.values(prices)) list.sort((a, b) => a.start - b.start);
  return { kind: 'prices', prices, dropped };
}

/**
 * The price of a hub at `at` (epoch ms): the interval holding it, else the
 * latest interval started before it. Never an interval still to come.
 */
export function priceAt(list, at) {
  let found;
  for (const slot of list ?? []) {
    if (slot.start <= at) found = slot;
    else break;
  }
  return found;
}
