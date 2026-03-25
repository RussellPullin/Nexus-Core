/**
 * NDIS day-of-week utilities for shift line item validation (server-side).
 * Mirrors client/src/lib/ndisDay.js logic.
 */

// AU national public holidays 2024-2026 (YYYY-MM-DD) - extend as needed
const PUBLIC_HOLIDAYS = new Set([
  '2024-01-01', '2024-01-26', '2024-03-29', '2024-04-01', '2024-04-25', '2024-12-25', '2024-12-26',
  '2025-01-01', '2025-01-27', '2025-04-18', '2025-04-21', '2025-04-25', '2025-12-25', '2025-12-26',
  '2026-01-01', '2026-01-26', '2026-04-03', '2026-04-06', '2026-04-25', '2026-12-25', '2026-12-28'
]);

function parseLocalShiftDateTimeParts(startTime) {
  const raw = String(startTime || '').trim().replace(' ', 'T');
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const dateStr = match[1];
  const hour = parseInt(match[2], 10);
  const minute = parseInt(match[3], 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const dayAnchor = new Date(`${dateStr}T00:00:00`);
  if (isNaN(dayAnchor.getTime())) return null;
  return { dateStr, hour, dayOfWeek: dayAnchor.getDay() };
}

/**
 * Get the NDIS rate type for a shift based on its start date/time.
 * @param {string} startTime - ISO datetime or "YYYY-MM-DD HH:mm:ss" format
 * @returns {'weekday'|'saturday'|'sunday'|'public_holiday'}
 */
export function getShiftDayType(startTime) {
  if (!startTime) return 'weekday';
  const parsed = parseLocalShiftDateTimeParts(startTime);
  if (!parsed) return 'weekday';
  const { dateStr, dayOfWeek } = parsed;
  if (PUBLIC_HOLIDAYS.has(dateStr)) return 'public_holiday';
  if (dayOfWeek === 0) return 'sunday';
  if (dayOfWeek === 6) return 'saturday';
  return 'weekday';
}

/**
 * Get the NDIS time band for a shift based on its start time.
 * Daytime: 06:00–19:59, Evening: 20:00–21:59, Night: 22:00–05:59
 * @param {string} startTime - ISO datetime or "YYYY-MM-DD HH:mm:ss" format
 * @returns {'daytime'|'evening'|'night'}
 */
export function getShiftTimeBand(startTime) {
  if (!startTime) return 'daytime';
  const parsed = parseLocalShiftDateTimeParts(startTime);
  if (!parsed) return 'daytime';
  const { hour } = parsed;
  if (hour >= 6 && hour < 20) return 'daytime';
  if (hour >= 20 && hour < 22) return 'evening';
  return 'night';
}

/**
 * Filter NDIS line items to those applicable for the shift's day.
 * @param {Array} ndisItems - Line items with rate_type
 * @param {string} shiftStartTime - Shift start datetime
 * @returns {Array} Filtered items
 */
export function getLineItemsForShift(ndisItems, shiftStartTime) {
  if (!ndisItems || !Array.isArray(ndisItems)) return [];
  const dayType = getShiftDayType(shiftStartTime);
  return ndisItems.filter((item) => (item.rate_type || 'weekday') === dayType);
}

/**
 * Validate shift line items against shift start time. Returns mismatches.
 * @param {Array} lineItems - { ndis_line_item_id, ... }
 * @param {Object} ndisItemsById - Map of id -> { rate_type, ... }
 * @param {string} shiftStartTime - Shift start datetime
 * @returns {Array<{ndis_line_item_id: string, rate_type: string, shift_day: string}>} Mismatches
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
