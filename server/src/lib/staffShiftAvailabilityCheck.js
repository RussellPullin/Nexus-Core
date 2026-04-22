/**
 * Compares a shift window to staff weekly availability (staff.availability_json).
 * Naive datetimes are interpreted in the org schedule timezone (see shiftTimezone + orgShiftTimezone).
 */
import { DateTime, FixedOffsetZone } from 'luxon';
import { parseStaffAvailability, STAFF_AVAILABILITY_DAY_KEYS } from './staffAvailability.js';
import { normalizeOrgTimezoneRaw } from './shiftTimezone.js';

/** Luxon weekday: Monday=1 … Sunday=7 */
const LUXON_DOW_TO_KEY = {
  1: 'mon',
  2: 'tue',
  3: 'wed',
  4: 'thu',
  5: 'fri',
  6: 'sat',
  7: 'sun',
};

function defaultSpec(spec) {
  if (spec && (spec.kind === 'iana' || spec.kind === 'fixed')) return spec;
  return normalizeOrgTimezoneRaw(process.env.NEXUS_SHIFT_TIMEZONE_FALLBACK) || { kind: 'iana', zone: 'Australia/Sydney' };
}

function normalizeNaiveForParse(s) {
  if (s == null || typeof s !== 'string') return null;
  let normalized = s.trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    normalized = `${normalized}T00:00:00`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) {
    normalized = `${normalized}:00`;
  }
  return normalized.length >= 19 ? normalized.slice(0, 19) : normalized;
}

function parseInSpec(naiveStr, spec) {
  const base = normalizeNaiveForParse(naiveStr);
  if (!base) return null;
  const s = defaultSpec(spec);
  if (s.kind === 'iana') {
    return DateTime.fromISO(base, { zone: s.zone });
  }
  if (s.kind === 'fixed') {
    return DateTime.fromISO(base, { zone: FixedOffsetZone.instance(s.offsetMinutes) });
  }
  return null;
}

function isScheduleEmpty(schedule) {
  return STAFF_AVAILABILITY_DAY_KEYS.every((k) => !schedule[k]?.length);
}

function hmToMins(hm) {
  const m = String(hm).match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = sorted[i];
    const last = out[out.length - 1];
    if (a <= last[1]) {
      last[1] = Math.max(last[1], b);
    } else {
      out.push([a, b]);
    }
  }
  return out;
}

function slotsToMergedMinutes(slots) {
  const raw = [];
  for (const slot of slots) {
    const a = hmToMins(slot.start);
    const b = hmToMins(slot.end);
    if (a == null || b == null || a >= b) continue;
    raw.push([a, b]);
  }
  return mergeIntervals(raw);
}

/**
 * @param {number} startM
 * @param {number} endM
 * @param {Array<[number, number]>} merged
 * @returns {boolean}
 */
function rangeCoveredByUnion(startM, endM, merged) {
  if (startM >= endM) return true;
  if (!merged.length) return false;
  let x = startM;
  while (x < endM) {
    let found = null;
    for (const [a, b] of merged) {
      if (a <= x && x < b) {
        found = [a, b];
        break;
      }
    }
    if (!found) return false;
    const nx = Math.min(found[1], endM);
    if (nx === x) return false;
    x = nx;
  }
  return true;
}

function formatWindows(slots) {
  if (!slots?.length) return 'none';
  return slots.map((s) => `${s.start}–${s.end}`).join(', ');
}

/**
 * @param {string|null|undefined} availabilityJson
 * @param {string} startTimeStr
 * @param {string} endTimeStr
 * @param {{ kind: 'iana', zone: string } | { kind: 'fixed', offsetMinutes: number } | null | undefined} orgTzSpec
 * @returns {{ status: 'unknown' } | { status: 'invalid_parse' } | { status: 'invalid_range' } | { status: 'inside' } | { status: 'outside', message: string, allowed_label?: string }}
 */
export function checkShiftAgainstStaffAvailability(availabilityJson, startTimeStr, endTimeStr, orgTzSpec) {
  const schedule = parseStaffAvailability(availabilityJson);
  if (isScheduleEmpty(schedule)) {
    return { status: 'unknown' };
  }

  const dtStart = parseInSpec(startTimeStr, orgTzSpec);
  const dtEnd = parseInSpec(endTimeStr, orgTzSpec);
  if (!dtStart || !dtEnd || !dtStart.isValid || !dtEnd.isValid) {
    return { status: 'invalid_parse' };
  }
  if (dtEnd <= dtStart) {
    return { status: 'invalid_range' };
  }

  let cur = dtStart;
  while (cur < dtEnd) {
    const dayStart = cur.startOf('day');
    const nextMid = dayStart.plus({ days: 1 });
    const segEnd = dtEnd < nextMid ? dtEnd : nextMid;
    const key = LUXON_DOW_TO_KEY[cur.weekday];
    const startM = cur.diff(dayStart, 'minutes').minutes;
    const endM = segEnd.diff(dayStart, 'minutes').minutes;
    const daySlots = schedule[key] || [];
    const merged = slotsToMergedMinutes(daySlots);
    const allowedLabel = formatWindows(daySlots);

    if (!rangeCoveredByUnion(startM, endM, merged)) {
      return {
        status: 'outside',
        message: `Shift falls outside ${key.toUpperCase()} availability (${allowedLabel || 'no hours'}).`,
        allowed_label: allowedLabel,
      };
    }
    cur = segEnd;
  }

  return { status: 'inside' };
}
