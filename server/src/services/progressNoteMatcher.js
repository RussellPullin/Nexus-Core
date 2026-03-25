/**
 * Progress Note Matcher - matches progress notes to shifts and resolves participant/staff by name.
 * Used when receiving progress notes from the Progress Notes App for invoicing and payroll.
 */
import { db } from '../db/index.js';
import { getShiftDayType, getShiftTimeBand } from '../lib/ndisDay.js';

/**
 * Check if an NDIS line item is an establishment fee (one-off, not hourly).
 * Establishment fees are charged once per participant and must never be used for auto billing.
 */
export function isEstablishmentFee(item) {
  if (!item) return false;
  const unit = (item.unit || '').toLowerCase();
  const desc = (item.description || '').toLowerCase();
  return unit === 'each' || unit === 'e' || desc.includes('establishment fee');
}

const TIME_TOLERANCE_MIN = 30;

/** Exclude group activities – prefer 1:1 community access for support worker shifts. */
function isGroupActivity(item) {
  if (!item) return false;
  const desc = (item.description || '').toLowerCase();
  const num = (item.support_item_number || '').trim();
  // 0136 = Group And Centre Based Activities; 0125 = Participation In Community (Access)
  return desc.includes('group') || num.includes('_0136_');
}

/**
 * Normalize name for fuzzy matching: lowercase, trim, collapse spaces.
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Resolve client name to participant_id. Uses case-insensitive fuzzy match.
 * @param {string} clientName
 * @returns {{ id: string } | null}
 */
export function resolveParticipantByName(clientName) {
  const norm = normalizeName(clientName);
  if (!norm) return null;
  const participants = db.prepare('SELECT id, name FROM participants').all();
  const match = participants.find((p) => normalizeName(p.name) === norm);
  if (match) return { id: match.id };
  // Fallback: partial match (e.g. "Kruise cupra" matches "Kruise Cupra")
  const partial = participants.find((p) => normalizeName(p.name).includes(norm) || norm.includes(normalizeName(p.name)));
  return partial ? { id: partial.id } : null;
}

/**
 * Resolve staff name to staff_id. Uses case-insensitive fuzzy match.
 * @param {string} staffName
 * @returns {{ id: string } | null}
 */
export function resolveStaffByName(staffName) {
  const norm = normalizeName(staffName);
  if (!norm) return null;
  const staff = db.prepare('SELECT id, name FROM staff').all();
  const match = staff.find((s) => normalizeName(s.name) === norm);
  if (match) return { id: match.id };
  const partial = staff.find((s) => normalizeName(s.name).includes(norm) || norm.includes(normalizeName(s.name)));
  return partial ? { id: partial.id } : null;
}

/**
 * Parse date string to YYYY-MM-DD. Supports DD/MM/YYYY and YYYY-MM-DD.
 * @param {string} dateStr - e.g. "23/02/2026" or "2026-02-23"
 * @returns {string | null} YYYY-MM-DD
 */
