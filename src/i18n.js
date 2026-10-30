// -----------------------------------------------------------------------------
// Runtime texts. The connection status is multi-language ({ en, fr }, Gladys
// picks); the names given in Discovery and the status texts of the devices
// are in the language of the form (`language`): one string per state.
// Times are Pacific times (the ISO's), said so.
// -----------------------------------------------------------------------------

import { MAX_STATUS_LENGTH } from './constants.js';
import { pacificClock, pacificText, pacificZone } from './pacific.js';

const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));
const seconds = (ms) => Math.max(1, Math.ceil(ms / 1000));
/** A text cut to MAX_STATUS_LENGTH at a space, never inside a word, an ellipsis said. */
export function bound(text, max = MAX_STATUS_LENGTH) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s;,:]+$/, '')}…`;
}
/** The same for a { en, fr } message. */
const boundBoth = (message, max) => ({ en: bound(message.en, max), fr: bound(message.fr, max) });

/** Feature names, by language and key. */
export const FEATURE_NAMES = {
  fr: {
    demand: 'Demande (MW)',
    net_demand: 'Demande nette, hors éolien et solaire (MW)',
    renewables: 'Part renouvelable',
    carbon_intensity: 'Intensité carbone',
    co2: 'Émissions de CO2 (t/h)',
    alert_level: "Niveau d'alerte (0 normal à 6 EEA 3)",
    conditions: 'Conditions du réseau',
    status: 'État des données',
    price: 'Prix de gros temps réel ($/MWh)',
  },
  en: {
    demand: 'Demand (MW)',
    net_demand: 'Net demand, without wind and solar (MW)',
    renewables: 'Renewables share',
    carbon_intensity: 'Carbon intensity',
    co2: 'CO2 emissions (t/h)',
    alert_level: 'Alert level (0 normal to 6 EEA 3)',
    conditions: 'Grid conditions',
    status: 'Data status',
    price: 'Real-time wholesale price ($/MWh)',
  },
};

const HUB_NAMES = {
  np15: { fr: 'NP15, nord de la Californie', en: 'NP15, Northern California' },
  sp15: { fr: 'SP15, sud de la Californie', en: 'SP15, Southern California' },
  zp26: { fr: 'ZP26, centre de la Californie', en: 'ZP26, Central California' },
};

/** The name of a device in Discovery. */
export function deviceName(language, kind, id) {
  const fr = language === 'fr';
  if (kind === 'grid')
    return fr ? 'Réseau électrique californien (CAISO)' : 'California grid (CAISO)';
  const hub = HUB_NAMES[id]?.[fr ? 'fr' : 'en'] ?? id;
  return fr ? `Prix de gros CAISO ${hub}` : `CAISO wholesale price ${hub}`;
}

const KEY_NAMES = {
  fr: {
    demand: 'demande',
    net_demand: 'demande nette',
    renewables: 'part renouvelable',
    carbon_intensity: 'intensité carbone',
    co2: 'CO2',
    conditions: 'conditions',
  },
  en: {
    demand: 'demand',
    net_demand: 'net demand',
    renewables: 'renewables',
    carbon_intensity: 'carbon intensity',
    co2: 'CO2',
    conditions: 'conditions',
  },
};

/**
 * The status text of the grid device.
 * @param {{ code: 'fresh'|'stale', slot: number, missing?: string[], unknown?: string[],
 *   noLevel?: boolean }} view
 */
export function gridStatus(language, view) {
  const fr = language === 'fr';
  // PDT or PST: the repeated hour of November reads twice, told apart.
  const at = `${pacificText(view.slot, language)} ${pacificZone(view.slot)}`;
  if (view.code === 'stale') {
    return bound(
      fr
        ? `Périmé, rien publié : dernier relevé du ${at}`
        : `Stale, nothing published: last reading of ${at}`,
    );
  }
  let text = fr ? `Relevé du ${at}` : `Reading of ${at}`;
  const names = KEY_NAMES[fr ? 'fr' : 'en'];
  const missing = (view.missing ?? []).map((key) => names[key] ?? key);
  if (missing.length > 0) {
    text += fr ? ` ; non publié : ${missing.join(', ')}` : `; not published: ${missing.join(', ')}`;
  }
  if (view.noLevel) {
    text += fr ? " ; pas de niveau d'alerte reconnu" : '; no alert level recognized';
  } else if ((view.unknown ?? []).length > 0) {
    text += fr ? ' ; conditions non reconnues ignorées' : '; conditions not recognized, left out';
  }
  return bound(text);
}

/**
 * The status text of a hub device.
 * @param {{ code: 'fresh'|'stale'|'no_data', start?: number, end?: number }} view
 */
export function hubStatus(language, view) {
  const fr = language === 'fr';
  if (view.code === 'no_data') {
    return fr
      ? 'Aucun prix publié par OASIS pour cet intervalle : rien publié'
      : 'No price published by OASIS for this interval: nothing published';
  }
  const span = `${pacificText(view.start, language)}-${pacificClock(view.end)} ${pacificZone(view.start)}`;
  if (view.code === 'stale') {
    return bound(
      fr
        ? `Périmé, rien publié : dernier intervalle ${span}`
        : `Stale, nothing published: last interval ${span}`,
    );
  }
  return bound(
    fr
      ? `Prix de gros, pas votre tarif ; intervalle ${span}`
      : `Wholesale price, not your rate; interval ${span}`,
  );
}

const SOURCE_NAMES = {
  outlook: { en: "Today's Outlook", fr: "Today's Outlook" },
  oasis: { en: 'OASIS prices', fr: 'prix OASIS' },
};

/** Words of the ISO quoted in a status (bounded), or "none". */
const words = (list) =>
  Array.isArray(list) && list.length > 0
    ? list.map((w) => `"${bound(String(w), 40)}"`).join(', ')
    : '-';

/** What went wrong with one source, both languages. */
export function problemText(source, problem, now = 0) {
  const name = SOURCE_NAMES[source] ?? { en: source, fr: source };
  const left = problem.until !== undefined ? problem.until - now : 0;
  const status = problem.status ? ` ${problem.status}` : '';
  const texts = {
    network: { en: 'unreachable', fr: 'injoignable' },
    timeout: { en: 'no answer in time', fr: 'pas de réponse à temps' },
    rate_limited: {
      en: `too many requests (HTTP 429), paused ${minutes(left)} min`,
      fr: `trop de requêtes (HTTP 429), pause de ${minutes(left)} min`,
    },
    server: {
      en: `server error (HTTP${status}), paused ${minutes(left)} min`,
      fr: `erreur du serveur (HTTP${status}), pause de ${minutes(left)} min`,
    },
    paused: {
      en: `paused for ${minutes(left)} more min`,
      fr: `en pause encore ${minutes(left)} min`,
    },
    http: { en: `answered HTTP${status}`, fr: `réponse HTTP${status}` },
    redirect: { en: 'redirect refused', fr: 'redirection refusée' },
    too_large: { en: 'answer too large, cut', fr: 'réponse trop grosse, coupée' },
    encoding: { en: 'text is not UTF-8', fr: 'texte illisible (pas en UTF-8)' },
    format: { en: 'unexpected format, nothing published', fr: 'format inattendu, rien publié' },
    oasis_error: {
      en: `error ${problem.detail ?? '?'} from OASIS, nothing published`,
      fr: `erreur ${problem.detail ?? '?'} d'OASIS, rien publié`,
    },
    no_data: {
      en: 'no price for the current interval, nothing published',
      fr: "pas de prix pour l'intervalle en cours, rien publié",
    },
    stale: {
      en: 'data late or frozen, nothing published',
      fr: 'données en retard ou figées, rien publié',
    },
    partial: {
      en: 'some values unreadable, not published',
      fr: 'des valeurs illisibles, non publiées',
    },
    unknown_level: {
      en: `grid conditions not recognized, left out of the alert level: ${words(problem.words)}`,
      fr: `conditions du réseau non reconnues, hors du niveau d'alerte : ${words(problem.words)}`,
    },
  };
  const what = texts[problem.code] ?? { en: 'read failed', fr: 'lecture en échec' };
  return { en: `${name.en}: ${what.en}`, fr: `${name.fr} : ${what.fr}` };
}

