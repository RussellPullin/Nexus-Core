/**
 * Progress Note Matcher - matches progress notes to shifts and resolves participant/staff by name.
 * Used when receiving progress notes from the Progress Notes App for invoicing and payroll.
 */
import { db } from '../db/index.js';
import { tenantParticipantClause } from '../lib/orgScopeSql.js';
import { getShiftDayType, getShiftTimeBand, getShiftLocalDateString, getShiftWallClockMinutes } from '../lib/ndisDay.js';
import { getEffectiveNdisRate } from '../lib/ndisRates.js';

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

/** Incoming start must be this close to an existing shift start to count as the same slot. */
const START_CLOSE_MIN = 60;
/** Late clock-in on the same roster slot (e.g. 16:00 roster, 18:00 start) still merges if they overlap. */
const LATE_START_MAX_MIN = 180;
const MIN_OVERLAP_FOR_LATE_START = 60;

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
 * @param {string | null} [userId] When set, only participants in that user's provider org are considered.
 * @param {string | null} [restrictToProviderOrgId] When set without userId (e.g. webhook/excel org scope), only this provider_org_id.
 * @returns {{ id: string } | null}
 */
export function resolveParticipantByName(clientName, userId = null, restrictToProviderOrgId = null) {
  const norm = normalizeName(clientName);
  if (!norm) return null;
  let participants;
  if (userId) {
    const c = tenantParticipantClause(userId, 'p');
    if (!c.orgId) return null;
    participants = db.prepare(`SELECT id, name FROM participants p WHERE (${c.sql})`).all(...c.params);
  } else if (restrictToProviderOrgId) {
    participants = db
      .prepare('SELECT id, name FROM participants WHERE provider_org_id = ?')
      .all(restrictToProviderOrgId);
  } else {
    participants = db.prepare('SELECT id, name FROM participants').all();
  }
  const match = participants.find((p) => normalizeName(p.name) === norm);
  if (match) return { id: match.id };
  // Fallback: partial match (e.g. "Kruise cupra" matches "Kruise Cupra")
  const partial = participants.find((p) => normalizeName(p.name).includes(norm) || norm.includes(normalizeName(p.name)));
  return partial ? { id: partial.id } : null;
}

/**
 * Resolve staff name to staff_id. Uses case-insensitive fuzzy match.
 * @param {string} staffName
 * @param {string | null} [userId] When set, only staff in that user's org are considered.
 * @param {string | null} [restrictToOrgId] When set without userId, only staff in this org_id.
 * @returns {{ id: string } | null}
 */
export function resolveStaffByName(staffName, userId = null, restrictToOrgId = null) {
  const norm = normalizeName(staffName);
  if (!norm) return null;
  let staff;
  if (userId) {
    const orgId = db.prepare('SELECT org_id FROM users WHERE id = ?').get(userId)?.org_id;
    if (!orgId) return null;
    staff = db.prepare('SELECT id, name FROM staff WHERE org_id = ?').all(orgId);
  } else if (restrictToOrgId) {
    staff = db.prepare('SELECT id, name FROM staff WHERE org_id = ?').all(restrictToOrgId);
  } else {
    staff = db.prepare('SELECT id, name FROM staff').all();
  }
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
export function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const s = String(timeStr).trim().replace(/'/g, '');
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hours = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  return hours * 60 + mins;
}

function shiftWallStartMinutes(shift) {
  if (!shift?.start_time) return null;
  return parseTimeToMinutes(String(shift.start_time).replace(' ', 'T').slice(11, 16));
}

function shiftWallEndMinutes(shift) {
  if (!shift?.end_time) return null;
  return parseTimeToMinutes(String(shift.end_time).replace(' ', 'T').slice(11, 16));
}

/** True when an external shifter_shift_id looks like a Shifter app UUID, not an Excel row number. */
export function looksLikeShifterUuid(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || '').trim());
}

export function shiftWallRangeMinutes(shift) {
  const start = shiftWallStartMinutes(shift);
  const end = shiftWallEndMinutes(shift);
  if (start == null || end == null) return null;
  return { start, end, duration: Math.max(0, end - start) };
}

