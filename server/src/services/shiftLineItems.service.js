/**
 * NDIS shift_line_items: support hours, provider travel time, participant travel km.
 * Shared by webhook/Excel sync and POST /api/progress-notes.
 */
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { getDefaultLineItemForParticipant, parseTimeToMinutes } from './progressNoteMatcher.js';
import { hoursBetweenIsoDateTimes } from '../lib/shiftDuration.js';

function latestProgressNoteMatchingShift(shiftId, shiftStartTime) {
  const notes = db
    .prepare(
      `SELECT participant_id, duration_hours, support_date, travel_km, travel_time_min, start_time
       FROM progress_notes
       WHERE shift_id = ?
       ORDER BY created_at DESC`
    )
    .all(shiftId);
  if (!notes.length) return null;
  const shiftMins = parseTimeToMinutes(String(shiftStartTime || '').replace(' ', 'T').slice(11, 16));
  if (shiftMins == null) return notes[0];
  const matching = notes.find((n) => {
    const noteMins = parseTimeToMinutes(n.start_time);
    return noteMins != null && Math.abs(noteMins - shiftMins) <= 60;
  });
  return matching || notes[0];
}

/** When set, Excel/Shifter pull and auto line-item builders skip replacing shift_line_items (coordinator edits preserved). */
function isShiftLineItemsLocked(shiftId) {
  if (!shiftId) return false;
  const row = db.prepare('SELECT line_items_locked FROM shifts WHERE id = ?').get(shiftId);
  return row != null && Number(row.line_items_locked) === 1;
}

/** Call after coordinator add/update/delete on shift charges via API. */
export function markShiftLineItemsManuallyEdited(shiftId) {
  if (!shiftId) return;
  db.prepare(`UPDATE shifts SET line_items_locked = 1, updated_at = datetime('now') WHERE id = ?`).run(shiftId);
}

/** When the last charge is removed, allow imports to populate charges again. */
export function syncShiftLineItemsLockedAfterDelete(shiftId) {
  if (!shiftId) return;
  const c = db.prepare('SELECT COUNT(*) as n FROM shift_line_items WHERE shift_id = ?').get(shiftId);
  const n = c && Number(c.n) === 0 ? 0 : 1;
  db.prepare(`UPDATE shifts SET line_items_locked = ?, updated_at = datetime('now') WHERE id = ?`).run(n, shiftId);
}

/**
 * Parse travel time from various formats: 60, "60", "60mins", "60 min", "1 hour", etc.
 * Returns minutes or 0 if unparseable.
 */
export function parseTravelTimeMinutes(val) {
  if (val == null || val === '') return 0;
  const str = String(val).trim().toLowerCase();
  if (!str) return 0;
  const num = parseInt(val, 10);
  if (Number.isFinite(num)) return Math.max(0, num);
  const minsMatch = str.match(/(\d+)\s*(?:min|mins|minute|minutes)?/);
  if (minsMatch) return Math.max(0, parseInt(minsMatch[1], 10));
  const hourMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:hr|hour|hours)/);
  if (hourMatch) return Math.round(parseFloat(hourMatch[1]) * 60);
  return 0;
}

/**
 * Parse travel km from various formats: 15, "15", "15km", "15.5", etc.
 */
export function parseTravelKm(val) {
  if (val == null || val === '') return 0;
  const str = String(val).trim().toLowerCase();
  if (!str) return 0;
  const num = parseFloat(val);
  if (Number.isFinite(num)) return Math.max(0, num);
  const match = str.match(/(\d+(?:\.\d+)?)\s*(?:km)?/);
  return match ? Math.max(0, parseFloat(match[1])) : 0;
}

/**
 * Get support category (01-15) from main line item. Excludes 07 (Support Coordination).
 */
function getMainItemMeta(mainLineItemId) {
  if (!mainLineItemId) return null;
  const row = db
    .prepare('SELECT support_item_number, support_category FROM ndis_line_items WHERE id = ?')
    .get(mainLineItemId);
  if (!row) return null;
  return {
    support_item_number: row.support_item_number || '',
    support_category: row.support_category || null
  };
}

function getTravelCategoryFromMainItemMeta(meta) {
  const supportItemNumber = meta?.support_item_number || '';
  const cat = meta?.support_category || supportItemNumber.slice(0, 2);
  if (cat && cat !== '07') return cat;
  return '04';
}

function getThirdCodeGroupFromSupportItemNumber(supportItemNumber) {
  const s = String(supportItemNumber || '').trim();
  // Expected format like 04_104_0125_6_1 (third group is 0125)
  const parts = s.split('_');
  const third = parts.length >= 3 ? parts[2] : '';
  return /^\d{4}$/.test(third) ? third : null;
}

