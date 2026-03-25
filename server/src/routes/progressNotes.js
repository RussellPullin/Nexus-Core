/**
 * Progress Notes API - receives progress notes from Progress Notes App.
 * Matches to shifts, populates line items, creates invoices.
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import {
  resolveParticipantByName,
  resolveStaffByName,
  parseSupportDate,
  buildDateTime,
  findMatchingShift
} from '../services/progressNoteMatcher.js';
import { scheduleMirrorShiftToNexusSupabase } from '../services/nexusPublicShiftsSync.service.js';
import { parseTravelKm, parseTravelTimeMinutes, populateShiftLineItems } from '../services/shiftLineItems.service.js';

const router = Router();

/**
 * POST /api/progress-notes
 * Receive a progress note from the Progress Notes App.
 * Body: {
 *   shift_date, staff_name, client_name, start_time, finish_time, duration,
 *   travel_km, travel_time_min, expenses, incidents, mood, session_details,
 *   shift_id? (optional CRM shift ID),
 *   participant_id?, staff_id? (optional - use instead of names)
 * }
 */
router.post('/', (req, res) => {
  try {
    const {
      shift_date,
      staff_name,
      client_name,
      start_time,
      finish_time,
      duration,
      travel_km,
      travel_time_min,
      incidents,
      mood,
      session_details,
      shift_id: explicitShiftId,
      participant_id: participantIdParam,
      staff_id: staffIdParam,
      source = 'progress_notes_app'
    } = req.body;

    if (!shift_date) {
      return res.status(400).json({ error: 'shift_date is required' });
    }

    let participantId = participantIdParam;
    let staffId = staffIdParam;

    if (!participantId && client_name) {
      const p = resolveParticipantByName(client_name);
      if (!p) {
        return res.status(400).json({ error: `Participant not found: ${client_name}` });
      }
      participantId = p.id;
    }
    if (!participantId) {
      return res.status(400).json({ error: 'client_name or participant_id is required' });
    }

    if (!staffId && staff_name) {
      const s = resolveStaffByName(staff_name);
      if (!s) {
        return res.status(400).json({ error: `Staff not found: ${staff_name}` });
      }
      staffId = s.id;
    }
    if (!staffId) {
      return res.status(400).json({ error: 'staff_name or staff_id is required' });
    }

    const supportDate = parseSupportDate(shift_date);
    if (!supportDate) {
      return res.status(400).json({ error: 'Invalid shift_date format (use DD/MM/YYYY or YYYY-MM-DD)' });
    }

    const startTimeStr = start_time || '09:00';
    const endTimeStr = finish_time || '17:00';
    const startDateTime = buildDateTime(shift_date, startTimeStr);
    const endDateTime = buildDateTime(shift_date, endTimeStr);

    let durationHours = duration;
    if (durationHours == null || durationHours === '') {
      const startMins = startTimeStr ? startTimeStr.match(/(\d+):(\d+)/) : null;
      const endMins = endTimeStr ? endTimeStr.match(/(\d+):(\d+)/) : null;
      if (startMins && endMins) {
        const s = parseInt(startMins[1], 10) * 60 + parseInt(startMins[2], 10);
        const e = parseInt(endMins[1], 10) * 60 + parseInt(endMins[2], 10);
        durationHours = Math.max(0, (e - s) / 60);
      } else {
        durationHours = 0;
      }
    }
    durationHours = typeof durationHours === 'number' ? durationHours : parseFloat(durationHours) || 0;
    if (durationHours > 24) {
      durationHours = durationHours / 60;
    }

    const matchingShift = findMatchingShift({
      participantId,
      staffId,
      supportDate,
      startTime: startTimeStr,
      endTime: endTimeStr,
      shiftId: explicitShiftId
    });

    let shiftId;
    let createdNewShift = false;

    if (matchingShift) {
      shiftId = matchingShift.id;
      db.prepare(`
        UPDATE shifts SET status = 'completed', notes = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        [matchingShift.notes || '', session_details || ''].filter(Boolean).join('\n\n'),
        shiftId
      );
    } else {
      createdNewShift = true;
      shiftId = uuidv4();
      db.prepare(`
        INSERT INTO shifts (id, participant_id, staff_id, start_time, end_time, notes, status)
        VALUES (?, ?, ?, ?, ?, ?, 'completed')
      `).run(
        shiftId,
        participantId,
        staffId,
        startDateTime || `${supportDate}T09:00:00`,
        endDateTime || `${supportDate}T17:00:00`,
        session_details || null,
        'completed'
      );
    }

    populateShiftLineItems(
      shiftId,
      participantId,
      durationHours,
      startDateTime || `${supportDate}T09:00:00`,
      endDateTime || `${supportDate}T17:00:00`,
      supportDate,
      travel_km,
      travel_time_min
    );

    const progressNoteId = uuidv4();
    db.prepare(`
      INSERT INTO progress_notes (
        id, shift_id, participant_id, staff_id, support_date,
        start_time, end_time, duration_hours, travel_km, travel_time_min,
        mood, session_details, incidents, source
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      progressNoteId,
      shiftId,
      participantId,
      staffId,
      supportDate,
      startTimeStr,
      endTimeStr,
      durationHours,
      travel_km != null && travel_km !== '' ? parseTravelKm(travel_km) : null,
      travel_time_min != null && travel_time_min !== '' ? parseTravelTimeMinutes(travel_time_min) : null,
      mood || null,
      session_details || null,
      incidents || null,
      source
    );

    // Invoicing is done via batch (Financial > Batch invoices); no per-shift invoice creation.

    scheduleMirrorShiftToNexusSupabase(shiftId);

    res.status(201).json({
      id: progressNoteId,
      shift_id: shiftId,
      invoice_id: null,
      created_new_shift: createdNewShift,
      duration_hours: durationHours
    });
  } catch (err) {
    console.error('Progress note error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/progress-notes
 * List progress notes with optional filters.
 */
router.get('/', (req, res) => {
  try {
    const { participant_id, staff_id, start, end } = req.query;
    let sql = `
      SELECT pn.*, p.name as participant_name, st.name as staff_name
      FROM progress_notes pn
      JOIN participants p ON pn.participant_id = p.id
      JOIN staff st ON pn.staff_id = st.id
      WHERE 1=1
    `;
    const params = [];
    if (participant_id) {
      sql += ' AND pn.participant_id = ?';
      params.push(participant_id);
    }
    if (staff_id) {
      sql += ' AND pn.staff_id = ?';
      params.push(staff_id);
    }
    if (start) {
      sql += ' AND pn.support_date >= ?';
      params.push(start);
    }
    if (end) {
      sql += ' AND pn.support_date <= ?';
      params.push(end);
    }
    sql += ' ORDER BY pn.support_date DESC, pn.created_at DESC';
    const notes = db.prepare(sql).all(...params);
    res.json(notes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/progress-notes/:id
 */
router.get('/:id', (req, res) => {
  try {
    const note = db.prepare(`
      SELECT pn.*, p.name as participant_name, st.name as staff_name
      FROM progress_notes pn
      JOIN participants p ON pn.participant_id = p.id
      JOIN staff st ON pn.staff_id = st.id
      WHERE pn.id = ?
    `).get(req.params.id);
    if (!note) return res.status(404).json({ error: 'Progress note not found' });
    res.json(note);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
