# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads the **California grid** from the public files of the California ISO
(CAISO): Today's Outlook (`stats.txt`, the grid) and OASIS (the real-time
prices of the NP15, SP15 and ZP26 hubs, a ZIP). Unofficial. **Read-only**:
never `onSetValue`, only GET requests. No neighbour module; structure taken
from `gladys-attente-frontiere` (app, store, http, clock helpers, tests);
gridstatus (BSD-3-Clause) read as the reference of the endpoints.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/app.test.js              # one file
node --test --test-name-pattern "pace"    # tests whose name matches
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png, 800 x 534, plain Node
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                entry point: the SDK client, the app, src/wire.js, connect()
src/wire.js             the SDK handlers wired to the app (also used by the tests)
src/app.js              CaisoApp: getConfig retries, pace per source, reads, views, publication,
                        scene triggers, status, /data
src/http.js             the only network access (GET, bounded in time and size, text or bytes)
src/outlook.js          stats.txt -> the grid values, the alert level (pure)
src/oasis.js            the OASIS query, its ZIP -> the hub prices or the XML error (pure)
src/zip.js              the one file of a ZIP, bounded, CRC checked (pure)
src/pacific.js          Pacific local times <-> UTC (Intl), the time formats of the ISO (pure)
src/devices.js          the devices, feature keys, external ids (pure)
src/store.js            what /data keeps across restarts (unreadable is not empty)
src/config.js           the form, normalized
src/constants.js        URLs, pacing, limits, bounds
src/i18n.js             runtime texts (en/fr)
test/helpers/app.js     the app on a fake Gladys, scripted sources (real layouts, made-up numbers)
test/helpers/clock.js   virtual and real clocks (copied from the test kit)
test/helpers/zip.js     a ZIP of one file, built by hand
```

## Rules

- **External ids are forever**: `ext:<selector>:grid:caiso` and
  `ext:<selector>:hub:<np15|sp15|zp26>`; feature keys `demand`, `net_demand`,
  `renewables`, `carbon_intensity`, `co2`, `alert_level`, `conditions`,
  `status`, `price`; scene trigger keys `low_price`, `grid_alert` and their
  option values.
- **Never an unknown as a number**: a missing, unreadable, out of range or
  stale value is not published; the status texts say it.
- **Freshness**: a reading published once (source time in /data), only while
  fresh, without `created_at`; the views are evaluated again when they change
  without a read (`nextChange`).
- **Pace**: per source, never two requests less than the interval apart
  (OASIS never under 5 s), the time asked in /data before the request (bounded
  wait); one request at a time; a source never blocks the other; 429/5xx pause
  per source, read again right when it ends.
- **Clocks**: `monotonic` for every timer, pace, pause and age; the wall clock
  only for /data, the OASIS window and a source without a usable `Date`
  header. One clock read per decision.
- **Wholesale prices are not a retail rate**: said in the docs, texts, status.
- Units: only `DEVICE_FEATURE_UNITS_BY_CATEGORY` of the core; no
  `energy-sensor` (a grid is not a home meter).
- **Versions belong to the Release workflow**; `test/manifest.test.js` checks
  they agree. **Changelog** under `## [Unreleased]`. **User-facing text**
  bilingual (en/fr), docs in sync with the code.
- **Style**: Prettier, ESLint; comments in English explain why; tests never
  touch the network beyond 127.0.0.1.
