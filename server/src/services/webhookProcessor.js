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
  findShiftByShifterShiftIdForParticipant,
  findShiftByParticipantStaffAndStartTime
} from './progressNoteMatcher.js';
import { canImportMergeIntoShift } from './shiftInvoiceLink.service.js';
import { recordEvent } from './learningEvent.service.js';
import { updateAggregatesForShift } from './featureStore.service.js';
import { scheduleMirrorShiftToNexusSupabase } from './nexusPublicShiftsSync.service.js';
import { syncCaseNoteFromShift } from './shiftCaseNoteSync.service.js';
import { populateShiftLineItems } from './shiftLineItems.service.js';
import { resolveProgressNoteDurationHours } from '../lib/shiftDuration.js';
import { isShifterShiftIdSuppressedForOrg, isShifterShiftIdSuppressedGlobally } from './shiftImportSuppression.service.js';

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

function strNormForCompare(s) {
  if (s == null || s === '') return '';
  return String(s).trim();
}

/** Compare by wall-clock (YYYY-MM-DDTHH:mm); avoids :00 vs :00.000 mismatches. */
function isoDateTimeMinutePrefix(iso) {
  const s = strNormForCompare(iso);
  if (s.length >= 16) return s.slice(0, 16);
  return s;
}

function optFloatEqual(a, b) {
  const na = a == null || a === '' ? null : parseFloat(String(a));
  const nb = b == null || b === '' ? null : parseFloat(String(b));
  if (na == null && nb == null) return true;
  if (na == null || nb == null || !Number.isFinite(na) || !Number.isFinite(nb)) return false;
  return Math.abs(na - nb) < 0.0001;
}

function optIntEqual(a, b) {
  const na = a == null || a === '' ? null : parseInt(String(a), 10);
  const nb = b == null || b === '' ? null : parseInt(String(b), 10);
  if (na == null && nb == null) return true;
  if (na == null || nb == null || !Number.isFinite(na) || !Number.isFinite(nb)) return false;
  return na === nb;
}

/**
 * Shifter re-pull: skip the heavy path when this shift is already in Nexus and matches the payload.
 * Requires a stable shifter id + an existing progress note to compare against (avoids duplicating PNs on repeat imports).
 */
function isReimportPayloadUnchanged({
  existingRow,
  latestProgressNote,
  participantId,
  staffId,
  startDateTime,
  endDateTime,
  sessionDetails,
  expensesVal,
  travelKm,
  travelTimeMin,
  startTime,
  finishTime,
  mood,
  incidents,
}) {
  if (!existingRow) return false;
  if (existingRow.participant_id !== participantId || existingRow.staff_id !== staffId) return false;
  if (isoDateTimeMinutePrefix(existingRow.start_time) !== isoDateTimeMinutePrefix(startDateTime)) return false;
  if (isoDateTimeMinutePrefix(existingRow.end_time) !== isoDateTimeMinutePrefix(endDateTime)) return false;
  if (strNormForCompare(existingRow.notes) !== strNormForCompare(sessionDetails)) return false;
  const rowExp = Number.isFinite(Number(existingRow.expenses)) ? Number(existingRow.expenses) : 0;
  if (rowExp !== expensesVal) return false;
  if (!latestProgressNote) return false;
  if (!optFloatEqual(latestProgressNote.travel_km, travelKm)) return false;
  if (!optIntEqual(latestProgressNote.travel_time_min, travelTimeMin)) return false;
  if (strNormForCompare(latestProgressNote.session_details) !== strNormForCompare(sessionDetails)) return false;
  if (strNormForCompare(latestProgressNote.mood) !== strNormForCompare(mood)) return false;
  if (strNormForCompare(latestProgressNote.incidents) !== strNormForCompare(incidents)) return false;
  if (strNormForCompare(latestProgressNote.start_time) !== strNormForCompare(startTime)) return false;
  if (strNormForCompare(latestProgressNote.end_time) !== strNormForCompare(finishTime)) return false;
  return true;
}

/**
 * Did the worker actually deliver/complete this shift?
 *
 * Used to gate pull imports (Excel / Shifter Supabase) so that a scheduled shift which was
 * never actually worked is NOT flipped to 'completed' and then double-billed alongside the
 * real shift the worker separately logged for that day.
 *
 * Deliberately ignores start/end/duration: a scheduled placeholder row echoed back from the
 * roster carries those times even though no support was delivered. Evidence of delivery is
 * either an explicit completed signal from the source row, or worker-entered actuals
 * (a progress note, mood, incidents, travel, or expenses).
 *
 * @param {{ completed?: boolean, sessionDetails?: string|null, mood?: string|null,
 *   incidents?: string|null, travelKm?: any, travelTimeMin?: any, expensesVal?: number }} p
 * @returns {boolean}
 */
