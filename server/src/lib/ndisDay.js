/**
 * NDIS day-of-week and time band for shift line item alignment.
 * Shifts are billed on Australian (org) local date/time, not on UTC.
 */
import { DateTime, FixedOffsetZone } from 'luxon';
import { normalizeOrgTimezoneRaw } from './shiftTimezone.js';

const PUBLIC_HOLIDAYS = new Set([
  '2024-01-01', '2024-01-26', '2024-03-29', '2024-04-01', '2024-04-25', '2024-12-25', '2024-12-26',
  '2025-01-01', '2025-01-27', '2025-04-18', '2025-04-21', '2025-04-25', '2025-12-25', '2025-12-26',
  '2026-01-01', '2026-01-26', '2026-04-03', '2026-04-06', '2026-04-25', '2026-12-25', '2026-12-28'
]);

/**
 * IANA name or FixedOffsetZone for "wall clock" in org reports (NEXUS_SHIFT_TIMEZONE_FALLBACK / Sydney).
 */
function getNdisOrgLuxonZone() {
  const spec = normalizeOrgTimezoneRaw(process.env.NEXUS_SHIFT_TIMEZONE_FALLBACK) || {
    kind: 'iana',
    zone: 'Australia/Sydney'
  };
  if (spec?.kind === 'iana' && spec.zone) return spec.zone;
  if (spec?.kind === 'fixed' && spec.offsetMinutes != null) {
    return FixedOffsetZone.instance(spec.offsetMinutes);
  }
  return 'Australia/Sydney';
}

/**
 * Z or offset means absolute instant; otherwise the string is naive org-local (same as shiftTimezone.js).
 */
function isExplicitZoned(n) {
  const t = n.trim().replace(' ', 'T');
  if (!/T/.test(t) || t.length < 10 || /^\d{4}-\d{2}-\d{2}$/i.test(t)) return false;
  return /T\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(Z$|([+\-])(?:0\d|1[0-4]):\d{2}(?::\d{2})?)$/i.test(t);
}

/**
 * @returns {import('luxon').DateTime | null} Shift instant expressed in the org's NDIS local zone.
 */
export function toShiftOrgWallTime(startTime) {
  if (startTime == null) return null;
  const raw = String(startTime).trim();
  if (!raw) return null;
  const n = raw.replace(' ', 'T');
  const zone = getNdisOrgLuxonZone();
  if (isExplicitZoned(n)) {
    const dt = DateTime.fromISO(n, { setZone: true });
    if (!dt.isValid) return null;
    return dt.setZone(zone);
  }
  let norm = n;
  if (/^\d{4}-\d{2}-\d{2}$/.test(norm)) norm = `${norm}T00:00:00`;
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(norm)) norm = `${norm}:00`;
  const base = norm.length >= 19 ? norm.slice(0, 19) : null;
  if (!base) return null;
  const dt = DateTime.fromISO(base, { zone });
  if (!dt.isValid) return null;
  return dt;
}

/** Luxon weekday: Monday=1 … Sunday=7 → Date#getDay: Sun=0 … */
function luxonToJsDow(weekday) {
  if (weekday < 1 || weekday > 7) return 1;
  return weekday % 7;
}

/**
 * Calendar YYYY-MM-DD in org zone for support dates and plan window lookup.
 * @param {string} startTime
 * @returns {string | null}
 */
export function getShiftLocalDateString(startTime) {
  const w = toShiftOrgWallTime(startTime);
  if (w && w.isValid) {
    return w.toISODate() || w.toFormat('yyyy-LL-dd');
  }
  if (!startTime) return null;
  const s = String(startTime);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

/**
 * Minutes from midnight, org local wall (for end-time–based rules).
 * @param {string} t
 * @returns {number | null}
 */
export function getShiftWallClockMinutes(t) {
  const w = toShiftOrgWallTime(t);
  if (!w || !w.isValid) return null;
  return w.hour * 60 + w.minute;
}

/**
 * @param {string} startTime
 * @returns {'weekday'|'saturday'|'sunday'|'public_holiday'}
 */
export function getShiftDayType(startTime) {
  const w = toShiftOrgWallTime(startTime);
  if (!w || !w.isValid) return 'weekday';
  const dateStr = w.toISODate() || w.toFormat('yyyy-LL-dd');
  if (PUBLIC_HOLIDAYS.has(dateStr)) return 'public_holiday';
  const dayOfWeek = luxonToJsDow(w.weekday);
  if (dayOfWeek === 0) return 'sunday';
  if (dayOfWeek === 6) return 'saturday';
  return 'weekday';
}

/**
 * @param {string} startTime
 * @returns {'daytime'|'evening'|'night'}
 */
export function getShiftTimeBand(startTime) {
  const w = toShiftOrgWallTime(startTime);
  if (!w || !w.isValid) return 'daytime';
  const { hour } = w;
  if (hour >= 6 && hour < 20) return 'daytime';
  if (hour >= 20 && hour < 22) return 'evening';
  return 'night';
}

/**
 * @param {Array} ndisItems
 * @param {string} shiftStartTime
 */
export function getLineItemsForShift(ndisItems, shiftStartTime) {
  if (!ndisItems || !Array.isArray(ndisItems)) return [];
  const dayType = getShiftDayType(shiftStartTime);
  return ndisItems.filter((item) => (item.rate_type || 'weekday') === dayType);
}

/**
 * @param {Array} lineItems
 * @param {Object} ndisItemsById
 * @param {string} shiftStartTime
 */
export function validateLineItemsForShift(lineItems, ndisItemsById, shiftStartTime) {
  const shiftDay = getShiftDayType(shiftStartTime);
  const mismatches = [];
  for (const li of lineItems || []) {
    const item = ndisItemsById?.[li.ndis_line_item_id];
    if (!item) continue;
    const itemRateType = item.rate_type || 'weekday';
    if (itemRateType !== shiftDay) {
      mismatches.push({ ndis_line_item_id: li.ndis_line_item_id, rate_type: itemRateType, shift_day: shiftDay });
    }
  }
  return mismatches;
}