export function parseSupportDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const s = dateStr.trim().replace(/'/g, '');
  // DD/MM/YYYY
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const [, day, month, year] = dmy;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

/**
 * Parse time string (HH:mm or HH:mm:ss) to minutes since midnight.
 * @param {string} timeStr - e.g. "09:00" or "'09:00"
 * @returns {number | null}
 */
function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const s = String(timeStr).trim().replace(/'/g, '');
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hours = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  return hours * 60 + mins;
}

/**
 * Build ISO datetime from date and time strings.
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} timeStr - HH:mm
 * @returns {string | null} ISO datetime
 */
export function buildDateTime(dateStr, timeStr) {
  const date = parseSupportDate(dateStr);
  if (!date) return null;
  const mins = parseTimeToMinutes(timeStr);
  if (mins == null) return `${date}T09:00:00`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

function getShiftTimeBandByStartAndEnd(shiftStartTime, shiftEndTime) {
  const endMins = parseTimeToMinutes(String(shiftEndTime || '').slice(11, 16));
  if (endMins != null && endMins >= 20 * 60) {
    return 'evening';
  }
  return getShiftTimeBand(shiftStartTime);
}

/**
 * Find an existing shift by its external (Shifter/Progress Notes App) shift ID.
 * Used to avoid creating duplicates when the same import is run twice.
 * @param {string} shifterShiftId - shift_id from the app/Excel
 * @returns {object | null} Shift row or null
 */
export function findShiftByShifterShiftId(shifterShiftId) {
  if (!shifterShiftId || typeof shifterShiftId !== 'string' || !shifterShiftId.trim()) return null;
  const id = String(shifterShiftId).trim();
  return db.prepare('SELECT * FROM shifts WHERE shifter_shift_id = ?').get(id) || null;
}

/**
 * Find a shift by same participant, staff, and start date+time (to the minute).
 * Used on import to prevent duplicates when Excel has no stable ID or same shift appears twice.
 * @param {string} participantId
 * @param {string} staffId
 * @param {string} startDateTime - ISO datetime e.g. 2026-03-15T10:27:00
 * @returns {object | null} Shift row or null
 */
export function findShiftByParticipantStaffAndStartTime(participantId, staffId, startDateTime) {
  if (!participantId || !staffId || !startDateTime || typeof startDateTime !== 'string') return null;
  const s = String(startDateTime).trim().slice(0, 16);
  if (s.length < 16) return null;
  const pattern = `${s}%`;
  return db.prepare(`
    SELECT * FROM shifts
    WHERE participant_id = ? AND staff_id = ?
      AND start_time LIKE ?
    ORDER BY start_time LIMIT 1
  `).get(participantId, staffId, pattern) || null;
}

/**
 * Find a shift matching participant, staff, date, and time window.
 * Uses ±30 min tolerance for clock-in variance.
 * @param {object} params
 * @param {string} params.participantId
 * @param {string} params.staffId
 * @param {string} params.supportDate - YYYY-MM-DD
 * @param {string} params.startTime - HH:mm
 * @param {string} params.endTime - HH:mm
 * @param {string} [params.shiftId] - optional explicit shift ID from progress note
 * @returns {object | null} Shift row or null
 */
export function findMatchingShift({ participantId, staffId, supportDate, startTime, endTime, shiftId }) {
  if (shiftId) {
    const byShifterId = db.prepare(`
      SELECT * FROM shifts
      WHERE shifter_shift_id = ? AND participant_id = ? AND staff_id = ?
    `).get(shiftId, participantId, staffId);
    if (byShifterId) return byShifterId;
    const byNexusId = db.prepare(`
      SELECT * FROM shifts
      WHERE id = ? AND participant_id = ? AND staff_id = ?
    `).get(shiftId, participantId, staffId);
    return byNexusId || null;
  }

  const dayStart = `${supportDate}T00:00:00`;
  const dayEnd = `${supportDate}T23:59:59`;
  const shifts = db.prepare(`
    SELECT * FROM shifts
    WHERE participant_id = ? AND staff_id = ?
      AND start_time >= ? AND start_time <= ?
      AND status IN ('scheduled', 'completed', 'completed_by_admin')
  `).all(participantId, staffId, dayStart, dayEnd);

  const noteStartMins = parseTimeToMinutes(startTime);
  const noteEndMins = parseTimeToMinutes(endTime);

  for (const shift of shifts) {
    const shiftStart = shift.start_time ? parseTimeToMinutes(shift.start_time.slice(11, 16)) : null;
    const shiftEnd = shift.end_time ? parseTimeToMinutes(shift.end_time.slice(11, 16)) : null;
    if (shiftStart == null || shiftEnd == null) continue;
    if (noteStartMins != null && noteEndMins != null) {
      const overlap = Math.min(shiftEnd, noteEndMins) - Math.max(shiftStart, noteStartMins);
      if (overlap >= -TIME_TOLERANCE_MIN) return shift;
      continue;
    }
  }
  return null;
}

/**
 * Get default NDIS line item for a participant. Uses shift day + time band.
 * Prefers budget line items (category 04 first for community access), excludes establishment fee.
 * @param {string} participantId
 * @param {string} shiftStartTime - ISO datetime for rate_type and time_band
 * @param {string} [supportDate] - YYYY-MM-DD for plan lookup (defaults to shift date)
 * @param {string} [shiftEndTime] - ISO datetime (used to prefer evening when shift ends after 20:00)
 * @returns {{ id: string, rate: number, unit: string } | null}
 */
export function getDefaultLineItemForParticipant(participantId, shiftStartTime, supportDate, shiftEndTime = null) {
  const dayType = getShiftDayType(shiftStartTime);
  const timeBand = getShiftTimeBandByStartAndEnd(shiftStartTime, shiftEndTime);
  const dateStr = supportDate || (shiftStartTime ? shiftStartTime.slice(0, 10) : null) || new Date().toISOString().slice(0, 10);

  const getRate = (item, remoteness) =>
    remoteness === 'very_remote' ? (item.rate_very_remote ?? item.rate)
      : remoteness === 'remote' ? (item.rate_remote ?? item.rate)
      : item.rate;

  const toResult = (item, remoteness) => ({
    id: item.id,
    rate: Number(getRate(item, remoteness)) || 0,
    unit: (item.unit || 'hour').toLowerCase() === 'hr' ? 'hour' : (item.unit || 'hour')
  });

  const participant = db.prepare('SELECT default_ndis_line_item_id, remoteness FROM participants WHERE id = ?').get(participantId);
  const remoteness = participant?.remoteness || 'standard';

  // 1. Participant default (exclude establishment fee and group)
  if (participant?.default_ndis_line_item_id) {
    const nli = db.prepare('SELECT id, rate, rate_remote, rate_very_remote, unit, rate_type, time_band, description, support_item_number FROM ndis_line_items WHERE id = ?').get(participant.default_ndis_line_item_id);
    if (nli && !isEstablishmentFee(nli) && !isGroupActivity(nli)) {
      const itemRateType = nli.rate_type || 'weekday';
      const itemTimeBand = nli.time_band || 'daytime';
      if (itemRateType === dayType && itemTimeBand === timeBand) {
        return toResult(nli, remoteness);
      }
    }
  }

  // 2. Implementation (exclude establishment fee and group)
  const impl = db.prepare(`
    SELECT i.ndis_line_item_id, nli.id, nli.rate, nli.rate_remote, nli.rate_very_remote, nli.unit, nli.rate_type, nli.time_band, nli.description, nli.support_item_number
    FROM implementations i
    JOIN ndis_plans np ON np.id = i.plan_id
    JOIN ndis_line_items nli ON nli.id = i.ndis_line_item_id
    WHERE np.participant_id = ? AND i.ndis_line_item_id IS NOT NULL
      AND np.start_date <= ? AND np.end_date >= ?
    ORDER BY i.implemented_date DESC
    LIMIT 1
  `).get(participantId, dateStr, dateStr);

  if (impl && !isEstablishmentFee(impl) && !isGroupActivity(impl)) {
    const itemRateType = impl.rate_type || 'weekday';
    const itemTimeBand = impl.time_band || 'daytime';
    if (itemRateType === dayType && itemTimeBand === timeBand) {
      return toResult(impl, remoteness);
    }
  }

  // 3. Budget line items: prefer category 04 (community access) first, then 01, 02, 03, etc.
  // Exclude 0136 (Group Activities); prefer 0125 (Access to Community)
  const budgetOrder = ['04', '01', '02', '03', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15'];
  for (const cat of budgetOrder) {
    const budgetItems = db.prepare(`
      SELECT bli.ndis_line_item_id, nli.id, nli.rate, nli.rate_remote, nli.rate_very_remote, nli.unit, nli.rate_type, nli.time_band, nli.description, nli.support_item_number
      FROM plan_budgets pb
      JOIN ndis_plans np ON np.id = pb.plan_id
      JOIN budget_line_items bli ON bli.budget_id = pb.id
      JOIN ndis_line_items nli ON nli.id = bli.ndis_line_item_id
      WHERE np.participant_id = ? AND np.start_date <= ? AND np.end_date >= ?
        AND pb.category = ?
        AND (nli.unit = 'hour' OR nli.unit = 'hr')
        AND (nli.rate_type = ? OR nli.rate_type IS NULL)
        AND (nli.time_band = ? OR nli.time_band IS NULL)
        AND (nli.description NOT LIKE '%Establishment Fee%' AND nli.description NOT LIKE '%establishment fee%')
        AND (nli.description NOT LIKE '%group%' AND nli.description NOT LIKE '%Group%')
        AND (nli.support_item_number NOT LIKE '%_0136_%')
      ORDER BY (nli.support_item_number LIKE '%_0125_%') DESC, nli.rate_type = ? DESC
      LIMIT 1
    `).all(participantId, dateStr, dateStr, cat, dayType, timeBand, dayType);

    const match = budgetItems.find((i) => !isEstablishmentFee(i) && !isGroupActivity(i));
    if (match) {
      return toResult(match, remoteness);
    }
  }

  // 4. Fallback: category 04 (community access) with day + time band, exclude group (0136)
  // Prefer Access to Community (0125) over Group Activities (0136)
  const fallback = db.prepare(`
    SELECT id, rate, rate_remote, rate_very_remote, unit, rate_type, time_band, description, support_item_number
    FROM ndis_line_items
    WHERE (support_category = '04' OR support_item_number LIKE '04_%')
      AND (rate_type = ? OR rate_type IS NULL OR rate_type = 'weekday')
      AND (time_band = ? OR time_band IS NULL)
      AND (unit = 'hour' OR unit = 'hr')
      AND (description NOT LIKE '%Establishment Fee%' AND description NOT LIKE '%establishment fee%')
      AND (description NOT LIKE '%group%' AND description NOT LIKE '%Group%')
      AND (support_item_number NOT LIKE '%_0136_%')
    ORDER BY (support_item_number LIKE '%_0125_%') DESC, rate_type = ? DESC
    LIMIT 1
  `).get(dayType, timeBand, dayType);

  if (fallback && !isEstablishmentFee(fallback) && !isGroupActivity(fallback)) {
    return toResult(fallback, remoteness);
  }

  // 5. Category 04 with day only (no time band match), exclude group (0136)
  const fallbackDayOnly = db.prepare(`
    SELECT id, rate, rate_remote, rate_very_remote, unit, rate_type, time_band, description, support_item_number
    FROM ndis_line_items
    WHERE (support_category = '04' OR support_item_number LIKE '04_%')
      AND (rate_type = ? OR rate_type IS NULL OR rate_type = 'weekday')
      AND (unit = 'hour' OR unit = 'hr')
      AND (description NOT LIKE '%Establishment Fee%' AND description NOT LIKE '%establishment fee%')
      AND (description NOT LIKE '%group%' AND description NOT LIKE '%Group%')
      AND (support_item_number NOT LIKE '%_0136_%')
    ORDER BY (support_item_number LIKE '%_0125_%') DESC, rate_type = ? DESC
    LIMIT 1
  `).get(dayType, dayType);

  if (fallbackDayOnly && !isEstablishmentFee(fallbackDayOnly) && !isGroupActivity(fallbackDayOnly)) {
    return toResult(fallbackDayOnly, remoteness);
  }

  // 6. Any hourly item, excluding establishment fee and group (0136)
  const anyItem = db.prepare(`
    SELECT id, rate, rate_remote, rate_very_remote, unit, description, support_item_number
    FROM ndis_line_items
    WHERE (unit = 'hour' OR unit = 'hr') AND rate > 0
      AND (description NOT LIKE '%Establishment Fee%' AND description NOT LIKE '%establishment fee%')
      AND (description NOT LIKE '%group%' AND description NOT LIKE '%Group%')
      AND (support_item_number NOT LIKE '%_0136_%')
    ORDER BY (support_item_number LIKE '%_0125_%') DESC
    LIMIT 1
  `).get();

  return anyItem && !isGroupActivity(anyItem) ? toResult(anyItem, remoteness) : null;
}
