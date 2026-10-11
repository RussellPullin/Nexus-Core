/**
 * State and territory public holidays for shift pay and NDIS rates.
 * A shift uses the holidays of the state where the support is delivered.
 */
import { AU_PUBLIC_HOLIDAYS } from './auPublicHolidays.data.js';

export { AU_PUBLIC_HOLIDAYS };

export const AU_STATE_CODES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'];

const STATE_NAMES = [
  ['australian capital territory', 'ACT'],
  ['northern territory', 'NT'],
  ['western australia', 'WA'],
  ['south australia', 'SA'],
  ['new south wales', 'NSW'],
  ['queensland', 'QLD'],
  ['tasmania', 'TAS'],
  ['victoria', 'VIC'],
];

const STATE_ABBREV = [
  ['QLD', 'QLD'],
  ['NSW', 'NSW'],
  ['VIC', 'VIC'],
  ['TAS', 'TAS'],
  ['ACT', 'ACT'],
  ['NT', 'NT'],
  ['WA', 'WA'],
  ['SA', 'SA'],
];

/** Postcode bands used when an address has no state name. Checked after an explicit state token. */
const POSTCODE_BANDS = [
  ['ACT', [[200, 299], [2600, 2618], [2900, 2920]]],
  ['NSW', [[1000, 2599], [2619, 2898], [2921, 2999]]],
  ['VIC', [[3000, 3999], [8000, 8999]]],
  ['QLD', [[4000, 4999], [9000, 9999]]],
  ['SA', [[5000, 5999]]],
  ['WA', [[6000, 6999]]],
  ['TAS', [[7000, 7999]]],
  ['NT', [[800, 899]]],
];

/**
 * Brisbane City Council postcode bands for the Royal Queensland Show holiday.
 * Gold Coast, Redland, Logan, Ipswich and Moreton Bay are outside this area.
 */
const BRISBANE_POSTCODE_BANDS = [
  [4000, 4014],
  [4017, 4020],
  [4030, 4032],
  [4034, 4034],
  [4036, 4037],
  [4051, 4054],
  [4059, 4078],
  [4101, 4113],
  [4120, 4123],
  [4151, 4156],
  [4169, 4174],
  [4178, 4179],
];

const BY_STATE_DATE = new Map();
for (const state of AU_STATE_CODES) {
  for (const entry of AU_PUBLIC_HOLIDAYS[state] || []) {
    const key = `${state}|${entry.date}`;
    if (!BY_STATE_DATE.has(key)) BY_STATE_DATE.set(key, []);
    BY_STATE_DATE.get(key).push(entry);
  }
}

const NATIONWIDE_DATES = new Set();
{
  const dateCounts = new Map();
  for (const state of AU_STATE_CODES) {
    const dates = new Set();
    for (const entry of AU_PUBLIC_HOLIDAYS[state] || []) {
      if (entry.fromMinute != null || entry.region) continue;
      dates.add(entry.date);
    }
    for (const date of dates) dateCounts.set(date, (dateCounts.get(date) || 0) + 1);
  }
  for (const [date, count] of dateCounts) {
    if (count === AU_STATE_CODES.length) NATIONWIDE_DATES.add(date);
  }
}

function inBands(value, bands) {
  return bands.some(([from, to]) => value >= from && value <= to);
}

/**
 * @param {unknown} value
 * @returns {'ACT'|'NSW'|'NT'|'QLD'|'SA'|'TAS'|'VIC'|'WA'|null}
 */
export function normalizeAuState(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const compact = text.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  if (AU_STATE_CODES.includes(compact.toUpperCase())) return compact.toUpperCase();
  for (const [name, code] of STATE_NAMES) {
    if (compact === name) return code;
  }
  return null;
}

function stateFromPostcode(text) {
  const matches = String(text || '').match(/\b(\d{4})\b/g);
  if (!matches) return null;
  const postcode = parseInt(matches[matches.length - 1], 10);
  if (!Number.isFinite(postcode)) return null;
  for (const [code, bands] of POSTCODE_BANDS) {
    if (inBands(postcode, bands)) return code;
  }
  return null;
}

function stateFromText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  const lower = raw.toLowerCase();
  for (const [name, code] of STATE_NAMES) {
    if (lower.includes(name)) return code;
  }
  for (const [abbr, code] of STATE_ABBREV) {
    if (new RegExp(`\\b${abbr}\\b`, 'i').test(raw)) return code;
  }
  return stateFromPostcode(raw);
}

/**
 * Read a state from an address, a state field, or a postcode.
 * Explicit state words win over the postcode.
 * @param {...unknown} parts
 * @returns {'ACT'|'NSW'|'NT'|'QLD'|'SA'|'TAS'|'VIC'|'WA'|null}
 */
