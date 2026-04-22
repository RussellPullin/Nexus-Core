/**
 * NDIS day-of-week utilities for shift line item alignment.
 * Line items and rates are evaluated on org local (Australian) calendar date and clock time, not UTC.
 * Defaults to Australia/Sydney; override with VITE_NEXUS_SHIFT_TIMEZONE to match the server.
 */

// AU national public holidays 2024-2026 (YYYY-MM-DD) - extend as needed
const PUBLIC_HOLIDAYS = new Set([
  '2024-01-01', '2024-01-26', '2024-03-29', '2024-04-01', '2024-04-25', '2024-12-25', '2024-12-26',
  '2025-01-01', '2025-01-27', '2025-04-18', '2025-04-21', '2025-04-25', '2025-12-25', '2025-12-26',
  '2026-01-01', '2026-01-26', '2026-04-03', '2026-04-06', '2026-04-25', '2026-12-25', '2026-12-28'
]);

const ORG_TZ = import.meta.env?.VITE_NEXUS_SHIFT_TIMEZONE || 'Australia/Sydney';

function isExplicitZoned(n) {
  const t = n.trim().replace(' ', 'T');
  if (!/T/.test(t) || t.length < 10 || /^\d{4}-\d{2}-\d{2}$/i.test(t)) return false;
  return /T\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(Z$|([+\-])(?:0\d|1[0-4]):\d{2}(?::\d{2})?)$/i.test(t);
}

/**
 * @returns {{ dateStr: string, hour: number, minute: number, dayOfWeek: number } | null}
 * dayOfWeek: Date#getDay() — Sunday=0 … Saturday=6
 */
function toShiftLocalParts(startTime) {
  if (startTime == null || startTime === '') return null;
  const n = String(startTime).trim().replace(' ', 'T');
  if (!n) return null;
  if (isExplicitZoned(n)) {
    const d = new Date(n);
    if (isNaN(d.getTime())) return null;
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: ORG_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    if (!p.year) return null;
    const y = parseInt(p.year, 10);
    const m = parseInt(p.month, 10);
    const day = parseInt(p.day, 10);
    const h = parseInt(p.hour, 10);
    const min = parseInt(p.minute, 10);
    if (![y, m, day, h, min].every((x) => Number.isFinite(x))) return null;
    const dateStr = `${p.year}-${p.month}-${p.day}`;
    const dayOfWeek = new Date(Date.UTC(y, m - 1, day, 12, 0, 0)).getUTCDay();
    return { dateStr, hour: h, minute: min, dayOfWeek };
  }
  const m = n.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  const hour = m[4] != null ? parseInt(m[4], 10) : 0;
  const min = m[5] != null ? parseInt(m[5], 10) : 0;
  if (hour < 0 || hour > 23 || min < 0 || min > 59) return null;
  const dateStr = `${m[1]}-${m[2]}-${m[3]}`;
  const dayOfWeek = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0)).getUTCDay();
  return { dateStr, hour, minute: min, dayOfWeek };
}

/**
 * @param {string} startTime
 * @returns {'weekday'|'saturday'|'sunday'|'public_holiday'}
 */
export function getShiftDayType(startTime) {
  const p = toShiftLocalParts(startTime);
  if (!p) return 'weekday';
  if (PUBLIC_HOLIDAYS.has(p.dateStr)) return 'public_holiday';
  if (p.dayOfWeek === 0) return 'sunday';
  if (p.dayOfWeek === 6) return 'saturday';
  return 'weekday';
}

/**
 * @param {string} startTime
 * @returns {'daytime'|'evening'|'night'}
 */
export function getShiftTimeBand(startTime) {
  const p = toShiftLocalParts(startTime);
  if (!p) return 'daytime';
  const { hour } = p;
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
 * @param {object} item
 * @param {string} shiftStartTime
 */
export function lineItemMatchesShiftDay(item, shiftStartTime) {
  if (!item) return false;
  const dayType = getShiftDayType(shiftStartTime);
  const itemRateType = item.rate_type || 'weekday';
  return itemRateType === dayType;
}
