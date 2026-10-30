// -----------------------------------------------------------------------------
// The configuration typed in Gladys (manifest `config_schema`), normalized so
// that the rest of the code never sees `undefined` nor a value out of bounds.
// Nothing secret: both sources are public, without account nor key.
// -----------------------------------------------------------------------------

import {
  INTERVAL_DEFAULT_MIN,
  INTERVAL_MAX_MIN,
  INTERVAL_MIN_MIN,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
} from './constants.js';

/** Defaults: the same as the `default` values of the manifest. */
export const DEFAULT_CONFIG = {
  language: 'fr',
  interval_minutes: INTERVAL_DEFAULT_MIN,
  low_price_threshold: 0,
};

export const LANGUAGES = ['fr', 'en'];

const typed = (value) => value !== undefined && value !== null && value !== '';

/** A strict number: a number, or a decimal text ('' and null are "not typed", never 0). */
function strictNumber(value, { integer }) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const text = value.trim();
  const pattern = integer ? /^-?\d{1,6}$/ : /^-?\d{1,6}(\.\d{1,6})?$/;
  return pattern.test(text) ? Number(text) : NaN;
}

/**
 * @returns {{ language: 'fr'|'en', intervalMinutes: number, threshold: number, notes: string[] }}
 * `notes` lists the values replaced (shown in the status, never the value typed).
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const notes = [];
  let language = DEFAULT_CONFIG.language;
  if (typed(source.language)) {
    if (LANGUAGES.includes(source.language)) language = source.language;
    else notes.push('language');
  }
  let intervalMinutes = DEFAULT_CONFIG.interval_minutes;
  if (typed(source.interval_minutes)) {
    const value = strictNumber(source.interval_minutes, { integer: true });
    if (Number.isInteger(value) && value >= INTERVAL_MIN_MIN && value <= INTERVAL_MAX_MIN) {
      intervalMinutes = value;
    } else if (Number.isInteger(value) && value > INTERVAL_MAX_MIN) {
      intervalMinutes = INTERVAL_MAX_MIN;
      notes.push('interval');
    } else if (Number.isInteger(value)) {
      intervalMinutes = INTERVAL_MIN_MIN;
      notes.push('interval');
    } else {
      notes.push('interval');
    }
  }
  let threshold = DEFAULT_CONFIG.low_price_threshold;
  if (typed(source.low_price_threshold)) {
    const value = strictNumber(source.low_price_threshold, { integer: false });
    if (Number.isFinite(value) && value >= THRESHOLD_MIN && value <= THRESHOLD_MAX) {
      threshold = value;
    } else if (Number.isFinite(value)) {
      threshold = Math.min(Math.max(value, THRESHOLD_MIN), THRESHOLD_MAX);
      notes.push('threshold');
    } else {
      notes.push('threshold');
    }
  }
  return { language, intervalMinutes, threshold, notes };
}
