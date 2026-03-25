/**
 * NDIS day-of-week utilities for shift line item alignment.
 * Derives shift day type and filters line items to match.
 */

// AU national public holidays 2024-2026 (YYYY-MM-DD) - extend as needed
const PUBLIC_HOLIDAYS = new Set([
  '2024-01-01', '2024-01-26', '2024-03-29', '2024-04-01', '2024-04-25', '2024-12-25', '2024-12-26',
  '2025-01-01', '2025-01-27', '2025-04-18', '2025-04-21', '2025-04-25', '2025-12-25', '2025-12-26',
  '2026-01-01', '2026-01-26', '2026-04-03', '2026-04-06', '2026-04-25', '2026-12-25', '2026-12-28'
]);

/**
 * Get the NDIS rate type for a shift based on its start date/time.
 * @param {string} startTime - ISO datetime or "YYYY-MM-DDTHH:mm" format
 * @returns {'weekday'|'saturday'|'sunday'|'public_holiday'}
 */
export function getShiftDayType(startTime) {
  if (!startTime) return 'weekday';
  const d = new Date(String(startTime).replace(' ', 'T'));
  if (isNaN(d.getTime())) return 'weekday';
  const dateStr = d.toISOString().slice(0, 10);
  if (PUBLIC_HOLIDAYS.has(dateStr)) return 'public_holiday';
  const day = d.getDay(); // 0=Sun, 6=Sat
  if (day === 0) return 'sunday';
  if (day === 6) return 'saturday';
  return 'weekday';
}

/**
 * Filter NDIS line items to those applicable for the shift's day.
 * Items without rate_type default to 'weekday'.
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
 * Check if a line item matches the shift's day.
 * @param {object} item - NDIS line item with rate_type
 * @param {string} shiftStartTime - Shift start datetime
 * @returns {boolean}
 */
export function lineItemMatchesShiftDay(item, shiftStartTime) {
  if (!item) return false;
  const dayType = getShiftDayType(shiftStartTime);
  const itemRateType = item.rate_type || 'weekday';
  return itemRateType === dayType;
}