export const T = {
  waiting: (ms) => ({
    en: `Waiting for the first read (in ${minutes(ms)} min)`,
    fr: `En attente de la première lecture (dans ${minutes(ms)} min)`,
  }),
  nextRead: (ms) => ({
    en: `Last read fine before the restart; next read in ${minutes(ms)} min`,
    fr: `Dernière lecture réussie avant le redémarrage ; prochaine lecture dans ${minutes(ms)} min`,
  }),
  noDevice: {
    en: 'No device created yet: nothing is read (create the grid or a hub from Discovery)',
    fr: 'Aucun appareil créé : rien n’est lu (créez le réseau ou un hub depuis la Découverte)',
  },
  configUnread: (ms) => ({
    en: `The configuration could not be read from Gladys: next try in ${seconds(ms)} s`,
    fr: `Configuration illisible depuis Gladys : nouvel essai dans ${seconds(ms)} s`,
  }),
  wholesale: {
    en: 'Prices are wholesale market prices, not your retail rate',
    fr: 'Les prix sont des prix de gros du marché, pas votre tarif',
  },
  notes: {
    interval: {
      en: 'interval out of 5-60 min: the nearest bound or 5 min used',
      fr: 'intervalle hors 5-60 min : la borne la plus proche ou 5 min utilisée',
    },
    language: {
      en: 'unknown language: French used',
      fr: 'langue inconnue : français utilisé',
    },
    threshold: {
      en: 'low price threshold out of -1000..2000 $/MWh or unreadable: the nearest bound or 0 used',
      fr: 'seuil de prix bas hors -1000..2000 $/MWh ou illisible : la borne la plus proche ou 0 utilisée',
    },
  },
  dataUnreadable: {
    en: '/data could not be read: the file was set aside; the pace and the triggers start again from scratch',
    fr: '/data illisible : fichier mis de côté ; le rythme et les déclencheurs repartent de zéro',
  },
  dataBlocked: {
    en: '/data could not be read nor set aside: nothing is written to it; the pace and the triggers live in memory only',
    fr: '/data illisible et impossible à mettre de côté : rien n’y est écrit ; le rythme et les déclencheurs ne vivent qu’en mémoire',
  },
  dataStuck: {
    en: '/data does not answer, it cannot be written for now (a save still running): the pace and the readings published are kept in memory meanwhile',
    fr: '/data ne répond pas, il ne peut pas être écrit pour l’instant (une sauvegarde toujours en cours) : le rythme et les relevés publiés restent en mémoire en attendant',
  },
  alertSource: {
    en: 'Alert level: gridstatus field, may lag; see caiso.com/emergency-notifications',
    fr: "Niveau d'alerte : champ gridstatus, parfois en retard ; voir caiso.com/emergency-notifications",
  },
  dataUnwritable: {
    en: '/data cannot be written: the pace and the readings published are kept in memory only',
    fr: '/data non inscriptible : le rythme et les relevés publiés ne sont gardés qu’en mémoire',
  },
};

/** Joins status parts (each { en, fr }) into one bounded message. */
export function joinMessages(parts) {
  if (parts.length === 0) return undefined;
  const join = (lang) => parts.map((p) => p[lang]).join(lang === 'fr' ? ' ; ' : '; ');
  return boundBoth({ en: join('en'), fr: join('fr') }, 500);
}
