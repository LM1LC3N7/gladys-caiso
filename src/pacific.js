// -----------------------------------------------------------------------------
// The local times of the California ISO (Pacific time, America/Los_Angeles)
// turned into UTC instants, exactly, across the changes of time (pure, Intl).
// A local time is a "naive" ms value: its UTC fields are the local fields.
//
// - In the hour repeated in November, a local time has two instants: the one
//   kept is the latest not after an anchor (the Last-Modified of the file,
//   the UTC time it was written), never a guess. Without an anchor that tells
//   them apart, the time is unreadable.
// - In the hour skipped in March, a local time has no instant: unreadable.
// -----------------------------------------------------------------------------

import { DAY, FUTURE_SLACK, ISO_ZONE } from './constants.js';

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ISO_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The local fields of an instant, as a naive ms value. */
export function toLocal(utc) {
  const parts = {};
  for (const { type, value } of formatter.formatToParts(new Date(utc))) parts[type] = value;
  return Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour,
    +parts.minute,
    +parts.second,
  );
}

/** The offset of the zone at an instant (local minus UTC, whole seconds). */
const offsetAt = (utc) => toLocal(Math.floor(utc / 1000) * 1000) - Math.floor(utc / 1000) * 1000;

/** Every UTC instant whose local time is `naive` (0, 1 or 2 of them), in order. */
export function candidates(naive) {
  const offsets = new Set([offsetAt(naive - DAY), offsetAt(naive), offsetAt(naive + DAY)]);
  const found = [];
  for (const offset of offsets) {
    const utc = naive - offset;
    if (offsetAt(utc) === offset && !found.includes(utc)) found.push(utc);
  }
  return found.sort((a, b) => a - b);
}

/**
 * The instant of a local time. `anchor` (epoch ms, optional): the time the
 * file was written (its Last-Modified); the instant kept is the latest not
 * after it (FUTURE_SLACK allowed), as the ISO writes the slot it just ended.
 * Without an anchor, a local time with two instants is unreadable.
 * @returns {number | undefined}
 */
export function resolveLocal(naive, anchor) {
  if (!Number.isFinite(naive)) return undefined;
  const all = candidates(naive);
  if (!Number.isFinite(anchor)) return all.length === 1 ? all[0] : undefined;
  const fit = all.filter((utc) => utc <= anchor + FUTURE_SLACK);
  return fit.length === 0 ? undefined : fit[fit.length - 1];
}

/** A naive ms value from fields, only if every field is in range (no 30 February). */
function naiveOf(y, mo, d, h, mi, s = 0) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return undefined;
  const at = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(at);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d
    ? at
    : undefined;
}

/** "10/29/2026 22:55" (the `slotDate` of the Outlook) -> naive ms, else undefined. */
export function parseSlot(text) {
  if (typeof text !== 'string') return undefined;
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(text);
  return m ? naiveOf(+m[3], +m[1], +m[2], +m[4], +m[5]) : undefined;
}

/** "20261029225456" (the `...TS` fields of the Outlook) -> naive ms, else undefined. */
export function parseStamp(text) {
  if (typeof text !== 'string') return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(text);
  return m ? naiveOf(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]) : undefined;
}

/** "2026-10-30T05:25:00-00:00" (OASIS, GMT) -> epoch ms, else undefined. */
export function parseGmt(text) {
  if (typeof text !== 'string') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})-00:00$/.exec(text);
  return m ? naiveOf(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]) : undefined;
}

/** The OASIS form of an instant: "20261030T05:25-0000". */
export function oasisTime(utc) {
  const iso = new Date(utc).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 16)}-0000`;
}

const pad = (n) => String(n).padStart(2, '0');

/** "29/10 22:55" (fr) or "10/29 22:55" (en): an instant in Pacific time. */
export function pacificText(utc, language) {
  const d = new Date(toLocal(utc));
  const day = pad(d.getUTCDate());
  const month = pad(d.getUTCMonth() + 1);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return language === 'fr' ? `${day}/${month} ${time}` : `${month}/${day} ${time}`;
}

/** "22:55": the local time only. */
export function pacificClock(utc) {
  const d = new Date(toLocal(utc));
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