export function overlapMinutes(a, b) {
  const ra = shiftWallRangeMinutes(a);
  const rb = shiftWallRangeMinutes(b);
  if (!ra || !rb) return 0;
  return Math.max(0, Math.min(ra.end, rb.end) - Math.max(ra.start, rb.start));
}

/**
 * Two roster rows are the same visit when they overlap in time — not merely touch at a
 * boundary (08:00–18:00 vs 18:00–20:30) and not a later evening after a morning gap.
 * A 16:00–17:00 stub inside a 16:00–20:30 slot counts as the same visit.
 */
export function shiftsAreSameVisit(a, b) {
  const o = overlapMinutes(a, b);
  if (o <= 0) return false;
  const da = shiftWallRangeMinutes(a)?.duration ?? 0;
  const durB = shiftWallRangeMinutes(b)?.duration ?? 0;
  const shorter = Math.min(da, durB);
  if (shorter <= 0) return false;
  return o >= Math.min(30, shorter) && o >= shorter * 0.5;
}

function duplicateKeeperScore(row) {
  if (!row) return -Infinity;
  const st = String(row.status || '').trim().toLowerCase();
  let score = 0;
  if (st === 'completed_by_admin') score += 1000;
  else if (st === 'completed') score += 500;
  if (looksLikeShifterUuid(row.shifter_shift_id)) score += 200;
  else if (row.shifter_shift_id && String(row.shifter_shift_id).trim()) score += 20;
  const dur = shiftWallRangeMinutes(row)?.duration ?? 0;
  score += Math.min(dur, 24 * 60) / 10;
  if (row.notes && String(row.notes).trim()) score += 25;
  if (row.recurring_group_id) score += 10;
  return score;
}

/** Prefer the Shifter UUID / longer / completed row when two copies of one visit exist. */
export function preferDuplicateKeeper(a, b) {
  if (!a) return b;
  if (!b) return a;
  return duplicateKeeperScore(a) >= duplicateKeeperScore(b) ? a : b;
}

function isCompletedLikeShift(row) {
  const st = String(row?.status || '').trim().toLowerCase();
  return st === 'completed' || st === 'completed_by_admin';
}

/**
 * Pick the same-day shift that is the same visit, not merely touching another slot.
 * A 08:00–18:00 completion must not merge into an 18:00–20:30 evening shift.
 *
 * @param {Array<object>} shifts
 * @param {string} startTime HH:mm
 * @param {string} endTime HH:mm
 * @returns {object | null}
 */
