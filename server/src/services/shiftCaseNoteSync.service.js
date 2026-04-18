/**
 * Mirror completed shift session notes into participant case_notes for quarterly reporting and CRM visibility.
 */
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';

const DONE_STATUSES = new Set(['completed', 'completed_by_admin']);

/** Contact type stored for auto-synced rows (also shown in participant Case Notes UI). */
export const SHIFT_CASE_NOTE_CONTACT_TYPE = 'support_shift';

function contactDateFromShiftStart(startTime) {
  if (!startTime) return new Date().toISOString().slice(0, 10);
  const s = String(startTime);
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

/**
 * Upsert or remove the case_note row linked to this shift (one row per shift_id).
 */
export function syncCaseNoteFromShift(shiftId) {
  const shift = db
    .prepare('SELECT id, participant_id, start_time, notes, status FROM shifts WHERE id = ?')
    .get(shiftId);
  if (!shift) return;

  const existing = db.prepare('SELECT id FROM case_notes WHERE shift_id = ?').get(shiftId);

  const notes = String(shift.notes || '').trim();
  const shouldMirror = DONE_STATUSES.has(shift.status) && notes.length > 0;

  if (!shouldMirror) {
    if (existing) {
      db.prepare('DELETE FROM case_notes WHERE id = ?').run(existing.id);
    }
    return;
  }

  const contactDate = contactDateFromShiftStart(shift.start_time);

  if (existing) {
    db.prepare(
      `UPDATE case_notes SET participant_id = ?, notes = ?, contact_date = ?, contact_type = ?
       WHERE id = ?`
    ).run(shift.participant_id, notes, contactDate, SHIFT_CASE_NOTE_CONTACT_TYPE, existing.id);
  } else {
    const id = uuidv4();
    db.prepare(
      `INSERT INTO case_notes (id, participant_id, contact_type, notes, contact_date, goal_id, shift_id)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`
    ).run(
      id,
      shift.participant_id,
      SHIFT_CASE_NOTE_CONTACT_TYPE,
      notes,
      contactDate,
      shiftId
    );
  }
}
