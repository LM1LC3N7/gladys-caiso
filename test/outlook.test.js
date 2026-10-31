// -----------------------------------------------------------------------------
// stats.txt of the Outlook -> the values: strict numbers (never a text, a null
// or an empty value as 0), bounds, units converted exactly, the times turned
// into UTC with the Last-Modified, the grid conditions -> an alert level.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FormatError,
  LEVELS,
  classify,
  entryOf,
  levelOf,
  parseOutlook,
  strictNumber,
} from '../src/outlook.js';
import { outlookBody } from './helpers/app.js';

const SLOT = Date.UTC(2026, 9, 30, 5, 55);
const LM = SLOT + 3 * 60_000;
const parse = (options = {}, anchor = LM) =>
  parseOutlook(outlookBody({ slot: SLOT, ...options }), anchor);

test('the real layout: every value, its own time, in the units of the core', () => {
  const r = parse();
  assert.equal(r.slot, SLOT);
  assert.deepEqual(r.values, {
    demand: { value: 24000, stamp: SLOT - 4000 },
    net_demand: { value: 20500, stamp: SLOT - 49_000 },
    renewables: { value: 20, stamp: SLOT },
    // 0.275 t/MWh = 275 g/kWh.
    carbon_intensity: { value: 275, stamp: SLOT },
    co2: { value: 6600, stamp: SLOT },
  });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.conditions, ['Normal']);
});

test('never a text, a null, an empty value or a float overflow as a number: left out and counted', () => {
  for (const bad of [
    null,
    '',
    'N/A',
    '--',
    '12a',
    ' 12',
    '1e3',
    true,
    [],
    {},
    NaN,
    Infinity,
    '0x10',
  ]) {
    const r = parse({ set: { CurrentSystemDemand: bad } });
    assert.equal(r.values.demand, undefined, String(bad));
    assert.deepEqual(r.missing, ['demand'], String(bad));
  }
  const r = parse({ drop: ['CurrentNetDemand', 'currentCo2intensity'] });
  assert.equal(r.values.net_demand, undefined);
  assert.equal(r.values.carbon_intensity, undefined);
  assert.deepEqual(r.missing, ['net_demand', 'carbon_intensity']);
  // A decimal text is a number (the file has some: "2501.37").
  assert.equal(parse({ set: { CurrentSystemDemand: '24001.6' } }).values.demand.value, 24002);
  assert.equal(strictNumber('-3.5'), -3.5);
  assert.equal(strictNumber('1'.repeat(41)), undefined);
});

test('bounds: out of range is unreadable; renewables above 100 % are all of the consumption', () => {
  assert.equal(parse({ set: { CurrentSystemDemand: -1 } }).values.demand, undefined);
  assert.equal(parse({ set: { CurrentSystemDemand: 100_001 } }).values.demand, undefined);
  assert.equal(parse({ set: { CurrentNetDemand: -2500 } }).values.net_demand.value, -2500);
  assert.equal(parse({ set: { renewablesPercent: 103 } }).values.renewables.value, 100);
  assert.equal(parse({ set: { renewablesPercent: 100 } }).values.renewables.value, 100);
  assert.equal(parse({ set: { renewablesPercent: 0 } }).values.renewables.value, 0);
  assert.equal(parse({ set: { renewablesPercent: -1 } }).values.renewables, undefined);
  assert.equal(parse({ set: { renewablesPercent: 1001 } }).values.renewables, undefined);
  assert.equal(parse({ set: { currentCo2intensity: 2.1 } }).values.carbon_intensity, undefined);
  assert.equal(parse({ set: { currentCo2intensity: 0.2724 } }).values.carbon_intensity.value, 272);
  assert.equal(parse({ set: { currentCo2: -5 } }).values.co2, undefined);
  assert.equal(parse({ set: { currentCo2: 100_001 } }).values.co2, undefined);
});