export function resolveAuStateFromLocation(...parts) {
  for (const part of parts) {
    const direct = normalizeAuState(part);
    if (direct && String(part).trim().length <= 32 && !/\d/.test(String(part))) return direct;
    const fromText = stateFromText(part);
    if (fromText) return fromText;
  }
  return null;
}

/**
 * Client address first, then intake state, then the provider's address.
 * @param {string|{ state?: string, address?: string, participant_address?: string, intakeState?: string, intake_state?: string, orgAddress?: string, org_address?: string }|null|undefined} location
 * @returns {{ state: string|null, locationText: string }}
 */
export function normalizeHolidayLocation(location) {
  if (!location) return { state: null, locationText: '' };
  if (typeof location === 'string') {
    const trimmed = location.trim();
    const asState = normalizeAuState(trimmed);
    if (asState && trimmed.length <= 32 && !/\d/.test(trimmed)) {
      return { state: asState, locationText: '' };
    }
    return { state: resolveAuStateFromLocation(trimmed), locationText: trimmed };
  }
  const address = String(location.address || location.participant_address || '').trim();
  const intake = String(location.intakeState || location.intake_state || '').trim();
  const org = String(location.orgAddress || location.org_address || '').trim();
  const explicit = normalizeAuState(location.state);
  const state = explicit
    || resolveAuStateFromLocation(address)
    || resolveAuStateFromLocation(intake)
    || resolveAuStateFromLocation(org);
  return { state, locationText: address };
}

export function resolveShiftLocationState(location) {
  return normalizeHolidayLocation(location).state;
}

const STATE_NAME_PATTERN = STATE_NAMES.map(([name]) => name.replace(/\s+/g, '\\s+')).join('|');

/**
 * Split a shift place into the suburb/address and the state code.
 * @param {unknown} value
 * @returns {{ place: string, state: string }}
 */
export function splitServiceLocation(value) {
  const text = String(value ?? '').trim();
  const state = resolveAuStateFromLocation(text) || '';
  if (!state) return { place: text, state: '' };
  const place = text
    .replace(new RegExp(STATE_NAME_PATTERN, 'ig'), ' ')
    .replace(new RegExp(`\\b${state}\\b`, 'ig'), ' ')
    .replace(/\s*,\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { place, state };
}

/**
 * Store the place the shift was worked, including the state when one was chosen.
 * @param {unknown} place
 * @param {unknown} state
 * @returns {string}
 */
export function joinServiceLocation(place, state) {
  const placeText = String(place ?? '').trim();
  const stateCode = normalizeAuState(state) || '';
  return [placeText, stateCode].filter(Boolean).join(', ');
}

export function isBrisbaneShowArea(locationText) {
  const text = String(locationText || '');
  if (/\bbrisbane\b/i.test(text)) return true;
  const postcodes = text.match(/\b(\d{4})\b/g) || [];
  return postcodes.some((raw) => inBands(parseInt(raw, 10), BRISBANE_POSTCODE_BANDS));
}

function entryApplies(entry, startMinutes, locationText) {
  if (entry.region === 'brisbane' && !isBrisbaneShowArea(locationText)) return false;
  if (entry.fromMinute != null) {
    if (startMinutes == null || !Number.isFinite(startMinutes)) return false;
    if (startMinutes < entry.fromMinute) return false;
  }
  return true;
}

/**
 * @param {string} dateStr YYYY-MM-DD in the shift's local calendar
 * @param {string|null|undefined} state
 * @param {{ startMinutes?: number|null, locationText?: string }} [options]
 * @returns {{ date: string, name: string, state: string|null, fromMinute: number|null, region: string|null }|null}
 */
export function getAuPublicHoliday(dateStr, state, options = {}) {
  const date = String(dateStr || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const startMinutes = options.startMinutes;
  const locationText = options.locationText || '';
  const code = normalizeAuState(state) || resolveAuStateFromLocation(state);

  if (code) {
    const entries = BY_STATE_DATE.get(`${code}|${date}`) || [];
    const hit = entries.find((entry) => entryApplies(entry, startMinutes, locationText));
    if (!hit) return null;
    return { date, name: hit.name, state: code, fromMinute: hit.fromMinute ?? null, region: hit.region ?? null };
  }

  if (!NATIONWIDE_DATES.has(date)) return null;
  return { date, name: 'Public holiday', state: null, fromMinute: null, region: null };
}

export function isAuPublicHoliday(dateStr, state, options) {
  return getAuPublicHoliday(dateStr, state, options) != null;
}
