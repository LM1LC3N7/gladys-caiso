// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (manifest
// keys, feature keys, the type part of the external ids, scene trigger keys
// and options) is forever: never rename one.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/**
 * The version of package.json (shipped in the image), read at start: the
 * Release workflow bumps package.json, the lock and the manifest, never this
 * file, so a hard-coded version would lag behind and break the CI.
 */
function packageVersion() {
  try {
    const { version } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    return /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(version) ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = packageVersion();
/** Honest User-Agent, in the name of the integration (never a browser's). */
export const USER_AGENT = `gladys-caiso/${VERSION} (+https://github.com/LM1LC3N7/gladys-caiso)`;

// --- The sources -----------------------------------------------------------------------

/**
 * "Today's Outlook" of the California ISO: one small JSON file (served as
 * text/plain) with the current demand, the renewables share, the CO2 and the
 * grid conditions (Normal, Flex Alert...), refreshed every 5 minutes, with an
 * ETag and a Last-Modified (UTC) the module sends back.
 */
export const OUTLOOK_URL = 'https://www.caiso.com/outlook/current/stats.txt';
/**
 * OASIS, the public market data interface of the California ISO (no key):
 * one ZIP per query holding a CSV, or an XML error. The real-time 5-minute
 * prices (LMP) of the three trading hubs in one query. The ISO allows one
 * request every 5 seconds (HTTP 429 beyond).
 */
export const OASIS_URL = 'https://oasis.caiso.com/oasisapi/SingleZip';

/** The source keys (status, pauses, /data). */
export const SOURCES = { OUTLOOK: 'outlook', OASIS: 'oasis' };

/** The trading hubs: key (feature, external id, trigger option) -> OASIS node. */
export const HUBS = {
  np15: 'TH_NP15_GEN-APND',
  sp15: 'TH_SP15_GEN-APND',
  zp26: 'TH_ZP26_GEN-APND',
};
export const HUB_KEYS = Object.keys(HUBS);

/** The zone of every local time of the ISO (Pacific time, with its changes of time). */
export const ISO_ZONE = 'America/Los_Angeles';

/** stats.txt is ~2.5 KB: anything above is not it, cut before it is complete. */
export const OUTLOOK_MAX_BYTES = 64 * 1024;
/** The ZIP of one OASIS query (~2 KB for 45 minutes of 3 hubs): cut beyond. */
export const OASIS_MAX_BYTES = 256 * 1024;
/** The file inside the ZIP, unpacked (~25 KB): never inflated beyond. */
export const OASIS_MAX_UNPACKED = 1024 * 1024;
/** CSV rows read in one OASIS answer, at most. */
export const OASIS_MAX_ROWS = 5000;
/** One request, from the first byte sent to the last byte read, at most. */
export const REQUEST_TIMEOUT = 20_000;

// --- Schedule ---------------------------------------------------------------------------
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The interval between two reads of a source (minutes, the form): default, bounds. */
export const INTERVAL_DEFAULT_MIN = 5;
export const INTERVAL_MIN_MIN = 5;
export const INTERVAL_MAX_MIN = 60;
/** OASIS: never two requests less than this apart (the ISO's rule), whatever asks. */
export const OASIS_MIN_GAP = 5 * SECOND;
/** The OASIS window asked: from 30 minutes back to 15 minutes ahead (5-minute slots). */
export const OASIS_BACK = 30 * MINUTE;
export const OASIS_AHEAD = 15 * MINUTE;

/** An Outlook slot older than this is stale (the file moves every 5 minutes). */
export const OUTLOOK_MAX_AGE = 20 * MINUTE;
/** A price whose 5-minute interval ended more than this ago is stale. */
export const PRICE_MAX_LAG = 10 * MINUTE;
/** A reading dated more than this in the future is unreadable. */
export const FUTURE_SLACK = 5 * MINUTE;
/** A server `Date` further than this from our clock is not used as the reference. */
export const DATE_HEADER_TRUST = DAY;

/** 429 / 5xx of a source: paused 5 min, doubled, between 60 s and 6 h (Retry-After honoured). */
export const PAUSE_BASE = 5 * MINUTE;
export const PAUSE_MIN = 60 * SECOND;
export const PAUSE_MAX = 6 * HOUR;

/** `getConfig()` failing at a connection: tried again after 5 s, doubled up to 5 min, without end. */
export const CONFIG_RETRY_MIN = 5 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;

/** A save or a read of /data is awaited this long at most (it goes on in the background). */
export const SAVE_WAIT = 5 * SECOND;
/** A clean stop waits this long, at most, for the read running. */
export const STOP_WAIT = 3 * SECOND;
/** A status text, at most (characters). */
export const MAX_STATUS_LENGTH = 160;
/** The grid conditions text, at most (characters). */
export const MAX_CONDITIONS_LENGTH = 100;

// --- Value bounds (a value outside is unreadable, never published) -------------------------
/** $/MWh: the ISO's bid floor is -150 and its cap 2,000; the LMP can pass them a little. */
export const PRICE_MIN = -10_000;
export const PRICE_MAX = 20_000;
/** MW: the ISO's record peak is 52,061 MW. */
export const DEMAND_MAX = 100_000;
/** Net demand (demand minus wind and solar) is negative on some spring days. */
export const NET_DEMAND_MIN = -100_000;
/** Metric tons of CO2 per hour. */
export const CO2_MAX = 100_000;
/** g/kWh (the file gives metric tons per MWh). */
export const INTENSITY_MAX = 2_000;
/** The low price threshold of the form ($/MWh): bounds. */
export const THRESHOLD_MIN = -1000;
export const THRESHOLD_MAX = 2000;
