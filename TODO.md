# TODO

## Before announcing

- [ ] Review r1 (xhigh: energy).
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic at publication only.

## To watch on the real files

- [ ] The wording of the grid conditions beyond "Normal" (the only one seen on
      2026-10-30). Recognized: Normal, Restricted Maintenance Operations,
      Flex Alert, EEA Watch / Energy Emergency Alert Watch, EEA 1-3 / Energy
      Emergency Alert 1-3 (EEA Level n). Anything else makes the level
      unknown (not published, said); the words are still published. Check the
      next real Flex Alert or EEA, and whether the ISO has a machine-readable
      notice feed worth adding.
- [ ] `renewablesPercent` vs `renewablesPercentwoBatteries` (equal on
      2026-10-30, both without batteries at that time). The first one is used.
- [ ] The OASIS error codes besides 1000 ("No data returned"): a 429 is an
      HTTP 429 (seen on 2026-10-30, "retry your request after 5 seconds",
      without Retry-After); other codes are shown as "error <code>".
- [ ] CloudFront in front of Today's Outlook: answers with `Age` under a
      minute and a Last-Modified two minutes after the slot on 2026-10-30. A
      long-cached file would show as stale (by its own times), never as fresh.

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, `docker_image`).
- SDK `^0.16.0` (the template's; the latest published, checked on the
  registry on 2026-10-30). No other runtime dependency.
- Manifest: `categories: ["energy", "environment"]` (tariffs and the grid
  carbon, §3 of the catalog spec), `transports: ["cloud"]`,
  `gladys_version: ">=5.1.0"` (scene triggers); no `keywords` / `countries`
  yet (to add when the core accepts them: `US`).
- Reference: gridstatus 0.37.0 (BSD-3-Clause, notice in
  THIRD_PARTY_NOTICES.md) read for the endpoints and the OASIS query; no code
  ported, no Python. Parsers written from the real answers of 2026-10-30.
- Test files: the real layouts (keys of stats.txt, columns and file names of
  OASIS, the XML error) with made-up numbers; no capture of the ISO's data is
  committed (the data are © California ISO).
- Sources: `stats.txt` alone for the grid (one small JSON, all current values
  with their times), not the CSV trends of the Outlook. OASIS
  `PRC_INTVL_LMP` (real-time 5-minute market, binding intervals) for the
  hubs, one query for the three, window 30 min back to 15 min ahead.
- A source is read only while a created device needs it: nothing is read
  after the installation until a device is created (status says so).
- Devices: one grid (`grid:caiso`), one per hub (`hub:np15|sp15|zp26`), a
  fixed Discovery list (no read needed).
- Units: the demand, net demand and CO2 values are `unknown` with the unit in
  the name (MW, t/h): no MW unit in the core, and `energy-sensor/power` would
  put a whole grid into the home energy views. Renewables share and carbon
  intensity are `grid-carbon-sensor` (`renewable-percentage`, %;
  `carbon-intensity`, g/kWh = t/MWh × 1000). Prices are `currency/decimal/
dollar` in $/MWh (the native unit, the name says it). Alert level 0-6 is
  `unknown`.
- Renewables above 100 % of the demand are published as 100 (the share of
  the consumed electricity, the core's convention 0-100); the CO2 figures are
  CO2, not CO2-equivalent (said in the docs).
- Freshness: Outlook values at most 20 min old (`OUTLOOK_MAX_AGE`, the file
  moves every 5 min), each value on its own time (`...TS`) or the slot; a
  price while its interval ended at most 10 min ago (`PRICE_MAX_LAG`). Ages
  counted from the server `Date` (within a day of our clock), plus the time
  since the read (monotonic). The next interval already received is published
  at its start without a request; a timer also wakes when a view turns stale
  (at least 1 s apart: no busy loop).
- Pacific times: `slotDate` and `...TS` turned into UTC with Intl
  (America/Los_Angeles); in the repeated hour, the latest instant not after
  the Last-Modified of the file (+5 min); without a Last-Modified, the
  repeated hour is unreadable. The skipped hour of March is unreadable.
- Pace: per source, 5 to 60 min (default 5, the ISO's cadence), the time
  asked written to /data before the request (bounded 5 s); OASIS never under
  5 s apart whatever. A request cut by a disconnection counts as asked; one
  stopped before it left does not. The form, Discovery, a reconnection never
  read; a device created reads its source only if not asked within the
  interval.
- Pauses: 429/5xx, 5 min doubled, 60 s to 6 h, `Retry-After` (up to 12 digits,
  capped), kept in /data; the source is read again right when the pause ends
  (its due time is the max of the pace and the pause).
- Scene triggers: `low_price` (threshold of the form, default 0 $/MWh, strict
  "below"; `started` / `ended`) and `grid_alert` (any change of known level).
  First value, or a new threshold, is a reference; last state in /data; an
  unknown level or a stale reading is never a change; an event refused by
  Gladys is not marked (sent again with the next reading if the change still
  holds). A price interval is evaluated once (the first price received for
  it). Threshold checked as typed against the LMP in $/MWh.
- No config action button nor widget: nothing to test that the pace would
  allow, and the device features already show every value.
- /data: one small JSON (asked, pauses, published, triggers, lastOk), written
  through a temporary file; every wait bounded (5 s); unreadable = set aside,
  never overwritten; unwritable = said in the status (the pace is then kept in
  memory only, a restart reads at once).
- No state budget: at most 12 states and 2 events per read (far under the 300
  per minute of the core).

## Tests

- Mutation run (86 mutants on the guards of src/, copies in a private
  temporary folder): all killed but one equivalent, `view.code === 'fresh'`
  → `view.value !== undefined` for a hub (a hub view only carries a value
  when fresh). Two lines found doing nothing were removed (a second arming of
  the timer before the pre-request save, a clear of the texts on a language
  change that the text comparison already covers).

## Ideas

- The day-ahead hourly prices (`PRC_LMP`, DAM) for "cheapest hour tomorrow".
- Other ISOs (PJM, NYISO, ISO-NE, MISO, SPP): one module each.