/**
 * Get non-provider (activity / travel-with-participant) km line item for the same category and registration group.
 * 1) Explicit km-style items. 2) Activity Based Transport (e.g. 04_590_*). 3) Provider travel non-labour (XX_799) as last resort.
 */
function getNonProviderKmItemForCategory(cat, thirdCodeGroup) {
  if (!cat || cat === '07') return null;

  // Prefer an item that matches the SAME 3rd code group as the main line item (e.g. 0125).
  // This ensures travel-km charges align with the shift's support item variant.
  if (thirdCodeGroup) {
    const explicitKmMatchingThird = db
      .prepare(
        `
        SELECT id, rate FROM ndis_line_items
        WHERE support_item_number GLOB ?
          AND support_item_number NOT LIKE '%_799_%'
          AND support_item_number NOT LIKE '02_051%'
          AND (
            LOWER(unit) IN ('km', 'kilometre')
            OR LOWER(description) LIKE '%kilomet%'
            OR LOWER(description) LIKE '% km%'
            OR LOWER(description) LIKE '%km %'
            OR LOWER(description) LIKE '%/km%'
            OR LOWER(description) LIKE '%per km%'
          )
        ORDER BY support_item_number LIMIT 1
      `
      )
      .get(`${cat}_*_${thirdCodeGroup}_*`);
    if (explicitKmMatchingThird) return explicitKmMatchingThird;

    const activityTransportMatchingThird = db
      .prepare(
        `
        SELECT id, rate FROM ndis_line_items
        WHERE support_item_number GLOB ?
          AND LOWER(COALESCE(description, '')) LIKE '%activity based transport%'
          AND support_item_number NOT LIKE '%_799_%'
          AND support_item_number NOT LIKE '02_051%'
        ORDER BY support_item_number LIMIT 1
      `
      )
      .get(`${cat}_*_${thirdCodeGroup}_*`);
    if (activityTransportMatchingThird) return activityTransportMatchingThird;

    const fallback799MatchingThird = db
      .prepare(
        `
        SELECT id, rate FROM ndis_line_items
        WHERE support_item_number GLOB ?
          AND support_item_number LIKE '%_799_%'
          AND support_item_number NOT LIKE '02_051%'
          AND (LOWER(unit) = 'each' OR LOWER(description) LIKE '%travel%')
        ORDER BY support_item_number LIMIT 1
      `
      )
      .get(`${cat}_*_${thirdCodeGroup}_*`);
    if (fallback799MatchingThird) return fallback799MatchingThird;
  }

  const explicitKm = db.prepare(`
    SELECT id, rate FROM ndis_line_items
    WHERE support_item_number LIKE ? AND support_item_number NOT LIKE '%_799_%'
      AND support_item_number NOT LIKE '02_051%'
      AND (
        LOWER(unit) IN ('km', 'kilometre')
        OR LOWER(description) LIKE '%kilomet%'
        OR LOWER(description) LIKE '% km%'
        OR LOWER(description) LIKE '%km %'
        OR LOWER(description) LIKE '%/km%'
        OR LOWER(description) LIKE '%per km%'
      )
    ORDER BY support_item_number LIMIT 1
  `).get(cat + '_%');
  if (explicitKm) return explicitKm;

  const activityTransport = db.prepare(`
    SELECT id, rate FROM ndis_line_items
    WHERE support_item_number LIKE ?
      AND LOWER(COALESCE(description, '')) LIKE '%activity based transport%'
      AND support_item_number NOT LIKE '%_799_%'
      AND support_item_number NOT LIKE '02_051%'
    ORDER BY support_item_number LIMIT 1
  `).get(cat + '_%');
  if (activityTransport) return activityTransport;

  // Last resort: provider travel non-labour (799) if the catalogue has no activity-based or km-style row.
  return db.prepare(`
    SELECT id, rate FROM ndis_line_items
    WHERE support_item_number LIKE ?
      AND support_item_number LIKE '%_799_%'
      AND support_item_number NOT LIKE '02_051%'
      AND (LOWER(unit) = 'each' OR LOWER(description) LIKE '%travel%')
    ORDER BY support_item_number LIMIT 1
  `).get(cat + '_%');
}

/**
 * Populate shift_line_items for participant billing. Creates separate line items for:
 * - Support hours (main shift duration) - 1:1 community access, excludes group
 * - Travel time (if travelTimeMin > 0) - SAME line item as main support (provider travel)
 * - Travel KMs (if travelKm > 0) - Activity Based Transport (or explicit km) in same category as hourly rate; 799 only if no better match
 */
