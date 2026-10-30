# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: the California grid from the public files of the California
  ISO, without account nor key. A grid device (demand, net demand, renewables
  share, carbon intensity, CO2 emissions, alert level, grid conditions, data
  status) from Today's Outlook, and one device per trading hub (NP15, SP15,
  ZP26: real-time 5-minute wholesale price in $/MWh, data status) from OASIS.
  Each source read only while a device needs it, at its own pace (5 to 60
  minutes, kept across restarts), one request at a time, bounded; ETag and
  Last-Modified for the Outlook; 429/5xx pause per source. Each reading
  published once, only while fresh (Outlook ≤ 20 min, price interval ended
  ≤ 10 min ago), never a missing value as 0; the texts and the status turn
  stale on time. Pacific times turned into UTC exactly, the repeated hour of
  November told apart with the Last-Modified. Scene triggers "Low wholesale
  price" (threshold of the form, started / ended) and "Grid conditions
  changed" (Normal, Restricted Maintenance Operations, Flex Alert, EEA Watch,
  EEA 1-3), once per change, never after a restart. Read-only. Wholesale
  prices are not a retail rate: said in the docs, the texts and the status.
