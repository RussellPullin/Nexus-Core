/**
 * Shared processor for shifts from Progress Notes App (webhook payload or Excel pull).
 * Used by both /api/webhooks/progress-app and /api/sync/from-excel.
 */
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import {
  resolveParticipantByName,
  resolveStaffByName,
  parseSupportDate,
  buildDateTime,
  findMatchingShift,
  findShiftByShifterShiftId,
  findShiftByParticipantStaffAndStartTime
} from './progressNoteMatcher.js';
import { recordEvent } from './learningEvent.service.js';
import { updateAggregatesForShift } from './featureStore.service.js';
import { scheduleMirrorShiftToNexusSupabase } from './nexusPublicShiftsSync.service.js';
import { populateShiftLineItems } from './shiftLineItems.service.js';

function normNameShifts(n) {
  return String(n || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Same logical shift twice in one payload (e.g. Excel duplicate rows) → process once (last row wins).
 */
function dedupeIncomingShifts(shiftsArray) {
  if (!shiftsArray?.length) return shiftsArray;
  const withoutId = shiftsArray.filter((s) => !String(s.shiftId ?? s.shift_id ?? '').trim());
  const withId = shiftsArray.filter((s) => String(s.shiftId ?? s.shift_id ?? '').trim());
  if (withId.length === 0) return shiftsArray;

  const byShiftId = new Map();
  for (const s of withId) {
    const id = String(s.shiftId ?? s.shift_id ?? '').trim();
    byShiftId.set(id, s);
  }
  const slotKey = (s) => {
    const staff = normNameShifts(s.staffName ?? s.staff_name);
    const client = normNameShifts(s.clientName ?? s.client_name);
    const date = String(s.date ?? '').trim();
    const st = String(s.startTime ?? s.start_time ?? '').trim();
    const ft = String(s.finishTime ?? s.finish_time ?? '').trim();
    return `${staff}|${client}|${date}|${st}|${ft}`;
  };
  const bySlot = new Map();
  for (const s of withId) {
    const id = String(s.shiftId ?? s.shift_id ?? '').trim();
    const date = String(s.date ?? '').trim();
    if (!date) continue;
    if (byShiftId.get(id) !== s) continue;
    bySlot.set(slotKey(s), s);
  }
  return [...Array.from(bySlot.values()), ...withoutId];
}

/**
 * Process an array of shifts (from webhook or Excel).
 * @param {Array} shiftsArray - Shifts in webhook format
 * @param {object} options - { orgId, log }
 * @returns {{ processed, matched, unmatched, skipped }}
 */
export function processShifts(shiftsArray, options = {}) {
  const orgId = options.orgId ?? null;
  const log = options.log || console.log;
  const logWarn = options.logWarn || console.warn;
  const logError = options.logError || console.error;

  let processed = 0;
  let matched = 0;
  let unmatched = 0;
  let skipped = 0;

  const deduped = dedupeIncomingShifts(shiftsArray);
  if (deduped.length < shiftsArray.length) {
    log('Deduplicated incoming shifts', { before: shiftsArray.length, after: deduped.length });
  }

  for (const s of deduped) {
    const shiftId = String(s.shiftId ?? s.shift_id ?? '').trim();
    const dateStr = String(s.date ?? '').trim();
    if (!shiftId || !dateStr) {
      skipped++;
      logWarn('Skipped shift (missing shiftId or date)', { shiftId: shiftId || '(empty)', date: dateStr || '(empty)' });
      continue;
    }

    const staffName = String(s.staffName ?? s.staff_name ?? '').trim();
    const clientName = String(s.clientName ?? s.client_name ?? '').trim();
    const startTime = String(s.startTime ?? s.start_time ?? '').trim() || '09:00';
    const finishTime = String(s.finishTime ?? s.finish_time ?? '').trim() || '17:00';
    const duration = s.duration;
    const travelKm = s.travelKm ?? s.travel_km ?? null;
    const travelTimeMin = s.travelTimeMinutes ?? s.travel_time_minutes ?? s.travel_time_min ?? null;
    const expenses = s.expenses != null ? parseFloat(s.expenses) : null;
    const incidents = String(s.incidents ?? '').trim() || null;
    const mood = String(s.mood ?? '').trim() || null;
    const sessionDetails = String(s.sessionDetails ?? s.session_details ?? '').trim() || null;

    const participant = clientName ? resolveParticipantByName(clientName) : null;
    const staff = staffName ? resolveStaffByName(staffName) : null;

    if (!participant && clientName) {
      logWarn('Client not found in Nexus - add participant with matching name', { clientName });
    }
    if (!staff && staffName) {
      logWarn('Staff not found in Nexus - add staff with matching name', { staffName });
    }

    if (participant && staff) {
      try {
        const supportDate = parseSupportDate(dateStr) || dateStr;
        const startDateTime = buildDateTime(supportDate, startTime) || `${supportDate}T09:00:00`;
        const endDateTime = buildDateTime(supportDate, finishTime) || `${supportDate}T17:00:00`;

        let durationHours = duration;
        if (durationHours == null || durationHours === '') {
          const startMins = startTime.match(/(\d+):(\d+)/);
          const endMins = finishTime.match(/(\d+):(\d+)/);
          if (startMins && endMins) {
            const sm = parseInt(startMins[1], 10) * 60 + parseInt(startMins[2], 10);
            const em = parseInt(endMins[1], 10) * 60 + parseInt(endMins[2], 10);
            durationHours = Math.max(0, (em - sm) / 60);
          } else {
            durationHours = 0;
          }
        }
        durationHours = typeof durationHours === 'number' ? durationHours : parseFloat(durationHours) || 0;
        if (durationHours > 24) durationHours = durationHours / 60;

        // Prevent duplicate shifts: 1) same participant + staff + date + time (primary), 2) same import ID, 3) scheduled shift overlap.
        let matchingShift = findShiftByParticipantStaffAndStartTime(participant.id, staff.id, startDateTime);
        if (!matchingShift && shiftId) {
          matchingShift = findShiftByShifterShiftId(shiftId);
        }
        if (!matchingShift) {
          matchingShift = findMatchingShift({
            participantId: participant.id,
            staffId: staff.id,
            supportDate,
            startTime,
            endTime: finishTime,
            shiftId: shiftId || undefined
          });
        }

        let resolvedShiftId;
        const expensesVal = Number.isFinite(expenses) ? expenses : 0;
        const shifterShiftId = shiftId || null;
        if (matchingShift) {
          resolvedShiftId = matchingShift.id;
          // Update existing shift (full refresh when re-imported so participant/staff/times stay in sync)
          db.prepare(`
            UPDATE shifts SET
              participant_id = ?, staff_id = ?, start_time = ?, end_time = ?,
              status = 'completed', notes = ?, expenses = ?, shifter_shift_id = ?,
              updated_at = datetime('now')
            WHERE id = ?
          `).run(
            participant.id,
            staff.id,
            startDateTime,
            endDateTime,
            sessionDetails || null,
            expensesVal,
            shifterShiftId,
            resolvedShiftId
          );
        } else {
          resolvedShiftId = uuidv4();
          db.prepare(`
            INSERT INTO shifts (id, participant_id, staff_id, start_time, end_time, notes, status, expenses, shifter_shift_id)
            VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)
          `).run(resolvedShiftId, participant.id, staff.id, startDateTime, endDateTime, sessionDetails || null, expensesVal, shifterShiftId);
        }

        populateShiftLineItems(
          resolvedShiftId,
          participant.id,
          durationHours,
          startDateTime,
          endDateTime,
          supportDate,
          travelKm,
          travelTimeMin
        );

        const progressNoteId = uuidv4();
        db.prepare(`
          INSERT INTO progress_notes (
            id, shift_id, participant_id, staff_id, support_date,
            start_time, end_time, duration_hours, travel_km, travel_time_min,
            mood, session_details, incidents, source
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'progress_notes_app')
        `).run(
          progressNoteId,
          resolvedShiftId,
          participant.id,
          staff.id,
          supportDate,
          startTime,
          finishTime,
          durationHours,
          travelKm != null ? parseFloat(travelKm) : null,
          travelTimeMin != null ? parseInt(travelTimeMin, 10) : null,
          mood || null,
          sessionDetails || null,
          incidents || null
        );

        // Invoicing is done via batch (Financial > Batch invoices); no per-shift invoice creation.

        try {
          recordEvent({
            event_type: 'shift_created',
            participant_id: participant.id, staff_id: staff.id, shift_id: resolvedShiftId,
            date: supportDate, start_time: startTime, end_time: finishTime,
            metadata: { source: 'progress_notes_app' }
          });
          updateAggregatesForShift({
            participant_id: participant.id, staff_id: staff.id,
            day_of_week: new Date(supportDate).getDay(),
            start_time: startTime, end_time: finishTime,
            shift_type: 'standard',
            line_items: []
          });
        } catch (le) { console.warn('[webhookProcessor] learning event error:', le.message); }

        scheduleMirrorShiftToNexusSupabase(resolvedShiftId);
        matched++;
      } catch (err) {
        logError('matched shift error:', err);
      }
    } else {
      try {
        const expensesVal = Number.isFinite(expenses) ? expenses : 0;
        db.prepare(`
          INSERT OR REPLACE INTO app_shifts (
            shift_id, date, staff_name, client_name, start_time, finish_time,
            duration, travel_km, travel_time_minutes, expenses, incidents, mood, session_details,
            goals_worked_towards, medication_checks, source_org_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          shiftId,
          dateStr,
          staffName,
          clientName,
          startTime,
          finishTime,
          duration ?? null,
          travelKm,
          travelTimeMin,
          expensesVal,
          incidents,
          mood,
          sessionDetails,
          String(s.goalsWorkedTowards ?? s.goals_worked_towards ?? '').trim() || null,
          JSON.stringify(s.medicationChecks ?? s.medication_checks ?? {}),
          orgId
        );
        unmatched++;
      } catch (err) {
        logError('app_shifts insert error:', err);
      }
    }
    processed++;
  }

  return { processed, matched, unmatched, skipped };
}
