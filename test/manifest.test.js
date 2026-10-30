// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  HUB_KEYS,
  INTERVAL_MAX_MIN,
  INTERVAL_MIN_MIN,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
  USER_AGENT,
  VERSION,
} from '../src/constants.js';
import { allDevices, validId } from '../src/devices.js';
import { LEVELS } from '../src/outlook.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');
const wiring = read('src/wire.js');
const app = read('src/app.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const fakeGladys = {
  externalIds: (type, id) => ({
    device: `ext:x:${type}:${id}`,
    feature: (key) => `ext:x:${type}:${id}:${key}`,
  }),
};
const devices = [...allDevices(fakeGladys, 'fr'), ...allDevices(fakeGladys, 'en')];

test('the store basics; one semver version in 4 places (and the User-Agent), never pinned here', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length <= 30, 'the store caps the name at 30 characters');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-caiso:${manifest.version}`);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(VERSION, pkg.version);
  assert.ok(USER_AGENT.startsWith(`gladys-caiso/${pkg.version} (+https://github.com/LM1LC3N7/`));
  assert.equal(pkg.name, 'gladys-caiso');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.deepEqual(manifest.categories, ['energy', 'environment']);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.ok(!('keywords' in manifest) && !('countries' in manifest), 'in TODO.md for later');
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-caiso\//,
  );
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /^Unofficial/);
  assert.match(manifest.description.fr, /^Non officiel/);
});

test('the cover is an 800 x 534 PNG', () => {
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('the docs say how it was tested, that the prices are wholesale, and where the data come from', () => {
  const fr = read('docs/fr.md');
  const en = read('docs/en.md');
  assert.match(fr, /Essayée contre les vrais fichiers de CAISO/);
  assert.match(en, /Tried against the real CAISO files/);
  assert.match(fr, /jamais testée avec un vrai Gladys/);
  assert.match(en, /never tested with a real Gladys/);
  assert.match(fr, /pas votre tarif/);
  assert.match(en, /not your retail rate/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /gridstatus/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /BSD 3-Clause/);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
});

test('the configuration matches the code: language, interval, threshold; nothing secret', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), [
    'intro',
    'language',
    'interval_minutes',
    'low_price_threshold',
  ]);
  for (const key of Object.keys(fields)) {
    assert.ok(!key.startsWith('gladys_'), `${key}: never prefixed gladys_`);
  }
  assert.equal(manifest.config_schema.filter((f) => f.type === 'secret').length, 0);
  assert.equal(fields.language.default, DEFAULT_CONFIG.language);
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    ['fr', 'en'],
  );
  assert.equal(fields.interval_minutes.default, DEFAULT_CONFIG.interval_minutes);
  assert.equal(fields.interval_minutes.min, INTERVAL_MIN_MIN);
  assert.equal(fields.interval_minutes.max, INTERVAL_MAX_MIN);
  assert.equal(fields.low_price_threshold.default, DEFAULT_CONFIG.low_price_threshold);
  assert.equal(fields.low_price_threshold.min, THRESHOLD_MIN);
  assert.equal(fields.low_price_threshold.max, THRESHOLD_MAX);
  for (const link of fields.intro.links) assert.match(link.url, /^https:\/\//);
  assert.ok(!('actions' in manifest), 'no button: nothing the pace would allow');
  assert.ok(!('widgets' in manifest));
  assert.ok(!('scene_actions' in manifest));
});

test('the scene triggers match the events the code sends', () => {
  const triggers = Object.fromEntries(manifest.scene_triggers.map((t) => [t.key, t]));
  assert.deepEqual(Object.keys(triggers), ['low_price', 'grid_alert']);
  const low = triggers.low_price;
  assert.deepEqual(
    low.fields.map((f) => f.key),
    ['hub', 'phase'],
  );
  assert.deepEqual(
    low.fields[0].options.map((o) => o.value),
    HUB_KEYS,
  );
  assert.deepEqual(
    low.fields[1].options.map((o) => o.value),
    ['started', 'ended'],
  );
  assert.deepEqual(
    low.variables.map((v) => v.key),
    ['hub', 'phase', 'price', 'threshold'],
  );
  const alert = triggers.grid_alert;
  assert.deepEqual(
    alert.fields.map((f) => f.key),
    ['level'],
  );
  assert.deepEqual(
    alert.fields[0].options.map((o) => o.value),
    LEVELS,
  );
  assert.deepEqual(
    alert.variables.map((v) => v.key),
    ['level', 'previous_level', 'conditions'],
  );
  // The data keys sent by the code (src/app.js) are the declared ones.
  assert.match(
    app,
    /key: 'low_price',\s+data: \{ hub, phase: [^}]+, price: view\.value, threshold \}/,
  );
  assert.match(
    app,
    /key: 'grid_alert',\s+data: \{\s+level: LEVELS\[view\.level\],\s+previous_level: LEVELS\[last\.level\],\s+conditions:/,
  );
  for (const trigger of manifest.scene_triggers) {
    for (const field of trigger.fields) {
      for (const o of field.options) assert.equal(typeof o.value, 'string');
    }
  }
});