export function pickBestSameDayShiftMatch(shifts, startTime, endTime) {
  const noteStartMins = parseTimeToMinutes(startTime);
  const noteEndMins = parseTimeToMinutes(endTime);
  if (noteStartMins == null || !Array.isArray(shifts) || !shifts.length) return null;

  let best = null;
  for (const shift of shifts) {
    const shiftStart = shiftWallStartMinutes(shift);
    const shiftEnd = shiftWallEndMinutes(shift);
    if (shiftStart == null) continue;
    const startDelta = Math.abs(shiftStart - noteStartMins);
    const overlap =
      noteEndMins != null && shiftEnd != null
        ? Math.min(shiftEnd, noteEndMins) - Math.max(shiftStart, noteStartMins)
        : 0;
    const startClose = startDelta <= START_CLOSE_MIN;
    const lateSameSlot =
      overlap >= MIN_OVERLAP_FOR_LATE_START && startDelta <= LATE_START_MAX_MIN;
    if (!startClose && !lateSameSlot) continue;
    if (
      !best ||
      startDelta < best.startDelta ||
      (startDelta === best.startDelta && overlap > best.overlap)
    ) {
      best = { shift, startDelta, overlap };
    }
  }
  return best?.shift || null;
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

/**
 * Evening uplift from end time (after 20:00) applies on weekdays only.
 * Saturday, Sunday, and public holiday rates supersede evening for line-item matching.
 */
function getShiftTimeBandByStartAndEnd(shiftStartTime, shiftEndTime, dayType) {
  const premiumDay =
    dayType === 'saturday' || dayType === 'sunday' || dayType === 'public_holiday';
  if (!premiumDay) {
    const endMins = getShiftWallClockMinutes(shiftEndTime);
    if (endMins != null && endMins >= 20 * 60) {
      return 'evening';
    }
  }
  return getShiftTimeBand(shiftStartTime);
}

/**
 * Normalise shift datetime for slot matching (handles 'YYYY-MM-DD HH:MM' vs 'YYYY-MM-DDTHH:MM').
 * @param {string | null | undefined} t
 * @returns {string}
 */
export function normalizeShiftDateTimePrefix(t) {
  if (t == null) return '';
  return String(t).trim().replace(' ', 'T').slice(0, 16);
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
 * Find a shift by Shifter id scoped to the same participant and staff (avoids cross-client reuse).
 * @param {string} shifterShiftId
 * @param {string} participantId
 * @param {string} staffId
 * @returns {object | null}
 */
export function findShiftByShifterShiftIdForParticipant(shifterShiftId, participantId, staffId) {
  if (!shifterShiftId || !participantId || !staffId) return null;
  const id = String(shifterShiftId).trim();
  return (
    db
      .prepare(
        `
      SELECT * FROM shifts
      WHERE shifter_shift_id = ? AND participant_id = ? AND staff_id = ?
    `,
      )
      .get(id, participantId, staffId) || null
  );
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
  const prefix = normalizeShiftDateTimePrefix(startDateTime);
  if (prefix.length < 16) return null;
  const pattern = `${prefix}%`;
  return db.prepare(`
    SELECT * FROM shifts
    WHERE participant_id = ? AND staff_id = ?
      AND REPLACE(start_time, ' ', 'T') LIKE ?
    ORDER BY start_time LIMIT 1
  `).get(participantId, staffId, pattern) || null;
}

/**
 * Same participant, staff, start, and end (wall clock to the minute).
 * @param {string} participantId
 * @param {string} staffId
 * @param {string} startDateTime
 * @param {string} endDateTime
 * @returns {object | null}
 */
export function findShiftBySameSlot(participantId, staffId, startDateTime, endDateTime) {
  const byStart = findShiftByParticipantStaffAndStartTime(participantId, staffId, startDateTime);
  if (!byStart) return null;
  if (normalizeShiftDateTimePrefix(byStart.end_time) !== normalizeShiftDateTimePrefix(endDateTime)) {
    return null;
  }
  return byStart;
}

/**
 * Find a shift matching participant, staff, date, and time window.
 * Matches the same visit: start within 60 minutes, or a late start on an overlapping slot.
 * Does not merge a daytime completion into an evening shift that only touches at the boundary.
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
  const shifts = db.prepare(`
    SELECT * FROM shifts
    WHERE participant_id = ? AND staff_id = ?
      AND substr(REPLACE(start_time, ' ', 'T'), 1, 10) = ?
      AND status IN ('scheduled', 'completed', 'completed_by_admin')
  `).all(participantId, staffId, supportDate);

  let named = null;
  if (shiftId) {
    const sid = String(shiftId).trim();
    named =
      shifts.find((s) => String(s.shifter_shift_id || '').trim() === sid) ||
      db
        .prepare(
          `
      SELECT * FROM shifts
      WHERE shifter_shift_id = ? AND participant_id = ? AND staff_id = ?
    `,
        )
        .get(sid, participantId, staffId) ||
      db
        .prepare(
          `
      SELECT * FROM shifts
      WHERE id = ? AND participant_id = ? AND staff_id = ?
    `,
        )
        .get(sid, participantId, staffId) ||
      null;
  }

  const incoming = {
    start_time: `${supportDate}T${startTime}:00`,
    end_time: `${supportDate}T${endTime}:00`,
  };
  const best = pickBestSameDayShiftMatch(shifts, startTime, endTime);

  // Excel 319 and a Shifter UUID often sit on two overlapping roster rows for the same visit.
  // Prefer the already-completed / UUID row so we do not complete a second copy.
  const sameVisitPool = shifts.filter((s) => {
    if (named && s.id === named.id) return true;
    if (named) return shiftsAreSameVisit(s, named) || shiftsAreSameVisit(s, incoming);
    return shiftsAreSameVisit(s, incoming);
  });
  const completedSameVisit = sameVisitPool.filter((s) => isCompletedLikeShift(s));
  if (completedSameVisit.length) {
    return completedSameVisit.reduce((a, b) => preferDuplicateKeeper(a, b));
  }
  if (named && best && named.id !== best.id && shiftsAreSameVisit(named, best)) {
    return preferDuplicateKeeper(named, best);
  }
  if (named) return named;
  return best;
}

/**
 * Existing shift for the same worker + client that is the same visit (substantial overlap).
 * Used when creating roster/recurring rows so a 16:00–20:30 series cannot sit on top of a 16:00–17:00 stub.
 */
export function findOverlappingSameVisitShift(participantId, staffId, startDateTime, endDateTime) {
  if (!participantId || !staffId || !startDateTime || !endDateTime) return null;
  const date = normalizeShiftDateTimePrefix(startDateTime).slice(0, 10);
  if (date.length < 10) return null;
  const incoming = { start_time: startDateTime, end_time: endDateTime };
  const shifts = db
    .prepare(
      `
    SELECT * FROM shifts
    WHERE participant_id = ? AND staff_id = ?
      AND substr(REPLACE(start_time, ' ', 'T'), 1, 10) = ?
      AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'canceled')
  `,
    )
    .all(participantId, staffId, date);
  let best = null;
  for (const s of shifts) {
    if (!shiftsAreSameVisit(s, incoming)) continue;
    best = preferDuplicateKeeper(best, s);
  }
  return best;
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
  const timeBand = getShiftTimeBandByStartAndEnd(shiftStartTime, shiftEndTime, dayType);
  const dateStr = supportDate || getShiftLocalDateString(shiftStartTime) || new Date().toISOString().slice(0, 10);

  const toResult = (item, remoteness) => ({
    id: item.id,
    rate: Number(getEffectiveNdisRate(item, remoteness)) || 0,
    unit: (item.unit || 'hour').toLowerCase() === 'hr' ? 'hour' : (item.unit || 'hour')
  });

  const participant = db.prepare('SELECT default_ndis_line_item_id, default_billing_category, remoteness FROM participants WHERE id = ?').get(participantId);
  const remoteness = participant?.remoteness || 'standard';
  const preferredCat = /^\d{2}$/.test(participant?.default_billing_category) ? participant.default_billing_category : '04';

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
  const budgetOrder = [preferredCat, ...['04', '01', '02', '03', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15'].filter(c => c !== preferredCat)];
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
    WHERE (support_category = ? OR support_item_number LIKE ?)
      AND (rate_type = ? OR rate_type IS NULL OR rate_type = 'weekday')
      AND (time_band = ? OR time_band IS NULL)
      AND (unit = 'hour' OR unit = 'hr')
      AND (description NOT LIKE '%Establishment Fee%' AND description NOT LIKE '%establishment fee%')
      AND (description NOT LIKE '%group%' AND description NOT LIKE '%Group%')
      AND (support_item_number NOT LIKE '%_0136_%')
    ORDER BY (support_item_number LIKE '%_0125_%') DESC, rate_type = ? DESC
    LIMIT 1
  `).get(preferredCat, `${preferredCat}_%`, dayType, timeBand, dayType);

  if (fallback && !isEstablishmentFee(fallback) && !isGroupActivity(fallback)) {
    return toResult(fallback, remoteness);
  }

  // 5. Category 04 with day only (no time band match), exclude group (0136)
  const fallbackDayOnly = db.prepare(`
    SELECT id, rate, rate_remote, rate_very_remote, unit, rate_type, time_band, description, support_item_number
    FROM ndis_line_items
    WHERE (support_category = ? OR support_item_number LIKE ?)
      AND (rate_type = ? OR rate_type IS NULL OR rate_type = 'weekday')
      AND (unit = 'hour' OR unit = 'hr')
      AND (description NOT LIKE '%Establishment Fee%' AND description NOT LIKE '%establishment fee%')
      AND (description NOT LIKE '%group%' AND description NOT LIKE '%Group%')
      AND (support_item_number NOT LIKE '%_0136_%')
    ORDER BY (support_item_number LIKE '%_0125_%') DESC, rate_type = ? DESC
    LIMIT 1
  `).get(preferredCat, `${preferredCat}_%`, dayType, dayType);

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
