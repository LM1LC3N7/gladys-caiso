# gladys-caiso

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for the
**California grid**, from the public files of the California ISO (CAISO): the
real-time wholesale prices of the NP15, SP15 and ZP26 trading hubs, the
demand, the renewables share, the CO2, the grid conditions (Flex Alert, EEA)
and two scene triggers (low wholesale price, grid conditions changed). No
account, no key. Read-only. Not affiliated with the California ISO.

**Wholesale prices are not your retail electricity rate.**

Tried against the real CAISO files on 2026-10-30 (the test files are made-up
numbers in the real layouts); never used yet in a real Gladys install.
Reports are welcome.

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Changes: [CHANGELOG.md](CHANGELOG.md). Open points: [TODO.md](TODO.md).
- Security: [SECURITY.md](SECURITY.md).

## How it works

- Two sources, each read only while a created device needs it, each at its own
  pace (5 to 60 minutes, 5 by default, kept across restarts), one request at a
  time, bounded in time (20 s) and size, honest User-Agent:
  - Today's Outlook (`caiso.com/outlook/current/stats.txt`, ETag and
    Last-Modified sent back) for the grid device;
  - OASIS (`oasis.caiso.com/oasisapi/SingleZip`, `PRC_INTVL_LMP`, one query
    for the three hubs, a ZIP opened with bounds) for the hub devices.
- A reading is published once (deduplicated on the source time, kept in
  /data), only while fresh (Outlook slot ≤ 20 min, price interval ended ≤ 10
  min ago), without `created_at`. A missing or unreadable value is never a
  number, never 0; the status texts say it, and turn "stale" on time even
  without a read.
- Pacific local times become UTC exactly (the Last-Modified of the file tells
  the repeated hour of November apart; without it, unreadable).
- 429/5xx pause the source concerned only (5 min doubled, `Retry-After`, 60 s
  to 6 h, kept across restarts), read again right at the end of the pause.
- Scene triggers fire once per change on fresh readings; their last state is
  kept in /data (a restart never fires them again).

## Development

```bash
npm install
npm test               # node --test --test-timeout=60000
npm run lint
npm run format:check
npm run audit          # npm audit --omit=dev
npm run cover          # cover.png
```

Tests run against the SDK's fake Gladys, scripted sources on a virtual clock
(`test/helpers/app.js`), and a real local HTTP server (`test/http.test.js`,
real clock ×20 in `test/realclock.test.js`). See [CLAUDE.md](CLAUDE.md) for the
architecture and the rules.

## License

Apache-2.0 (see [LICENSE](LICENSE)). Reference and data: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
