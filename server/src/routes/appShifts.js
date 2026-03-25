/**
 * App shifts - shifts from Progress Notes App webhook (unmatched participant/staff).
 * Shown in Coordinator Tasks as "Shifts from App".
 * Supports linking (resolving) to real staff/participants and creating new ones inline.
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { getProviderOrgIdForUser } from '../middleware/roles.js';
import { processShifts } from '../services/webhookProcessor.js';

const router = Router();

router.get('/', (req, res) => {
  try {
    const { date, from_date, to_date } = req.query;
    let sql = 'SELECT * FROM app_shifts WHERE 1=1';
    const params = [];

    if (date) {
      sql += ' AND date = ?';
      params.push(date);
    } else if (from_date && to_date) {
      sql += ' AND date >= ? AND date <= ?';
      params.push(from_date, to_date);
    }

    sql += ' ORDER BY date DESC, start_time ASC';
    const shifts = db.prepare(sql).all(...params);
    res.json(shifts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /:shift_id - update staff_name / client_name on an unmatched shift.
 */
router.put('/:shift_id', (req, res) => {
  try {
    const { shift_id } = req.params;
    const row = db.prepare('SELECT * FROM app_shifts WHERE shift_id = ?').get(shift_id);
    if (!row) return res.status(404).json({ error: 'App shift not found' });

    const { staff_name, client_name } = req.body;
    if (staff_name !== undefined) {
      db.prepare('UPDATE app_shifts SET staff_name = ?, updated_at = datetime(\'now\') WHERE shift_id = ?').run(staff_name, shift_id);
    }
    if (client_name !== undefined) {
      db.prepare('UPDATE app_shifts SET client_name = ?, updated_at = datetime(\'now\') WHERE shift_id = ?').run(client_name, shift_id);
    }

    const updated = db.prepare('SELECT * FROM app_shifts WHERE shift_id = ?').get(shift_id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /:shift_id/resolve - link an unmatched shift to a staff + participant.
 * Accepts { staff_id, participant_id } (existing) OR { new_staff: { name }, new_participant: { name } }.
 * Re-processes the shift through the matched flow, then deletes it from app_shifts.
 */
router.post('/:shift_id/resolve', (req, res) => {
  try {
    const { shift_id } = req.params;
    const row = db.prepare('SELECT * FROM app_shifts WHERE shift_id = ?').get(shift_id);
    if (!row) return res.status(404).json({ error: 'App shift not found' });

    let { staff_id, participant_id, new_staff, new_participant } = req.body;

    if (new_staff?.name) {
      const id = uuidv4();
      db.prepare('INSERT INTO staff (id, name, email, phone, notify_email, notify_sms) VALUES (?, ?, ?, ?, 1, 0)')
        .run(id, new_staff.name.trim(), new_staff.email || null, new_staff.phone || null);
      staff_id = id;
    }

    if (new_participant?.name) {
      const id = uuidv4();
      const providerOrgId = getProviderOrgIdForUser(req.session?.user?.id);
      if (providerOrgId) {
        db.prepare(
          'INSERT INTO participants (id, name, ndis_number, email, phone, provider_org_id) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(
          id,
          new_participant.name.trim(),
          new_participant.ndis_number || null,
          new_participant.email || null,
          new_participant.phone || null,
          providerOrgId
        );
      } else {
        db.prepare('INSERT INTO participants (id, name, ndis_number, email, phone) VALUES (?, ?, ?, ?, ?)')
          .run(id, new_participant.name.trim(), new_participant.ndis_number || null, new_participant.email || null, new_participant.phone || null);
      }
      participant_id = id;
    }

    if (!staff_id || !participant_id) {
      return res.status(400).json({ error: 'Provide staff_id and participant_id, or new_staff/new_participant to create them.' });
    }

    const staffRow = db.prepare('SELECT id, name FROM staff WHERE id = ?').get(staff_id);
    const partRow = db.prepare('SELECT id, name FROM participants WHERE id = ?').get(participant_id);
    if (!staffRow) return res.status(400).json({ error: 'Staff not found' });
    if (!partRow) return res.status(400).json({ error: 'Participant not found' });

    const shiftPayload = [{
      shiftId: row.shift_id,
      date: row.date,
      staffName: staffRow.name,
      clientName: partRow.name,
      startTime: row.start_time,
      finishTime: row.finish_time,
      duration: row.duration,
      travelKm: row.travel_km,
      travelTimeMinutes: row.travel_time_minutes,
      expenses: row.expenses != null ? parseFloat(row.expenses) : 0,
      incidents: row.incidents,
      mood: row.mood,
      sessionDetails: row.session_details,
      goalsWorkedTowards: row.goals_worked_towards,
      medicationChecks: row.medication_checks ? JSON.parse(row.medication_checks) : {}
    }];

    const result = processShifts(shiftPayload, { orgId: row.source_org_id });

    if (result.matched > 0) {
      db.prepare('DELETE FROM app_shifts WHERE shift_id = ?').run(shift_id);
    }

    res.json({
      ok: true,
      ...result,
      staff: { id: staffRow.id, name: staffRow.name },
      participant: { id: partRow.id, name: partRow.name }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /:shift_id - dismiss/remove an unmatched shift.
 */
router.delete('/:shift_id', (req, res) => {
  try {
    const { shift_id } = req.params;
    const row = db.prepare('SELECT * FROM app_shifts WHERE shift_id = ?').get(shift_id);
    if (!row) return res.status(404).json({ error: 'App shift not found' });
    db.prepare('DELETE FROM app_shifts WHERE shift_id = ?').run(shift_id);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
