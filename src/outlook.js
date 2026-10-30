// -----------------------------------------------------------------------------
// "Today's Outlook" stats.txt -> the values of the grid (pure). The file is a
// small JSON object (served as text/plain), its times in Pacific local time:
// `slotDate` ("10/29/2026 22:55", the 5-minute slot) and `...TS`
// ("20261029225456") for the demand. They are turned into UTC with the
// Last-Modified of the file as anchor (src/pacific.js).
//
// Never a text, a null or an empty value as a number: a value missing,
// unreadable or out of bounds is left out (and counted), never 0.
// -----------------------------------------------------------------------------

import {
  CO2_MAX,
  DEMAND_MAX,
  INTENSITY_MAX,
  MAX_CONDITIONS_LENGTH,
  NET_DEMAND_MIN,
} from './constants.js';
import { parseSlot, parseStamp, resolveLocal } from './pacific.js';

export class FormatError extends Error {
  constructor(reason) {
    super(`unexpected format: ${reason}`);
    this.name = 'FormatError';
  }
}

const isPlain = (data) => Boolean(data) && typeof data === 'object' && !Array.isArray(data);

/** A strict number: a finite number or a decimal text; anything else (null, '', 'N/A') is unknown. */
export function strictNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.length > 40) return undefined;
  return /^-?\d{1,12}(\.\d{1,30})?$/.test(value) ? Number(value) : undefined;
}

/** The grid features of the Outlook: key -> how to read it. */
export const OUTLOOK_FIELDS = {
  demand: { field: 'CurrentSystemDemand', stamp: 'CurrentSystemDemandTS', min: 0, max: DEMAND_MAX },
  net_demand: {
    field: 'CurrentNetDemand',
    stamp: 'CurrentNetDemandTS',
    min: NET_DEMAND_MIN,
    max: DEMAND_MAX,
  },
  // The share CAISO publishes: renewables (large hydro excluded) over the
  // demand. Above 100 % (renewables beyond the demand, the rest exported or
  // stored), the consumed electricity is all renewable: 100.
  renewables: { field: 'renewablesPercent', min: 0, max: 1000, cap: 100 },
  // Metric tons per MWh in the file -> g/kWh (x 1000, exact).
  carbon_intensity: { field: 'currentCo2intensity', min: 0, max: INTENSITY_MAX, scale: 1000 },
  co2: { field: 'currentCo2', min: 0, max: CO2_MAX },
};

/** Control bytes (never in a text shown). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\0-\x1f\x7f]/g;

/** Printable text only (no control byte), spaces folded, trimmed. */
const clean = (text) => text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();

/**
 * @param {string} text the body of stats.txt
 * @param {number} anchor the Last-Modified of the file (epoch ms) or NaN
 * @returns {{ slot: number, values: Record<string, { value: number, stamp: number }>,
 *   missing: string[], conditions: string[] | undefined }}
 */
export function parseOutlook(text, anchor) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new FormatError('not JSON');
  }
  if (!isPlain(data)) throw new FormatError('not an object');
  const slot = resolveLocal(parseSlot(data.slotDate), anchor);
  if (slot === undefined) throw new FormatError('no readable slot');
  const values = {};
  const missing = [];
  for (const [key, spec] of Object.entries(OUTLOOK_FIELDS)) {
    const raw = Object.hasOwn(data, spec.field) ? strictNumber(data[spec.field]) : undefined;
    let stamp = slot;
    if (spec.stamp && Object.hasOwn(data, spec.stamp) && data[spec.stamp] !== null) {
      stamp = resolveLocal(parseStamp(data[spec.stamp]), anchor);
    }
    // Bounds on the value in the unit published (after the conversion).
    const scaled = raw === undefined ? undefined : spec.scale ? raw * spec.scale : raw;
    if (scaled === undefined || scaled < spec.min || scaled > spec.max || stamp === undefined) {
      missing.push(key);
      continue;
    }
    let value = Math.round(scaled);
    if (spec.cap !== undefined) value = Math.min(value, spec.cap);
    values[key] = { value, stamp };
  }
  let conditions;
  const list = Object.hasOwn(data, 'gridstatus') ? data.gridstatus : undefined;
  if (Array.isArray(list) && list.length > 0 && list.length <= 10) {
    const texts = list.map((item) => (typeof item === 'string' ? clean(item) : ''));
    if (texts.every((item) => item.length > 0 && item.length <= MAX_CONDITIONS_LENGTH)) {
      conditions = texts;
    }
  }
  if (conditions === undefined) missing.push('conditions');
  return { slot, values, missing, conditions };
}

/**
 * The grid conditions -> an alert level, from the words the ISO uses. Any
 * text not recognized makes the level unknown (never a lower level).
 *   0 normal, 1 Restricted Maintenance Operations, 2 Flex Alert,
 *   3 EEA Watch, 4 EEA 1, 5 EEA 2, 6 EEA 3.
 */
export const LEVELS = ['normal', 'rmo', 'flex_alert', 'eea_watch', 'eea1', 'eea2', 'eea3'];

export function levelOf(conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return undefined;
  let level = 0;
  for (const item of conditions) {
    const one = levelOfOne(item);
    if (one === undefined) return undefined;
    level = Math.max(level, one);
  }
  return level;
}

function levelOfOne(text) {
  const t = text.toLowerCase();
  if (/^normal$/.test(t)) return 0;
  const eea = /\b(?:eea|energy emergency alert)\b\s*(?:level\s*)?(watch|[123])\b/.exec(t);
  if (eea) return eea[1] === 'watch' ? 3 : 3 + Number(eea[1]);
  if (/\bflex\s*alert\b/.test(t)) return 2;
  if (/\brestricted maintenance operations?\b/.test(t)) return 1;
  return undefined;
}
