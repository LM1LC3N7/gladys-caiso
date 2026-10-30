// -----------------------------------------------------------------------------
// The devices offered in Discovery (pure): a fixed list, no source read
// needed. External ids, forever:
//   the grid:          ext:<selector>:grid:caiso
//   a trading hub:     ext:<selector>:hub:<np15|sp15|zp26>
// Read-only, no poll by Gladys: the app reads the sources itself at its own
// pace. No `energy-sensor`: the demand of a whole grid is not a home meter
// (it never enters the energy dashboards); the MW values are `unknown`, the
// unit in their name.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TY,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  CO2_MAX,
  DEMAND_MAX,
  HUB_KEYS,
  INTENSITY_MAX,
  NET_DEMAND_MIN,
  PRICE_MAX,
  PRICE_MIN,
} from './constants.js';
import { FEATURE_NAMES, deviceName } from './i18n.js';

export const KINDS = { grid: 'grid', hub: 'hub' };
export const GRID_ID = 'caiso';

/** The value features of each kind, in order; the text features come after. */
export const VALUE_KEYS = {
  grid: ['demand', 'net_demand', 'renewables', 'carbon_intensity', 'co2', 'alert_level'],
  hub: ['price'],
};
export const TEXT_KEYS = { grid: ['conditions', 'status'], hub: ['status'] };

/** Whether an id is one of ours for its kind (never a dot, a colon, anything else). */
export const validId = (kind, id) =>
  (kind === 'grid' && id === GRID_ID) || (kind === 'hub' && HUB_KEYS.includes(id));

export const idsOf = (gladys, kind, id) => gladys.externalIds(KINDS[kind], id);

const number = (spec) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...spec,
});

const SPECS = {
  demand: { category: C.UNKNOWN, type: TY.UNKNOWN.UNKNOWN, min: 0, max: DEMAND_MAX },
  net_demand: {
    category: C.UNKNOWN,
    type: TY.UNKNOWN.UNKNOWN,
    min: NET_DEMAND_MIN,
    max: DEMAND_MAX,
  },
  renewables: {
    category: C.GRID_CARBON_SENSOR,
    type: TY.GRID_CARBON_SENSOR.RENEWABLE_PERCENTAGE,
    unit: U.PERCENT,
    min: 0,
    max: 100,
  },
  carbon_intensity: {
    category: C.GRID_CARBON_SENSOR,
    type: TY.GRID_CARBON_SENSOR.CARBON_INTENSITY,
    unit: U.GRAM_CO2_EQ_PER_KILOWATT_HOUR,
    min: 0,
    max: INTENSITY_MAX,
  },
  co2: { category: C.UNKNOWN, type: TY.UNKNOWN.UNKNOWN, min: 0, max: CO2_MAX },
  alert_level: { category: C.UNKNOWN, type: TY.UNKNOWN.UNKNOWN, min: 0, max: 6 },
  price: {
    category: C.CURRENCY,
    type: TY.CURRENCY.DECIMAL,
    unit: U.DOLLAR,
    min: PRICE_MIN,
    max: PRICE_MAX,
  },
};

const text = {
  category: C.TEXT,
  type: TY.TEXT.TEXT,
  min: 0,
  max: 0,
  read_only: true,
  has_feedback: false,
  keep_history: false,
};

/** The device of `kind` / `id` in the language of the form. */
export function buildDevice(gladys, kind, id, language) {
  const ids = idsOf(gladys, kind, id);
  const names = FEATURE_NAMES[language] ?? FEATURE_NAMES.en;
  const features = [
    ...VALUE_KEYS[kind].map((key) =>
      number({ name: names[key], external_id: ids.feature(key), ...SPECS[key] }),
    ),
    ...TEXT_KEYS[kind].map((key) => ({ name: names[key], external_id: ids.feature(key), ...text })),
  ];
  return {
    name: deviceName(language, kind, id),
    external_id: ids.device,
    should_poll: false,
    features,
  };
}

/** Every device of the Discovery list: the grid, then the three hubs. */
export function allDevices(gladys, language) {
  return [
    buildDevice(gladys, 'grid', GRID_ID, language),
    ...HUB_KEYS.map((hub) => buildDevice(gladys, 'hub', hub, language)),
  ];
}

/** The device external id -> { kind, id } for the devices of this integration. */
export function parseDeviceId(gladys, externalId) {
  if (typeof externalId !== 'string') return undefined;
  for (const kind of Object.keys(KINDS)) {
    const prefix = gladys.externalId(`${KINDS[kind]}:`);
    if (externalId.startsWith(prefix)) {
      const id = externalId.slice(prefix.length);
      return validId(kind, id) ? { kind, id } : undefined;
    }
  }
  return undefined;
}