/**
 * True when the shift's start date is later than today (date-level comparison).
 * A shift that has not happened yet must never be auto-marked 'completed' (and therefore never
 * billed) on import — even if Shifter sends a completed-like status, a clock-out timestamp, or a
 * stray progress note. It stays 'scheduled' until its day arrives; a later re-sync (once the date
 * has passed and it was genuinely worked) flips it to completed.
 *
 * Uses UTC date which, for AU orgs (ahead of UTC), only ever errs toward keeping a shift scheduled
 * slightly longer — never toward completing one early.
 * @param {string} startDateTime
 * @returns {boolean}
 */
function isFutureShiftStart(startDateTime) {
  const datePart = String(startDateTime || '').replace(' ', 'T').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return false;
  const today = new Date().toISOString().slice(0, 10);
  return datePart > today;
}

function hasWorkerCompletionEvidence({ completed, sessionDetails, mood, incidents, travelKm, travelTimeMin, expensesVal }) {
  // Explicit signal from the source row (e.g. Shifter status / clock-out) wins both ways.
  if (completed === true) return true;
  if (completed === false) return false;
  if (sessionDetails && String(sessionDetails).trim()) return true;
  if (mood && String(mood).trim()) return true;
  if (incidents && String(incidents).trim()) return true;
  if (Number(travelKm) > 0) return true;
  if (Number(travelTimeMin) > 0) return true;
  if (Number(expensesVal) > 0) return true;
  return false;
}

/**
 * Process an array of shifts (from webhook or Excel).
 * @param {Array} shiftsArray - Shifts in webhook format
 * @param {object} options - { orgId, log, skipUnchanged?: boolean, requireCompletionEvidence?: boolean }.
 *   When skipUnchanged, matched shifts that already match Nexus (by shifter_shift_id + latest progress
 *   note) are not written again. When requireCompletionEvidence (used by Excel/Shifter pulls), a row with
 *   no proof of delivery is never created or flipped to 'completed' — any existing scheduled shift is left
 *   untouched so it cannot be billed.
 * @returns {{ processed, matched, unmatched, skipped, unchanged? }}
 */