export function populateShiftLineItems(
  shiftId,
  participantId,
  durationHours,
  shiftStartTime,
  shiftEndTime,
  supportDate,
  travelKm,
  travelTimeMin
) {
  if (isShiftLineItemsLocked(shiftId)) return;
  db.prepare('DELETE FROM shift_line_items WHERE shift_id = ?').run(shiftId);
  const lineItems = [];

  const lineItem = getDefaultLineItemForParticipant(participantId, shiftStartTime, supportDate, shiftEndTime);
  if (lineItem && durationHours > 0) {
    lineItems.push({ ndisLineItemId: lineItem.id, quantity: durationHours, unitPrice: lineItem.rate, claimType: 'standard' });
  }

  const travelTimeMinVal = parseTravelTimeMinutes(travelTimeMin);
  if (travelTimeMinVal > 0 && lineItem) {
    const travelHours = Math.round((travelTimeMinVal / 60) * 100) / 100;
    lineItems.push({ ndisLineItemId: lineItem.id, quantity: travelHours, unitPrice: lineItem.rate, claimType: 'provider_travel' });
  }

  const travelKmVal = parseTravelKm(travelKm);
  if (travelKmVal > 0 && lineItem) {
    const meta = getMainItemMeta(lineItem.id);
    const cat = getTravelCategoryFromMainItemMeta(meta);
    const third = getThirdCodeGroupFromSupportItemNumber(meta?.support_item_number);
    const travelKmItem = getNonProviderKmItemForCategory(cat, third);
    if (travelKmItem) {
      const qty = Math.round(travelKmVal * 100) / 100;
      lineItems.push({ ndisLineItemId: travelKmItem.id, quantity: qty, unitPrice: travelKmItem.rate, claimType: 'participant_travel' });
    }
  }

  for (const li of lineItems) {
    db.prepare(`
      INSERT INTO shift_line_items (id, shift_id, ndis_line_item_id, quantity, unit_price, claim_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), shiftId, li.ndisLineItemId, li.quantity, li.unitPrice, li.claimType);
  }
}

/**
 * If shift_line_items already exist (e.g. legacy rows with hours only) but the linked progress note
 * has travel km/time, append missing provider_travel / participant_travel lines without duplicating.
 */
export function supplementShiftTravelLineItemsFromProgressNote(shiftId) {
  if (isShiftLineItemsLocked(shiftId)) return;
  const shiftForNote = db.prepare('SELECT start_time FROM shifts WHERE id = ?').get(shiftId);
  const progressNote = latestProgressNoteMatchingShift(shiftId, shiftForNote?.start_time);
  if (!progressNote) return;

  // Don't mutate historical billed shifts.
  const billed = db
    .prepare(`SELECT billing_invoice_id FROM shifts WHERE id = ?`)
    .get(shiftId);
  if (billed?.billing_invoice_id) return;

  const existing = db.prepare('SELECT claim_type FROM shift_line_items WHERE shift_id = ?').all(shiftId);
  const hasProviderTravel = existing.some((r) => r.claim_type === 'provider_travel');
  const hasParticipantTravel = existing.some((r) => r.claim_type === 'participant_travel');

  const shift = db.prepare('SELECT start_time, end_time FROM shifts WHERE id = ?').get(shiftId);
  const lineItem = getDefaultLineItemForParticipant(
    progressNote.participant_id,
    shift?.start_time,
    progressNote.support_date,
    shift?.end_time
  );
  if (!lineItem) return;

  const travelTimeMinVal = parseTravelTimeMinutes(progressNote.travel_time_min);
  if (travelTimeMinVal > 0 && !hasProviderTravel) {
    const travelHours = Math.round((travelTimeMinVal / 60) * 100) / 100;
    db.prepare(`
      INSERT INTO shift_line_items (id, shift_id, ndis_line_item_id, quantity, unit_price, claim_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), shiftId, lineItem.id, travelHours, lineItem.rate, 'provider_travel');
  }

  const travelKmVal = parseTravelKm(progressNote.travel_km);
  if (travelKmVal > 0) {
    const meta = getMainItemMeta(lineItem.id);
    const cat = getTravelCategoryFromMainItemMeta(meta);
    const third = getThirdCodeGroupFromSupportItemNumber(meta?.support_item_number);
    const travelKmItem = getNonProviderKmItemForCategory(cat, third);
    if (travelKmItem) {
      const qty = Math.round(travelKmVal * 100) / 100;
      if (!hasParticipantTravel) {
        db.prepare(`
          INSERT INTO shift_line_items (id, shift_id, ndis_line_item_id, quantity, unit_price, claim_type)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(uuidv4(), shiftId, travelKmItem.id, qty, travelKmItem.rate, 'participant_travel');
      } else {
        // If a participant_travel row exists but uses the wrong km item code, correct it in-place.
        const existingRows = db
          .prepare(
            `SELECT id, ndis_line_item_id
             FROM shift_line_items
             WHERE shift_id = ? AND claim_type = 'participant_travel'`
          )
          .all(shiftId);
        const needsUpdate = existingRows.some((r) => r.ndis_line_item_id !== travelKmItem.id);
        if (needsUpdate) {
          db.prepare(
            `UPDATE shift_line_items
             SET ndis_line_item_id = ?, unit_price = ?, quantity = ?
             WHERE shift_id = ? AND claim_type = 'participant_travel'`
          ).run(travelKmItem.id, travelKmItem.rate, qty, shiftId);
        }
      }
    }
  }
}

/**
 * Align shift_line_items with the latest linked progress note: full populate when empty,
 * or append missing travel lines when legacy data only had support hours.
 */
export function syncShiftLineItemsWithProgressNote(shiftId) {
  if (isShiftLineItemsLocked(shiftId)) return;
  const lineCount = db.prepare('SELECT COUNT(*) as c FROM shift_line_items WHERE shift_id = ?').get(shiftId);

  const progressNote = latestProgressNoteMatchingShift(shiftId, db.prepare('SELECT start_time FROM shifts WHERE id = ?').get(shiftId)?.start_time);
  if (!progressNote) return;

  const shift = db.prepare('SELECT start_time, end_time FROM shifts WHERE id = ?').get(shiftId);
  const shiftStart = shift?.start_time;
  const shiftEnd = shift?.end_time;

  if (lineCount.c === 0) {
    const fromShiftTimes = hoursBetweenIsoDateTimes(shiftStart, shiftEnd);
    const durationHours =
      fromShiftTimes != null ? fromShiftTimes : (parseFloat(progressNote.duration_hours) || 0);
    populateShiftLineItems(
      shiftId,
      progressNote.participant_id,
      durationHours,
      shiftStart,
      shiftEnd,
      progressNote.support_date,
      progressNote.travel_km,
      progressNote.travel_time_min
    );
    return;
  }

  supplementShiftTravelLineItemsFromProgressNote(shiftId);
}

/**
 * Rebuild shift_line_items from the current shift row (start/end, participant) and the latest
 * progress note (travel km / time). Use after admin edits in Nexus so billing quantities and
 * day/time-based NDIS line items stay aligned.
 * Does nothing (returns skipped) if the shift is already on a billing invoice. Clears line items
 * for cancelled shifts.
 * @param {string} shiftId
 * @returns {{ ok: boolean, skipped?: string, recalculated?: boolean, cleared?: boolean }}
 */
export function recalculateShiftLineItemsFromShift(shiftId) {
  if (!shiftId) return { ok: false, skipped: 'no_id' };
  const shift = db
    .prepare(
      `SELECT s.id, s.participant_id, s.start_time, s.end_time, s.billing_invoice_id, s.status, s.line_items_locked,
         (SELECT 1 FROM invoices i WHERE i.shift_id = s.id LIMIT 1) AS has_legacy_invoice
       FROM shifts s WHERE s.id = ?`
    )
    .get(shiftId);
  if (!shift) return { ok: false, skipped: 'not_found' };

  const billed = shift.billing_invoice_id != null && String(shift.billing_invoice_id).trim() !== '';
  if (billed || shift.has_legacy_invoice) {
    return { ok: false, skipped: 'billed' };
  }

  const st = String(shift.status || '').toLowerCase();
  if (st === 'cancelled' || st === 'canceled') {
    db.prepare('DELETE FROM shift_line_items WHERE shift_id = ?').run(shiftId);
    db.prepare(`UPDATE shifts SET line_items_locked = 0, updated_at = datetime('now') WHERE id = ?`).run(shiftId);
    return { ok: true, cleared: true };
  }

  if (Number(shift.line_items_locked) === 1) {
    return { ok: false, skipped: 'line_items_locked' };
  }

  const fromShift = hoursBetweenIsoDateTimes(shift.start_time, shift.end_time);
  const durationHours = fromShift != null ? fromShift : 0;

  const supportDateFromShift =
    shift.start_time && String(shift.start_time).length >= 10
      ? String(shift.start_time).replace(' ', 'T').slice(0, 10)
      : null;

  const pn = latestProgressNoteMatchingShift(shiftId, shift.start_time);

  const supportDate = supportDateFromShift || pn?.support_date || new Date().toISOString().slice(0, 10);

  populateShiftLineItems(
    shiftId,
    shift.participant_id,
    durationHours,
    shift.start_time,
    shift.end_time,
    supportDate,
    pn?.travel_km ?? null,
    pn?.travel_time_min ?? null
  );
  return { ok: true, recalculated: true };
}