test('the wiring: read-only, getConfig retried by the app, the lifecycle wired', () => {
  assert.match(index, /wire\(gladys, app, logger\);\n\nlogger\.info[\s\S]*gladys\.connect\(\)/);
  for (const code of [index, wiring]) {
    assert.ok(!code.includes('onSetValue'), 'no command: read-only');
    assert.ok(!code.includes('onPoll'), 'the app reads at its own pace');
  }
  assert.match(wiring, /\.connected\(\(\) => gladys\.getConfig\(\)\)/);
  for (const handler of [
    'onScanRequest',
    'onDeviceCreated',
    'onDeviceDeleted',
    'onConfigUpdated',
    "on('disconnected'",
    'handleShutdown',
  ]) {
    assert.ok(wiring.includes(handler), handler);
  }
  const strip = (code) => code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const http = strip(read('src/http.js'));
  assert.match(http, /method: 'GET'/);
  assert.match(http, /redirect: 'manual'/);
  assert.match(http, /credentials: 'omit'/);
  assert.ok(!/Mozilla|Chrome|Safari/.test(read('src/constants.js')), 'never a browser User-Agent');
});

test('the devices: core units only, nothing writable, no switch, no poll, no energy sensor', () => {
  for (const device of devices) {
    assert.equal(device.should_poll, false);
    assert.ok(!('poll_frequency' in device));
    for (const feature of device.features) {
      assert.equal(feature.read_only, true);
      assert.notEqual(feature.category, 'switch');
      assert.notEqual(feature.type, 'binary');
      assert.ok(!feature.category.startsWith('energy'), 'a grid is not a home meter');
      assert.ok(!/[.]|:$/.test(feature.external_id.split(':').pop()));
    }
  }
  assert.deepEqual(
    devices[0].features.map((f) => f.external_id.split(':').pop()),
    [
      'demand',
      'net_demand',
      'renewables',
      'carbon_intensity',
      'co2',
      'alert_level',
      'conditions',
      'status',
    ],
  );
  assert.deepEqual(
    devices[1].features.map((f) => f.external_id.split(':').pop()),
    ['price', 'status'],
  );
  assert.deepEqual(
    devices.slice(0, 4).map((d) => d.external_id),
    ['ext:x:grid:caiso', 'ext:x:hub:np15', 'ext:x:hub:sp15', 'ext:x:hub:zp26'],
  );
  assert.equal(devices[0].name, 'Réseau électrique californien (CAISO)');
  assert.equal(devices[5].name, 'CAISO wholesale price NP15, Northern California');
});

test('the units are in the lists of the core for their category and type', () => {
  const core = new URL('../../../Gladys/server/utils/constants.js', import.meta.url);
  if (!existsSync(core)) return;
  const constants = createRequire(core)(core.pathname);
  for (const feature of devices.flatMap((d) => d.features)) {
    assert.ok(
      Object.values(constants.DEVICE_FEATURE_CATEGORIES).includes(feature.category),
      feature.category,
    );
    if (feature.unit === undefined) continue;
    assert.ok(
      constants.DEVICE_FEATURE_UNITS_BY_CATEGORY[feature.category].includes(feature.unit),
      `${feature.category} ${feature.unit}`,
    );
    const byType =
      constants.DEVICE_FEATURE_UNITS_BY_CATEGORY_AND_TYPE?.[feature.category]?.[feature.type];
    if (byType) assert.ok(byType.includes(feature.unit), `${feature.type} ${feature.unit}`);
  }
});

test('supported_options of every published feature pass the rules of the core', () => {
  const core = new URL(
    '../../../Gladys/server/utils/normalizeSupportedOptions.js',
    import.meta.url,
  );
  let normalize;
  if (existsSync(core)) {
    try {
      normalize = createRequire(core)(core.pathname);
    } catch {
      normalize = undefined;
    }
  }
  let count = 0;
  for (const feature of devices.flatMap((d) => d.features)) {
    const options = feature.supported_options;
    if (options === undefined) continue;
    count += 1;
    const values = options.map((o) => `${o.value}`);
    assert.equal(new Set(values).size, values.length, 'unique values');
    for (const o of options) {
      assert.equal(typeof o.label, 'string');
      assert.ok(o.label.trim() !== '' && o.label === o.label.trim(), 'plain label');
      assert.deepEqual(Object.keys(o).sort(), ['label', 'value']);
    }
    if (typeof normalize === 'function') normalize(feature);
  }
  // This integration publishes no select today: the rule holds for any added later.
  assert.equal(count, 0);
});

test('the licenses ship in the image; no name in LICENSE', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
});

test('the code never feeds the energy endpoints', () => {
  for (const file of ['index.js', 'src/wire.js', 'src/app.js', 'src/devices.js']) {
    assert.doesNotMatch(read(file), /publishEnergyConsumption\(|publishEnergy/, file);
  }
});

test('external ids: only ours, never a dot, a colon nor a slash', () => {
  for (const bad of ['a.b', 'np15:x', '../x', 'NP15', 'np16', '', 'caiso2']) {
    assert.equal(validId('hub', bad), false, bad);
    assert.equal(validId('grid', bad), false, bad);
  }
  assert.equal(validId('hub', 'np15'), true);
  assert.equal(validId('grid', 'caiso'), true);
  assert.equal(validId('grid', 'np15'), false);
  assert.equal(validId('hub', 'caiso'), false);
});
