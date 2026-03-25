/**
 * Compute staff hours breakdown from Nexus shifts.
 * Ports logic from Shifter StaffDetailScreen for pay period aggregation.
 */

const AU_PUBLIC_HOLIDAYS_2025_2026 = [
  '2025-01-01', '2025-01-27', '2025-04-18', '2025-04-19',
  '2025-04-21', '2025-04-25', '2025-06-09', '2025-12-25', '2025-12-26',
  '2026-01-01', '2026-01-26', '2026-04-03', '2026-04-04',
  '2026-04-06', '2026-04-25', '2026-06-08', '2026-12-25', '2026-12-26',
];
const HOLIDAY_SET = new Set(AU_PUBLIC_HOLIDAYS_2025_2026);

const DEFAULT_PAY_PERIOD_START = '2025-03-11';

function normalizeTimeString(val) {
  if (val === null || val === undefined) return '';
  const str = String(val).trim();
  if (!str) return '';
  // ISO datetime: "2025-01-15T09:00:00" -> "09:00"
  const isoMatch = str.match(/T(\d{1,2}):(\d{2})/);
  if (isoMatch) {
    const h = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10);
    if (Number.isFinite(h) && Number.isFinite(m) && h >= 0 && h < 24 && m >= 0 && m < 60) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }
  const match = str.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    if (Number.isFinite(h) && Number.isFinite(m) && h >= 0 && h < 24 && m >= 0 && m < 60) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }
  return '';
}

function parseTimeToMinutes(val) {
  const str = normalizeTimeString(val);
  if (!str) return null;
  const parts = str.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function parseDateISO(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const trimmed = dateStr.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return new Date(+match[1], +match[2] - 1, +match[3]);
  const slashMatch = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/);
  if (slashMatch) return new Date(+slashMatch[3], +slashMatch[2] - 1, +slashMatch[1]);
  return null;
}

function toISODateKey(dateStr) {
  const d = parseDateISO(dateStr);
  if (!d) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getShiftCategory(dateStr) {
  const isoKey = toISODateKey(dateStr);
  if (HOLIDAY_SET.has(isoKey)) return 'publicHoliday';
  const d = parseDateISO(dateStr);
  if (!d) return 'weekday';
  const day = d.getDay();
  if (day === 6) return 'saturday';
  if (day === 0) return 'sunday';
  return 'weekday';
}

function isEveningShift(finishTime) {
  const minutes = parseTimeToMinutes(finishTime);
  if (minutes === null) return false;
  return minutes >= 20 * 60 + 30;
}

function calcDurationMinutes(startTime, finishTime) {
  const start = parseTimeToMinutes(startTime);
  const finish = parseTimeToMinutes(finishTime);
  if (start === null || finish === null) return 0;
  let diff = finish - start;
  if (diff < 0) diff += 24 * 60;
  return diff;
}

function getPayPeriodForDate(dateStr, refDateStr) {
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

function formatPeriodDate(d) {
  if (!d) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function periodKey(start, end) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}_${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
}

/**
 * Compute hours breakdown from Nexus shifts.
 * @param {Array} shifts - Shifts with start_time, end_time (ISO datetime), expenses, travel_time_min / travel_km (optional from progress_notes). Callers usually pass only completed / completed_by_admin shifts.
 * @param {object} [options] - { payPeriodStart }
 * @returns {Array} summaryRows: { periodStart, periodEnd, totalHours, weekdayHours, saturdayHours, sundayHours, holidayHours, eveningHours, travelHours, totalExpenses, totalKm }
 */
export function computeHoursFromShifts(shifts, options = {}) {
  const payPeriodStart = options.payPeriodStart || DEFAULT_PAY_PERIOD_START;
  const periodMap = new Map();

  for (const s of shifts || []) {
    const dateStr = (s.start_time || s.startTime || '').toString().slice(0, 10);
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

    const startTime = (s.start_time || s.startTime || '').toString();
    const finishTime = (s.end_time || s.endTime || '').toString();
    const startTimeStr = startTime.includes('T') ? startTime.slice(11, 16) : startTime;
    const finishTimeStr = finishTime.includes('T') ? finishTime.slice(11, 16) : finishTime;

    const period = getPayPeriodForDate(dateStr, payPeriodStart);
    if (!period) continue;

    const key = periodKey(period.start, period.end);
    if (!periodMap.has(key)) {
      periodMap.set(key, {
        periodStart: formatPeriodDate(period.start),
        periodEnd: formatPeriodDate(period.end),
        start: period.start,
        end: period.end,
        weekday: 0,
        saturday: 0,
        sunday: 0,
        publicHoliday: 0,
        evening: 0,
        travel: 0,
        expenses: 0,
        totalKm: 0,
      });
    }
    const row = periodMap.get(key);

    const duration = calcDurationMinutes(startTimeStr, finishTimeStr);
    const travelMin = parseInt(s.travel_time_min, 10) || 0;
    const shiftAndTravel = duration + travelMin;
    const category = getShiftCategory(dateStr);

    row[category] = (row[category] || 0) + shiftAndTravel;
    if (isEveningShift(finishTimeStr)) {
      row.evening += shiftAndTravel;
    }
    row.travel += travelMin;
    row.expenses += parseFloat(s.expenses) || 0;
    row.totalKm += parseFloat(s.travel_km) || 0;
  }

  const rows = Array.from(periodMap.values())
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .map((r) => ({
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      totalHours: (r.weekday + r.saturday + r.sunday + r.publicHoliday) / 60,
      weekdayHours: r.weekday / 60,
      saturdayHours: r.saturday / 60,
      sundayHours: r.sunday / 60,
      holidayHours: r.publicHoliday / 60,
      eveningHours: r.evening / 60,
      travelHours: r.travel / 60,
      totalExpenses: r.expenses,
      totalKm: r.totalKm,
    }));

  return rows;
}