export function processShifts(shiftsArray, options = {}) {
  const orgId = options.orgId ?? null;
  const skipUnchanged = !!options.skipUnchanged;
  const requireCompletionEvidence = !!options.requireCompletionEvidence;
  const log = options.log || console.log;
  const logWarn = options.logWarn || console.warn;
  const logError = options.logError || console.error;

  let processed = 0;
  let matched = 0;
  let unmatched = 0;
  let skipped = 0;
  let unchanged = 0;

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
    const rawStart = s.startTime ?? s.start_time;
    const rawFinish = s.finishTime ?? s.finish_time;
    const hasStart = rawStart != null && String(rawStart).trim() !== '';
    const hasFinish = rawFinish != null && String(rawFinish).trim() !== '';
    const startTime = String(rawStart ?? '').trim() || '09:00';
    const finishTime = String(rawFinish ?? '').trim() || '17:00';
    const duration = s.duration;
    const travelKm = s.travelKm ?? s.travel_km ?? null;
    const travelTimeMin = s.travelTimeMinutes ?? s.travel_time_minutes ?? s.travel_time_min ?? null;
    const expenses = s.expenses != null ? parseFloat(s.expenses) : null;
    const incidents = String(s.incidents ?? '').trim() || null;
    const mood = String(s.mood ?? '').trim() || null;
    const sessionDetails = String(s.sessionDetails ?? s.session_details ?? '').trim() || null;

    const participant = clientName ? resolveParticipantByName(clientName, null, orgId || null) : null;
    const staff = staffName ? resolveStaffByName(staffName, null, orgId || null) : null;

    if (!participant && clientName) {
      logWarn('Client not found in Nexus - add participant with matching name', { clientName });
    }
    if (!staff && staffName) {
      logWarn('Staff not found in Nexus - add staff with matching name', { staffName });
    }

    if (participant && staff) {
      const participantOrg =
        db.prepare('SELECT provider_org_id FROM participants WHERE id = ?').get(participant.id)?.provider_org_id || null;
      const staffOrg = db.prepare('SELECT org_id FROM staff WHERE id = ?').get(staff.id)?.org_id || null;
      const scopeOrg = orgId || participantOrg || staffOrg;
      if (scopeOrg && isShifterShiftIdSuppressedForOrg(scopeOrg, shiftId)) {
        skipped++;
        log('Skipped shift (suppressed after hard delete)', { shiftId, orgId: scopeOrg });
        continue;
      }
      if (!scopeOrg && isShifterShiftIdSuppressedGlobally(shiftId)) {
        skipped++;
        log('Skipped shift (suppressed globally; org unknown in payload)', { shiftId });
        continue;
      }
    }

    if (participant && staff) {
      try {
        const supportDate = parseSupportDate(dateStr) || dateStr;
        const startDateTime = buildDateTime(supportDate, startTime) || `${supportDate}T09:00:00`;
        const endDateTime = buildDateTime(supportDate, finishTime) || `${supportDate}T17:00:00`;

        const durationHours = resolveProgressNoteDurationHours({
          startTimeStr: startTime,
          endTimeStr: finishTime,
          explicitStart: hasStart,
          explicitEnd: hasFinish,
          duration
        });

        const expensesVal = Number.isFinite(expenses) ? expenses : 0;
        if (skipUnchanged && shiftId) {
          const byShifter = findShiftByShifterShiftIdForParticipant(shiftId, participant.id, staff.id);
          if (byShifter) {
            const byTime = findShiftByParticipantStaffAndStartTime(participant.id, staff.id, startDateTime);
            if (!byTime || byTime.id === byShifter.id) {
              const latestPn = db
                .prepare(
                  `SELECT travel_km, travel_time_min, session_details, mood, incidents, start_time, end_time
                   FROM progress_notes WHERE shift_id = ? ORDER BY created_at DESC LIMIT 1`,
                )
                .get(byShifter.id);
              if (
                isReimportPayloadUnchanged({
                  existingRow: byShifter,
                  latestProgressNote: latestPn,
                  participantId: participant.id,
                  staffId: staff.id,
                  startDateTime,
                  endDateTime,
                  sessionDetails,
                  expensesVal,
                  travelKm,
                  travelTimeMin,
                  startTime,
                  finishTime,
                  mood,
                  incidents,
                })
              ) {
                unchanged++;
                processed++;
                log('Skip unchanged re-import (already in Nexus; no write)', { shiftId });
                continue;
              }
            }
          }
        }

        // Prevent duplicate shifts: 1) same participant + staff + date + time (primary), 2) same import ID, 3) scheduled shift overlap.
        let matchingShift = findShiftByParticipantStaffAndStartTime(participant.id, staff.id, startDateTime);
        if (!matchingShift && shiftId) {
          matchingShift = findShiftByShifterShiftIdForParticipant(shiftId, participant.id, staff.id);
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
        if (matchingShift && !canImportMergeIntoShift(matchingShift, {
          participantId: participant.id,
          staffId: staff.id,
          startDateTime,
        })) {
          log('Import would overwrite billed shift with different participant/day — creating new shift', {
            shiftId,
            existing_shift_id: matchingShift.id,
            billing_invoice_id: matchingShift.billing_invoice_id,
          });
          matchingShift = null;
        }

        // Completion gate (pull sources only): never turn a scheduled-but-unworked shift into a
        // billable 'completed' shift. Without this, a scheduled shift echoed back from Shifter/Excel
        // gets marked completed and is billed alongside the real shift the worker logged → double billing.
        if (requireCompletionEvidence &&
            !hasWorkerCompletionEvidence({ completed: s.completed, sessionDetails, mood, incidents, travelKm, travelTimeMin, expensesVal })) {
          if (matchingShift) {
            const existingStatus = String(matchingShift.status || '').trim().toLowerCase();
            if (existingStatus === 'completed' || existingStatus === 'completed_by_admin') {
              unchanged++;
              log('Skipped re-import without completion evidence (already completed; left unchanged)', { shiftId });
            } else {
              skipped++;
              log('Skipped shift without completion evidence (left as scheduled; not billed)', {
                shiftId,
                status: matchingShift.status,
              });
            }
          } else {
            skipped++;
            log('Skipped shift without completion evidence (no delivery recorded)', { shiftId });
          }
          processed++;
          continue;
        }

        let resolvedShiftId;
        const shifterShiftId = shiftId || null;
        // A future-dated shift can't have been delivered yet: keep it scheduled (and uncharged)
        // regardless of any completed-like signal from Shifter.
        const startIsFuture = isFutureShiftStart(startDateTime);
        const importStatus = startIsFuture ? 'scheduled' : 'completed';
        if (matchingShift) {
          resolvedShiftId = matchingShift.id;
          const lockedByAdmin = String(matchingShift.status || '').trim().toLowerCase() === 'completed_by_admin';
          if (lockedByAdmin) {
            // Admin-edited shifts must remain authoritative. Imports should not overwrite participant/staff/times/notes/status.
            // We still capture the progress note, and we can backfill missing import linkage fields.
            const shouldBackfillShifterId =
              shifterShiftId &&
              (!matchingShift.shifter_shift_id || String(matchingShift.shifter_shift_id).trim() === '');
            const existingExpenses = Number.isFinite(Number(matchingShift.expenses)) ? Number(matchingShift.expenses) : 0;
            const shouldBackfillExpenses = existingExpenses <= 0 && expensesVal > 0;
            if (shouldBackfillShifterId || shouldBackfillExpenses) {
              db.prepare(`
                UPDATE shifts SET
                  shifter_shift_id = CASE
                    WHEN (shifter_shift_id IS NULL OR TRIM(shifter_shift_id) = '') THEN ?
                    ELSE shifter_shift_id
                  END,
                  expenses = CASE
                    WHEN (expenses IS NULL OR expenses <= 0) THEN ?
                    ELSE expenses
                  END,
                  updated_at = datetime('now')
                WHERE id = ?
              `).run(
                shouldBackfillShifterId ? shifterShiftId : (matchingShift.shifter_shift_id || null),
                shouldBackfillExpenses ? expensesVal : existingExpenses,
                resolvedShiftId
              );
            }
          } else {
            const participantChanged = String(matchingShift.participant_id) !== String(participant.id);
            const staffChanged = String(matchingShift.staff_id) !== String(staff.id);
            const existingDay = String(matchingShift.start_time || '').slice(0, 10);
            const incomingDay = String(startDateTime || '').slice(0, 10);
            const dateChanged = existingDay && incomingDay && existingDay !== incomingDay;
            const clearBilling =
              matchingShift.billing_invoice_id &&
              (participantChanged || staffChanged || dateChanged);
            // Update existing shift (full refresh when re-imported so participant/staff/times stay in sync)
            db.prepare(`
              UPDATE shifts SET
                participant_id = ?, staff_id = ?, start_time = ?, end_time = ?,
                status = ?, notes = ?, expenses = ?, shifter_shift_id = ?,
                billing_invoice_id = CASE WHEN ? THEN NULL ELSE billing_invoice_id END,
                updated_at = datetime('now')
              WHERE id = ?
            `).run(
              participant.id,
              staff.id,
              startDateTime,
              endDateTime,
              importStatus,
              sessionDetails || null,
              expensesVal,
              shifterShiftId,
              clearBilling ? 1 : 0,
              resolvedShiftId
            );
          }
        } else {
          resolvedShiftId = uuidv4();
          db.prepare(`
            INSERT INTO shifts (id, participant_id, staff_id, start_time, end_time, notes, status, expenses, shifter_shift_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(resolvedShiftId, participant.id, staff.id, startDateTime, endDateTime, sessionDetails || null, importStatus, expensesVal, shifterShiftId);
        }

        if (startIsFuture) {
          // Scheduled (not yet worked): leave it uncharged. Clear any charges a prior wrong import
          // may have built, unless a coordinator has manually curated them.
          const lockRow = db.prepare('SELECT line_items_locked FROM shifts WHERE id = ?').get(resolvedShiftId);
          if (!lockRow || Number(lockRow.line_items_locked) !== 1) {
            db.prepare('DELETE FROM shift_line_items WHERE shift_id = ?').run(resolvedShiftId);
          }
        } else {
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
        }

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
        syncCaseNoteFromShift(resolvedShiftId);

        // If this shift was previously stored as unmatched (app_shifts), remove it now that it is on the participant file.
        try {
          db.prepare('DELETE FROM app_shifts WHERE shift_id = ?').run(shiftId);
        } catch (e) {
          logWarn('Could not remove app_shifts row after match', { shiftId, message: e.message });
        }

        matched++;
      } catch (err) {
        logError('matched shift error:', err);
      }
    } else {
      try {
        const scopeUnmatched = orgId || null;
        if (scopeUnmatched && isShifterShiftIdSuppressedForOrg(scopeUnmatched, shiftId)) {
          skipped++;
          log('Skipped unmatched shift (suppressed after dismiss/hard delete)', { shiftId, orgId: scopeUnmatched });
        } else if (!scopeUnmatched && isShifterShiftIdSuppressedGlobally(shiftId)) {
          skipped++;
          log('Skipped unmatched shift (suppressed globally; org unknown in payload)', { shiftId });
        } else {
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
        }
      } catch (err) {
        logError('app_shifts insert error:', err);
      }
    }
    processed++;
  }

  return { processed, matched, unmatched, skipped, unchanged };
}