test('times: an unreadable own time leaves the value out; a missing one takes the slot', () => {
  const r = parse({ set: { CurrentSystemDemandTS: '20260230120000' } });
  assert.equal(r.values.demand, undefined);
  assert.deepEqual(r.missing, ['demand']);
  const s = parse({ drop: ['CurrentSystemDemandTS'] });
  assert.equal(s.values.demand.stamp, SLOT);
  const n = parse({ set: { CurrentSystemDemandTS: null } });
  assert.equal(n.values.demand.stamp, SLOT);
});

test('the slot: unreadable, missing, in the skipped hour, or after the Last-Modified -> FormatError', () => {
  for (const options of [
    { set: { slotDate: '13/45/2026 22:55' } },
    { drop: ['slotDate'] },
    { set: { slotDate: '03/08/2026 02:30' } },
  ]) {
    assert.throws(() => parse(options), FormatError);
  }
  assert.throws(() => parse({}, SLOT - 10 * 60_000), FormatError);
  // No Last-Modified: an ordinary time still reads.
  assert.equal(parse({}, NaN).slot, SLOT);
  for (const text of ['', 'null', '[]', '"x"', '{', '<html></html>']) {
    assert.throws(() => parseOutlook(text, LM), FormatError, text);
  }
});

test('the repeated hour of November: the Last-Modified tells the two 01:55 apart', () => {
  const first = Date.UTC(2026, 10, 1, 8, 55);
  const second = first + 60 * 60_000;
  const body = outlookBody({ slot: first });
  assert.equal(body.includes('11/01/2026 01:55'), true);
  assert.equal(parseOutlook(body, first + 3 * 60_000).slot, first);
  assert.equal(parseOutlook(outlookBody({ slot: second }), second + 3 * 60_000).slot, second);
  // Without the Last-Modified: unreadable, never a guess.
  assert.throws(() => parseOutlook(body, NaN), FormatError);
});

test('the grid conditions: printable, bounded; anything else is missing (never "Normal")', () => {
  assert.deepEqual(parse({ set: { gridstatus: ['Flex\u0007 Alert '] } }).conditions, [
    'Flex Alert',
  ]);
  for (const bad of [[], 'Normal', [''], [12], ['x'.repeat(101)], Array(11).fill('Normal'), null]) {
    const r = parse({ set: { gridstatus: bad } });
    assert.equal(r.conditions, undefined, JSON.stringify(bad));
    assert.ok(r.missing.includes('conditions'));
  }
  assert.equal(parse({ drop: ['gridstatus'] }).conditions, undefined);
});

test('alert levels: the real lists of the September 2022 emergency, the highest entry recognized', () => {
  // The words of stats.txt `gridstatus` in the Wayback captures of 5 and 6 September 2022.
  const real = [
    [['EEA 1', 'EEA Watch', 'Flex Alert', 'Restricted Maintenance Operations'], 4],
    [
      [
        'EEA 2',
        'EEA 1',
        'EEA Watch',
        'Flex Alert',
        'Restricted Maintenance Operations',
        'Transmission Emergency',
      ],
      5,
    ],
    [['Restricted Maintenance Operations', 'Transmission Emergency'], 1],
    [
      [
        'EEA 3',
        'EEA 2',
        'EEA 1',
        'EEA Watch',
        'Flex Alert',
        'Restricted Maintenance Operations',
        'Transmission Emergency',
      ],
      6,
    ],
  ];
  for (const [list, level] of real) {
    assert.equal(levelOf(list), level, JSON.stringify(list));
    assert.deepEqual(classify(list).unknown, []);
  }
  assert.equal(classify(real[1][0]).transmission, true);
});

