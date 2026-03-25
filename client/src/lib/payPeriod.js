/**
 * Pay period utilities for grouping shifts.
 * Mirrors server logic in shiftHours.service.js so periods align with Hours Summary.
 */

const DEFAULT_PAY_PERIOD_START = '2025-03-11';

function parseDateISO(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const trimmed = dateStr.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return new Date(+match[1], +match[2] - 1, +match[3]);
  const slashMatch = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/);
  if (slashMatch) return new Date(+slashMatch[3], +slashMatch[2] - 1, +slashMatch[1]);
  return null;
}

/**
 * Get the pay period (start, end) for a given date.
 * @param {string} dateStr - ISO date (yyyy-mm-dd) or date portion of datetime
 * @param {string} [refDateStr] - Reference period start (default 2025-03-11)
 * @returns {{ start: Date, end: Date } | null}
 */
export function getPayPeriodForDate(dateStr, refDateStr) {
  const date = parseDateISO(dateStr);
  if (!date) return null;
  let ref = parseDateISO(refDateStr);
  if (!ref) ref = parseDateISO(DEFAULT_PAY_PERIOD_START) || new Date(2025, 2, 11);
  const diffMs = date.getTime() - ref.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const periodIndex = Math.floor(diffDays / 14);
  const start = new Date(ref);
  start.setDate(ref.getDate() + periodIndex * 14);
  const end = new Date(start);
  end.setDate(start.getDate() + 13);
  return { start, end };
}

/**
 * Format a Date as dd/mm/yyyy (matches Hours Summary display).
 * @param {Date} d
 * @returns {string}
 */
export function formatPeriodDate(d) {
  if (!d) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/**
 * Normalize a date string to yyyy-mm-dd for comparison.
 * Handles yyyy-mm-dd, dd/mm/yyyy, dd-mm-yyyy, and Date.toString() formats.
 * @param {string} s
 * @returns {string} yyyy-mm-dd or ''
 */
function toISODate(s) {
  if (s == null || s === '') return '';
  const t = String(s).trim();
  if (!t) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const slash = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (slash) {
    const [, d, m, y] = slash;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const d = new Date(t);
  if (!Number.isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return '';
}

/**
 * Group shifts by pay-period boundaries from a summary row list (periodStart / periodEnd, e.g. from shift-hours-summary).
 * When summary rows exist, shift groupings align with the Hours Summary table.
 * Shifts outside those periods are grouped by computed periods and appended.
 * @param {Array} shifts - Shifts with start_time (ISO datetime)
 * @param {Array} periodSummaryRows - Rows with { periodStart, periodEnd } (dd/mm/yyyy)
 * @param {Function} fallbackGroup - groupShiftsByPayPeriod for shifts not in listed periods
 * @returns {Array<{ periodStart: string, periodEnd: string, shifts: Array }>} Sorted by period descending (most recent first)
 */
export function groupShiftsByExcelPeriods(shifts, periodSummaryRows, fallbackGroup) {
  const allShifts = shifts || [];
  if (!periodSummaryRows?.length) return fallbackGroup ? fallbackGroup(allShifts) : [];

  const seenPeriodKeys = new Set();
  const uniqueSummaryRows = [];
  for (const row of periodSummaryRows) {
    const startISO = toISODate(row.periodStart);
    const endISO = toISODate(row.periodEnd);
    if (!startISO || !endISO) continue;
    const pk = `${startISO}|${endISO}`;
    if (seenPeriodKeys.has(pk)) continue;
    seenPeriodKeys.add(pk);
    uniqueSummaryRows.push(row);
  }

  const assignedIds = new Set();
  const result = [];

  for (const row of uniqueSummaryRows) {
    const startISO = toISODate(row.periodStart);
    const endISO = toISODate(row.periodEnd);
    if (!startISO || !endISO) continue;

    const periodShifts = allShifts.filter((s) => {
      const dateStr = (s.start_time || s.startTime || '').toString().slice(0, 10);
      if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
      if (dateStr >= startISO && dateStr <= endISO) {
        assignedIds.add(s.id);
        return true;
      }
      return false;
    });

    result.push({
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      startTime: startISO,
      shifts: periodShifts.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || '')),
    });
  }

  const excelPeriods = result
    .sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''))
    .map(({ periodStart, periodEnd, shifts: periodShifts }) => ({ periodStart, periodEnd, shifts: periodShifts }));

  const unassigned = allShifts.filter((s) => !assignedIds.has(s.id));
  if (unassigned.length === 0 || !fallbackGroup) return excelPeriods;

  const fallbackPeriods = fallbackGroup(unassigned);
  return [...excelPeriods, ...fallbackPeriods];
}

/**
 * Group shifts by pay period (computed from reference date).
 * Use when no period summary row list is available.
 * @param {Array} shifts - Shifts with start_time (ISO datetime)
 * @param {object} [options] - { payPeriodStart }
 * @returns {Array<{ periodStart: string, periodEnd: string, shifts: Array }>} Sorted by period descending (most recent first)
 */
export function groupShiftsByPayPeriod(shifts, options = {}) {
  const payPeriodStart = options.payPeriodStart || DEFAULT_PAY_PERIOD_START;
  const periodMap = new Map();

  for (const s of shifts || []) {
    const dateStr = (s.start_time || s.startTime || '').toString().slice(0, 10);
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

    const period = getPayPeriodForDate(dateStr, payPeriodStart);
    if (!period) continue;

    const key = period.start.getTime();
    if (!periodMap.has(key)) {
      periodMap.set(key, {
        periodStart: formatPeriodDate(period.start),
        periodEnd: formatPeriodDate(period.end),
        startTime: period.start.getTime(),
        shifts: [],
      });
    }
    periodMap.get(key).shifts.push(s);
  }

  return Array.from(periodMap.values())
    .sort((a, b) => b.startTime - a.startTime)
    .map(({ periodStart, periodEnd, shifts: periodShifts }) => ({
      periodStart,
      periodEnd,
      shifts: periodShifts.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || '')),
    }));
}
