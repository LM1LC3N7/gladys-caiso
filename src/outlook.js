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
 * The grid conditions -> an alert level, from the seven notices of the ISO
 * (Grid Emergencies History Report: Flex Alert, RMO, Transmission Emergency,
 * EEA Watch, EEA1, EEA2, EEA3) and "Normal". Each entry is matched whole
 * (case and spaces folded; "EEA 1" and "EEA1" alike; a suffix after a dash,
 * as in "EEA 3 - Load shed", is ignored unless it says the notice ended):
 *   0 normal, 1 Restricted Maintenance Operations, 2 Flex Alert,
 *   3 EEA Watch, 4 EEA 1, 5 EEA 2, 6 EEA 3.
 * The level is the highest entry recognized. "Transmission Emergency" (a
 * regional notice, it says nothing of the supply of the whole grid) is
 * recognized but has no level of its own: it never hides an EEA nor lowers
 * the level; alone in the list, it means no supply notice in force: level 0.
 * An entry not recognized (a new wording, "EEA 3 cancelled") is set aside and
 * named in the status; the level is then a minimum. It is unknown (never
 * published) when no entry carries one, or when it would be 0 next to an entry
 * not recognized ("Normal" or "Transmission Emergency" with "EEA-3").
 */
export const LEVELS = ['normal', 'rmo', 'flex_alert', 'eea_watch', 'eea1', 'eea2', 'eea3'];

/**
 * The first word of a comment after a dash that says the notice is over
 * ("EEA 3 - cancelled"): such an entry is never taken as active. Only the head
 * of the comment counts ("EEA 2 - programs over the peak" stays active); an
 * entry whose main part says it ("EEA 3 cancelled") is not matched at all.
 */
const ENDED = /^(cancel+ed|cancel+ation|expired|ended|lifted|terminated|rescinded)\b/;

/**
 * One entry -> { level } (0-6), { flag: 'transmission_emergency' } or undefined.
 */
export function entryOf(text) {
  if (typeof text !== 'string') return undefined;
  const folded = text.toLowerCase().replace(/\s+/g, ' ').trim();
  // "EEA 3 - Load shed": the part after a dash is a comment.
  const dash = /\s[-\u2013\u2014]\s/.exec(folded);
  const t = dash ? folded.slice(0, dash.index) : folded;
  if (dash && ENDED.test(folded.slice(dash.index + 3).trim())) return undefined;
  if (t === 'normal') return { level: 0 };
  if (t === 'restricted maintenance operations' || t === 'rmo') return { level: 1 };
  if (t === 'flex alert') return { level: 2 };
  if (t === 'transmission emergency') return { flag: 'transmission_emergency' };
  const eea =
    /^(?:eea|energy emergency alert)(?: level)? ?(watch|[123])(?: \((?:eea ?(?:watch|[123]))\))?$/.exec(
      t,
    );
  if (eea) return { level: eea[1] === 'watch' ? 3 : 3 + Number(eea[1]) };
  return undefined;
}

/**
 * @returns {{ level: number | undefined, unknown: string[], transmission: boolean }}
 */
export function classify(conditions) {
  const out = { level: undefined, unknown: [], transmission: false };
  if (!Array.isArray(conditions)) return out;
  for (const item of conditions) {
    const entry = entryOf(item);
    if (!entry) out.unknown.push(String(item));
    else if (entry.flag) out.transmission = true;
    else out.level = Math.max(out.level ?? 0, entry.level);
  }
  // Only Transmission Emergency: no supply notice in force (never a level left
  // over from an earlier EEA).
  if (out.level === undefined && out.transmission) out.level = 0;
  // Level 0 says no notice is in force: never next to an entry not recognized
  // ("EEA-3", a new wording, could be any notice). Unknown instead, so that a
  // new wording never fires a "back to normal" in the middle of an emergency.
  if (out.level === 0 && out.unknown.length > 0) out.level = undefined;
  return out;
}

/** The level alone (undefined when no entry carries one). */
export const levelOf = (conditions) => classify(conditions).level;