test('alert levels: each entry matched whole; spaces and case folded; an ended notice never active', () => {
  const cases = [
    [['Normal'], 0],
    [[' normal '], 0],
    [['RMO'], 1],
    [['Flex Alert'], 2],
    [['flex  alert'], 2],
    [['EEA Watch'], 3],
    [['Energy Emergency Alert Watch'], 3],
    [['EEA1'], 4],
    [['EEA 2'], 5],
    [['EEA Level 2'], 5],
    [['EEA3'], 6],
    [['Energy Emergency Alert 1 (EEA1)'], 4],
    [['EEA 3 - Load shed'], 6],
    [['EEA 3 \u2013 rotating outages'], 6],
    // Transmission Emergency carries no level: alone, no supply notice (0).
    [['Transmission Emergency'], 0],
    [['Transmission Emergency - Northern CA Region'], 0],
    // A comment that does not say the notice ended keeps it active.
    [['EEA 2 - load management programs over the peak'], 5],
    [['EEA 3 - Expired at 9 pm'], undefined],
    // An end word further in the comment does not end the notice.
    [['EEA 1 - in effect until lifted'], 4],
    [['EEA 3 cancelled'], undefined],
    [['EEA 3 - cancelled'], undefined],
    [['Flex Alert expired'], undefined],
    [['No Flex Alert'], undefined],
    [['Not Normal'], undefined],
    [['EEA Watch upgraded to EEA 2'], undefined],
    [['EEA 4'], undefined],
    [[], undefined],
    [undefined, undefined],
  ];
  for (const [conditions, level] of cases) {
    assert.equal(levelOf(conditions), level, JSON.stringify(conditions));
  }
  assert.deepEqual(LEVELS, ['normal', 'rmo', 'flex_alert', 'eea_watch', 'eea1', 'eea2', 'eea3']);
});

test('alert levels: an entry not recognized is named and left out, never lowering the others', () => {
  // Above 0, the level is a minimum: an entry not recognized never lowers it.
  assert.deepEqual(classify(['RMO', 'Grid Warning']), {
    level: 1,
    unknown: ['Grid Warning'],
    transmission: false,
  });
  assert.deepEqual(classify(['EEA 2', 'EEA 3 cancelled']), {
    level: 5,
    unknown: ['EEA 3 cancelled'],
    transmission: false,
  });
  assert.equal(entryOf(42), undefined);
  // The reviewer's list (r2): a comment with "over" never sets an EEA 2 aside.
  assert.equal(
    levelOf(['EEA 2 - load management programs over the peak', 'EEA 1', 'EEA Watch']),
    5,
  );
});

test('alert levels: 0 only from a list whose every entry is recognized, never next to an unknown one', () => {
  // Transmission Emergency alone in the list: no supply notice in force.
  assert.deepEqual(classify(['Transmission Emergency']), {
    level: 0,
    unknown: [],
    transmission: true,
  });
  assert.equal(levelOf(['Transmission Emergency', 'Transmission Emergency - Southern CA']), 0);
  // With "Normal", both recognized: 0, the flag kept, whatever the order.
  assert.deepEqual(classify(['Transmission Emergency', 'Normal']), {
    level: 0,
    unknown: [],
    transmission: true,
  });
  assert.equal(levelOf(['Normal', 'Transmission Emergency']), 0);
  // With a supply notice: the notice, never 0.
  assert.equal(levelOf(['Transmission Emergency', 'Flex Alert']), 2);
  // Review r3: a new wording of an EEA next to Transmission Emergency is
  // unknown, never 0 (never a "back to normal" during an EEA 3).
  assert.deepEqual(classify(['Transmission Emergency', 'EEA-3']), {
    level: undefined,
    unknown: ['EEA-3'],
    transmission: true,
  });
  assert.equal(classify(['EEA-3', 'EEA-2', 'Transmission Emergency']).level, undefined);
  assert.equal(classify(['Transmission Emergency', 'EEA 3 - cancelled']).level, undefined);
  assert.equal(classify(['Transmission Emergency', 'Normal', 'EEA-3']).level, undefined);
  // "Normal" next to an entry not recognized: unknown too, never 0.
  assert.deepEqual(classify(['Normal', 'Grid Warning']), {
    level: undefined,
    unknown: ['Grid Warning'],
    transmission: false,
  });
  assert.equal(levelOf(['EEA-3', 'Normal']), undefined);
  // An entry not recognized next to a notice: the notice stays (a minimum).
  assert.equal(levelOf(['Transmission Emergency', 'Flex Alert', 'EEA-3']), 2);
});
