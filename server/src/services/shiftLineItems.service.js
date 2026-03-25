/**
 * NDIS shift_line_items: support hours, provider travel time, participant travel km.
 * Shared by webhook/Excel sync and POST /api/progress-notes.
 */
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { getDefaultLineItemForParticipant } from './progressNoteMatcher.js';

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
function getTravelCategoryFromMainItem(mainLineItemId) {
  if (!mainLineItemId) return '04';
  const row = db.prepare('SELECT support_item_number, support_category FROM ndis_line_items WHERE id = ?').get(mainLineItemId);
  if (!row) return '04';
  const cat = row.support_category || (row.support_item_number || '').slice(0, 2);
  if (cat && cat !== '07') return cat;
  return '04';
}

/**
 * Get non-provider (travel-with-participant) km line item linked to the same category as the hourly rate.
 * First preference: explicit km/kilometre items (excluding 02_051 and XX_799).
 * Fallback: XX_799 non-labour travel item (unit each) because many catalogues only include this for travel.
 */
function getNonProviderKmItemForCategory(cat) {
  if (!cat || cat === '07') return null;

  const explicitKm = db.prepare(`
    SELECT id, rate FROM ndis_line_items
    WHERE support_item_number LIKE ? AND support_item_number NOT LIKE '%_799_%'
      AND support_item_number NOT LIKE '02_051%'
      AND (unit = 'km' OR unit = 'kilometre' OR description LIKE '%travel%')
    ORDER BY support_item_number LIMIT 1
  `).get(cat + '_%');
  if (explicitKm) return explicitKm;

  // Fallback for price books that only contain provider-travel non-labour entries.
  return db.prepare(`
    SELECT id, rate FROM ndis_line_items
    WHERE support_item_number LIKE ?
      AND support_item_number LIKE '%_799_%'
      AND support_item_number NOT LIKE '02_051%'
      AND (unit = 'each' OR description LIKE '%travel%')
    ORDER BY support_item_number LIMIT 1
  `).get(cat + '_%');
}

/**
 * Populate shift_line_items for participant billing. Creates separate line items for:
 * - Support hours (main shift duration) - 1:1 community access, excludes group
 * - Travel time (if travelTimeMin > 0) - SAME line item as main support (provider travel)
 * - Travel KMs (if travelKm > 0) - Non-provider km charge in same category as hourly rate (not 02_051, not XX_799)
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
    const cat = getTravelCategoryFromMainItem(lineItem.id);
    const travelKmItem = getNonProviderKmItemForCategory(cat);
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
  const progressNote = db.prepare(`
    SELECT participant_id, support_date, travel_km, travel_time_min
    FROM progress_notes
    WHERE shift_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(shiftId);
  if (!progressNote) return;

  const existing = db.prepare('SELECT claim_type FROM shift_line_items WHERE shift_id = ?').all(shiftId);
  const hasProviderTravel = existing.some((r) => r.claim_type === 'provider_travel');
  const hasParticipantTravel = existing.some((r) => r.claim_type === 'participant_travel');
  if (hasProviderTravel && hasParticipantTravel) return;

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
  if (travelKmVal > 0 && !hasParticipantTravel) {
    const cat = getTravelCategoryFromMainItem(lineItem.id);
    const travelKmItem = getNonProviderKmItemForCategory(cat);
    if (travelKmItem) {
      const qty = Math.round(travelKmVal * 100) / 100;
      db.prepare(`
        INSERT INTO shift_line_items (id, shift_id, ndis_line_item_id, quantity, unit_price, claim_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), shiftId, travelKmItem.id, qty, travelKmItem.rate, 'participant_travel');
    }
  }
}

/**
 * Align shift_line_items with the latest linked progress note: full populate when empty,
 * or append missing travel lines when legacy data only had support hours.
 */
export function syncShiftLineItemsWithProgressNote(shiftId) {
  const lineCount = db.prepare('SELECT COUNT(*) as c FROM shift_line_items WHERE shift_id = ?').get(shiftId);

  const progressNote = db.prepare(`
    SELECT participant_id, duration_hours, support_date, travel_km, travel_time_min
    FROM progress_notes
    WHERE shift_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(shiftId);
  if (!progressNote) return;

  const shift = db.prepare('SELECT start_time, end_time FROM shifts WHERE id = ?').get(shiftId);
  const shiftStart = shift?.start_time;
  const shiftEnd = shift?.end_time;

  if (lineCount.c === 0) {
    populateShiftLineItems(
      shiftId,
      progressNote.participant_id,
      progressNote.duration_hours || 0,
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
