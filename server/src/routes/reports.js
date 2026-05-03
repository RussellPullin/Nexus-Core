/**
 * Roster and operational reports.
 */

import { Router } from 'express';
import { db } from '../db/index.js';
import { tenantParticipantAndStaffClause } from '../lib/orgScopeSql.js';
import { getEffectiveOrgTzSpecForUser } from '../lib/orgShiftTimezone.js';
import { checkShiftAgainstStaffAvailability } from '../lib/staffShiftAvailabilityCheck.js';
import { parseStaffAvailability, STAFF_AVAILABILITY_DAY_KEYS } from '../lib/staffAvailability.js';
import { requireAgencyShell } from '../middleware/agencyShell.js';

const router = Router();

function availabilityIsConfigured(availabilityJson) {
  const s = parseStaffAvailability(availabilityJson);
  return !STAFF_AVAILABILITY_DAY_KEYS.every((k) => !s[k]?.length);
}

/**
 * GET /api/reports/staff-availability?start=YYYY-MM-DD&end=YYYY-MM-DD
 * Shifts in range with availability vs staff weekly hours (org schedule timezone).
 */
router.get('/staff-availability', requireAgencyShell, async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not logged in' });
    }
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: 'start and end are required (YYYY-MM-DD)' });
    }
    const c = tenantParticipantAndStaffClause(userId, 'p', 'st');
    if (!c.orgId) {
      return res.status(400).json({ error: 'No organisation on your account.' });
    }
    const spec = await getEffectiveOrgTzSpecForUser(userId);
    const startBound = `${String(start).slice(0, 10)}T00:00:00`;
    const endBound = `${String(end).slice(0, 10)}T23:59:59`;

    const rows = db
      .prepare(
        `
      SELECT s.id, s.staff_id, s.start_time, s.end_time, s.participant_id, p.name as participant_name,
             st.name as staff_name, st.availability_json
      FROM shifts s
      JOIN participants p ON s.participant_id = p.id
      JOIN staff st ON s.staff_id = st.id
      WHERE (${c.sql})
        AND s.start_time >= ? AND s.start_time <= ?
      ORDER BY s.start_time
    `
      )
      .all(...c.params, startBound, endBound);

    const byStaff = new Map();
    const conflicts = [];
    for (const row of rows) {
      const r = checkShiftAgainstStaffAvailability(row.availability_json, row.start_time, row.end_time, spec);
      const within_availability = r.status === 'inside' || r.status === 'unknown';
      const w = {
        shift_id: row.id,
        staff_id: row.staff_id,
        staff_name: row.staff_name,
        participant_id: row.participant_id,
        participant_name: row.participant_name,
        start_time: row.start_time,
        end_time: row.end_time,
        within_availability,
        message: r.status === 'outside' ? r.message : null,
        availability_configured: availabilityIsConfigured(row.availability_json)
      };
      if (r.status === 'outside') {
        conflicts.push({ ...w });
      }
      if (!byStaff.has(row.staff_id)) {
        byStaff.set(row.staff_id, {
          id: row.staff_id,
          name: row.staff_name,
          availability_configured: availabilityIsConfigured(row.availability_json),
          availability_json: row.availability_json,
          shifts: []
        });
      }
      const entry = byStaff.get(row.staff_id);
      entry.shifts.push({
        shift_id: row.id,
        participant_id: row.participant_id,
        participant_name: row.participant_name,
        start_time: row.start_time,
        end_time: row.end_time,
        within_availability,
        message: w.message
      });
    }

    const staff = Array.from(byStaff.values()).map((s) => {
      const { availability_json, ...rest } = s;
      return rest;
    });
    res.json({
      start: String(start).slice(0, 10),
      end: String(end).slice(0, 10),
      staff,
      conflicts,
      summary: {
        total_shifts: rows.length,
        outside_availability: conflicts.length
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
