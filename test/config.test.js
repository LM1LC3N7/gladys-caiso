// -----------------------------------------------------------------------------
// The form, normalized: defaults, bounds, strict numbers; a value replaced is
// noted for the status (never repeated back).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';

test('defaults: French, 5 minutes, threshold 0', () => {
  const defaults = { language: 'fr', intervalMinutes: 5, threshold: 0, notes: [] };
  assert.deepEqual(normalizeConfig(), defaults);
  assert.deepEqual(
    normalizeConfig({ interval_minutes: '', language: null, low_price_threshold: '' }),
    defaults,
  );
  assert.deepEqual(normalizeConfig(null), defaults);
  assert.deepEqual(normalizeConfig('x'), defaults);
});

test('the interval: 5 to 60 minutes, out of bounds brought back and noted', () => {
  assert.equal(normalizeConfig({ interval_minutes: 30 }).intervalMinutes, 30);
  assert.equal(normalizeConfig({ interval_minutes: '15' }).intervalMinutes, 15);
  assert.deepEqual(normalizeConfig({ interval_minutes: 1 }), {
    language: 'fr',
    intervalMinutes: 5,
    threshold: 0,
    notes: ['interval'],
  });
  assert.equal(normalizeConfig({ interval_minutes: -3 }).intervalMinutes, 5);
  assert.equal(normalizeConfig({ interval_minutes: 600 }).intervalMinutes, 60);
  for (const bad of ['7.5', 7.5, 'abc', '1e1', NaN, true]) {
    const r = normalizeConfig({ interval_minutes: bad });
    assert.equal(r.intervalMinutes, 5, String(bad));
    assert.deepEqual(r.notes, ['interval'], String(bad));
  }
});

test('the threshold: a decimal in -1000..2000 $/MWh; beyond brought back, unreadable = 0, noted', () => {
  assert.equal(normalizeConfig({ low_price_threshold: -25.5 }).threshold, -25.5);
  assert.equal(normalizeConfig({ low_price_threshold: '12.25' }).threshold, 12.25);
  assert.equal(normalizeConfig({ low_price_threshold: 0 }).threshold, 0);
  const low = normalizeConfig({ low_price_threshold: -5000 });
  assert.equal(low.threshold, -1000);
  assert.deepEqual(low.notes, ['threshold']);
  assert.equal(normalizeConfig({ low_price_threshold: 9999 }).threshold, 2000);
  for (const bad of ['cheap', '1,5', Infinity, {}]) {
    const r = normalizeConfig({ low_price_threshold: bad });
    assert.equal(r.threshold, 0, String(bad));
    assert.deepEqual(r.notes, ['threshold']);
  }
});

test('the language: fr or en, anything else is French and noted', () => {
  assert.equal(normalizeConfig({ language: 'en' }).language, 'en');
  const r = normalizeConfig({ language: 'de' });
  assert.equal(r.language, 'fr');
  assert.deepEqual(r.notes, ['language']);
});
