/**
 * Admin dashboard APIs: coordinator activity, billable summary, financial overview.
 * Requires admin or delegate with active grant.
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdminOrDelegate } from '../middleware/roles.js';
import { computeHoursFromShifts } from '../services/shiftHours.service.js';

const router = Router();
router.use(requireAuth);
router.use(requireAdminOrDelegate);

// Coordinator activity: tasks and aggregates by coordinator
router.get('/coordinator-activity', (req, res) => {
  try {
    const { from_date, to_date, staff_id } = req.query;
    let tasks = db.prepare(`
      SELECT ct.*, p.name as participant_name, p.ndis_number, st.name as staff_name
      FROM coordinator_tasks ct
      JOIN participants p ON p.id = ct.participant_id
      JOIN staff st ON st.id = ct.staff_id
      ORDER BY ct.activity_date DESC, ct.created_at DESC
    `).all();
    if (from_date) tasks = tasks.filter((t) => t.activity_date >= from_date);
    if (to_date) tasks = tasks.filter((t) => t.activity_date <= to_date);
    if (staff_id) tasks = tasks.filter((t) => t.staff_id === staff_id);

    const byCoordinator = {};
    tasks.forEach((t) => {
      const sid = t.staff_id;
      if (!byCoordinator[sid]) {
        byCoordinator[sid] = {
          staff_id: sid,
          staff_name: t.staff_name,
          task_count: 0,
          total_hours: 0,
          total_value: 0,
          tasks: []
        };
      }
      const hours = (t.quantity || 0);
      const value = hours * (t.unit_price || 0);
      byCoordinator[sid].task_count += 1;
      byCoordinator[sid].total_hours += hours;
      byCoordinator[sid].total_value += value;
      byCoordinator[sid].tasks.push({
        id: t.id,
        participant_name: t.participant_name,
        activity_date: t.activity_date,
        task_type: t.task_type,
        description: t.description,
        duration_minutes: t.duration_minutes,
        quantity: t.quantity,
        unit_price: t.unit_price,
        value: hours * (t.unit_price || 0)
      });
    });

    const aggregates = Object.values(byCoordinator).map((a) => ({
      staff_id: a.staff_id,
      staff_name: a.staff_name,
      task_count: a.task_count,
      total_hours: Math.round(a.total_hours * 100) / 100,
      total_value: Math.round(a.total_value * 100) / 100,
      tasks: a.tasks
    }));

    res.json({ tasks, aggregates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Billable summary: hours and value, unbilled vs billed
router.get('/billable-summary', (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const from = from_date || '1970-01-01';
    const to = to_date || '9999-12-31';

    const unbilledTasks = db.prepare(`
      SELECT ct.id, ct.quantity, ct.unit_price, ct.activity_date
      FROM coordinator_tasks ct
      WHERE ct.activity_date >= ? AND ct.activity_date <= ?
        AND ct.task_invoice_id IS NULL AND (ct.billing_invoice_id IS NULL OR ct.billing_invoice_id = '')
    `).all(from, to);
    const unbilledTaskHours = unbilledTasks.reduce((s, t) => s + (t.quantity || 0), 0);
    const unbilledTaskValue = unbilledTasks.reduce((s, t) => s + (t.quantity || 0) * (t.unit_price || 0), 0);

    const unbilledShifts = db.prepare(`
      SELECT s.id, s.start_time, s.end_time
      FROM shifts s
      WHERE s.status IN ('completed', 'completed_by_admin')
        AND (s.billing_invoice_id IS NULL OR s.billing_invoice_id = '')
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.shift_id = s.id)
        AND s.start_time >= ? AND s.start_time <= ?
    `).all(`${from}T00:00:00`, `${to}T23:59:59`);
    let unbilledShiftHours = 0;
    unbilledShifts.forEach((s) => {
      if (s.start_time && s.end_time) {
        unbilledShiftHours += (new Date(s.end_time) - new Date(s.start_time)) / (1000 * 60 * 60);
      }
    });
    const shiftLineItems = db.prepare(`
      SELECT sli.shift_id, sli.quantity, sli.unit_price
      FROM shift_line_items sli
      JOIN shifts s ON s.id = sli.shift_id
      WHERE s.status IN ('completed', 'completed_by_admin')
        AND (s.billing_invoice_id IS NULL OR s.billing_invoice_id = '')
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.shift_id = s.id)
        AND s.start_time >= ? AND s.start_time <= ?
    `).all(`${from}T00:00:00`, `${to}T23:59:59`);
    const unbilledShiftValue = shiftLineItems.reduce((s, li) => s + (li.quantity || 0) * (li.unit_price || 0), 0);

    const billedTasks = db.prepare(`
      SELECT ct.quantity, ct.unit_price FROM coordinator_tasks ct
      WHERE ct.activity_date >= ? AND ct.activity_date <= ?
        AND (ct.billing_invoice_id IS NOT NULL AND ct.billing_invoice_id != '')
    `).all(from, to);
    const billedTaskHours = billedTasks.reduce((s, t) => s + (t.quantity || 0), 0);
    const billedTaskValue = billedTasks.reduce((s, t) => s + (t.quantity || 0) * (t.unit_price || 0), 0);

    const billedShifts = db.prepare(`
      SELECT sli.quantity, sli.unit_price FROM billing_invoice_line_items sli
      JOIN shifts s ON s.id = sli.source_shift_id
      WHERE sli.source_type = 'shift' AND sli.line_date >= ? AND sli.line_date <= ?
    `).all(from, to);
    const billedShiftHours = billedShifts.reduce((s, li) => s + (li.quantity || 0), 0);
    const billedShiftValue = billedShifts.reduce((s, li) => s + (li.quantity || 0) * (li.unit_price || 0), 0);

    res.json({
      coordinator_tasks: {
        unbilled: { count: unbilledTasks.length, hours: Math.round(unbilledTaskHours * 100) / 100, value: Math.round(unbilledTaskValue * 100) / 100 },
        billed: { count: billedTasks.length, hours: Math.round(billedTaskHours * 100) / 100, value: Math.round(billedTaskValue * 100) / 100 }
      },
      shifts: {
        unbilled: { count: unbilledShifts.length, hours: Math.round(unbilledShiftHours * 100) / 100, value: Math.round(unbilledShiftValue * 100) / 100 },
        billed: { count: billedShifts.length, hours: Math.round(billedShiftHours * 100) / 100, value: Math.round(billedShiftValue * 100) / 100 }
      },
      total_unbilled: {
        hours: Math.round((unbilledTaskHours + unbilledShiftHours) * 100) / 100,
        value: Math.round((unbilledTaskValue + unbilledShiftValue) * 100) / 100
      },
      total_billed: {
        hours: Math.round((billedTaskHours + billedShiftHours) * 100) / 100,
        value: Math.round((billedTaskValue + billedShiftValue) * 100) / 100
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Financial overview: invoice breakdown by period/coordinator/participant
router.get('/financial-overview', (req, res) => {
  try {
    const { from_date, to_date, group_by = 'month' } = req.query;
    const from = from_date || '1970-01-01';
    const to = to_date || '9999-12-31';

    const invoices = db.prepare(`
      SELECT bi.id, bi.participant_id, bi.invoice_number, bi.period_from, bi.period_to, bi.status, bi.created_at,
             p.name as participant_name
      FROM billing_invoices bi
      JOIN participants p ON p.id = bi.participant_id
      WHERE bi.period_from <= ? AND bi.period_to >= ?
    `).all(to, from);

    const byStatus = { draft: { count: 0, total: 0 }, sent: { count: 0, total: 0 }, paid: { count: 0, total: 0 } };
    const invIds = invoices.map((i) => i.id);

    let items = [];
    if (invIds.length > 0) {
      const placeholders = invIds.map(() => '?').join(',');
      items = db.prepare(`
        SELECT billing_invoice_id, quantity, unit_price, source_task_id, source_shift_id, source_type, line_date
        FROM billing_invoice_line_items
        WHERE billing_invoice_id IN (${placeholders})
      `).all(...invIds);
    }

    const invTotals = {};
    items.forEach((li) => {
      const invId = li.billing_invoice_id;
      if (!invTotals[invId]) invTotals[invId] = 0;
      invTotals[invId] += (li.quantity || 0) * (li.unit_price || 0);
    });

    invoices.forEach((inv) => {
      const total = invTotals[inv.id] || 0;
      const status = (inv.status || 'draft').toLowerCase();
      const key = byStatus[status] ? status : 'draft';
      if (!byStatus[key]) byStatus[key] = { count: 0, total: 0 };
      byStatus[key].count += 1;
      byStatus[key].total += total;
    });

    let grouped = [];
    if (group_by === 'month') {
      const byMonth = {};
      invoices.forEach((inv) => {
        const month = (inv.period_from || inv.created_at || '').slice(0, 7);
        if (!byMonth[month]) byMonth[month] = { period: month, count: 0, total: 0 };
        byMonth[month].count += 1;
        byMonth[month].total += invTotals[inv.id] || 0;
      });
      grouped = Object.values(byMonth).map((g) => ({ ...g, total: Math.round(g.total * 100) / 100 })).sort((a, b) => a.period.localeCompare(b.period));
    } else if (group_by === 'participant') {
      const byPart = {};
      invoices.forEach((inv) => {
        const pid = inv.participant_id;
        if (!byPart[pid]) byPart[pid] = { participant_id: pid, participant_name: inv.participant_name, count: 0, total: 0 };
        byPart[pid].count += 1;
        byPart[pid].total += invTotals[inv.id] || 0;
      });
      grouped = Object.values(byPart).map((g) => ({ ...g, total: Math.round(g.total * 100) / 100 }));
    } else if (group_by === 'coordinator') {
      const taskIds = items.filter((i) => i.source_task_id).map((i) => i.source_task_id);
      const taskToStaff = {};
      if (taskIds.length > 0) {
        const ph = taskIds.map(() => '?').join(',');
        db.prepare(`SELECT id, staff_id FROM coordinator_tasks WHERE id IN (${ph})`).all(...taskIds).forEach((t) => {
          taskToStaff[t.id] = t.staff_id;
        });
      }
      const staffNames = {};
      db.prepare('SELECT id, name FROM staff').all().forEach((s) => { staffNames[s.id] = s.name; });
      const byCoord = {};
      items.forEach((li) => {
        let staffId = null;
        if (li.source_task_id) staffId = taskToStaff[li.source_task_id];
        if (!staffId) staffId = '_unassigned';
        const name = staffId === '_unassigned' ? 'Shifts / Unassigned' : (staffNames[staffId] || staffId);
        if (!byCoord[staffId]) byCoord[staffId] = { staff_id: staffId, staff_name: name, count: 0, total: 0 };
        byCoord[staffId].count += 1;
        byCoord[staffId].total += (li.quantity || 0) * (li.unit_price || 0);
      });
      grouped = Object.values(byCoord).map((g) => ({ ...g, total: Math.round(g.total * 100) / 100 }));
    }

    res.json({
      by_status: byStatus,
      grouped,
      invoices: invoices.map((i) => ({
        ...i,
        total: Math.round((invTotals[i.id] || 0) * 100) / 100
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Full staff pay-period summary from Nexus shifts (same rules as per-staff shift-hours-summary). */
router.get('/pay-summary', (req, res) => {
  try {
    const staffRows = db.prepare('SELECT id, name FROM staff ORDER BY name COLLATE NOCASE').all();
    const shiftStmt = db.prepare(`
      SELECT s.id, s.start_time, s.end_time, s.expenses,
        (SELECT pn.travel_time_min FROM progress_notes pn WHERE pn.shift_id = s.id LIMIT 1) as travel_time_min,
        (SELECT pn.travel_km FROM progress_notes pn WHERE pn.shift_id = s.id LIMIT 1) as travel_km
      FROM shifts s
      WHERE s.staff_id = ?
        AND s.status IN ('completed', 'completed_by_admin')
      ORDER BY s.start_time
    `);

    const rows = [];
    for (const st of staffRows) {
      const shifts = shiftStmt.all(st.id);
      const summaryRows = computeHoursFromShifts(shifts);
      for (const r of summaryRows) {
        rows.push({
          ...r,
          staffName: st.name,
          staff_id: st.id,
        });
      }
    }

    rows.sort((a, b) => {
      const pe = String(b.periodEnd || '').localeCompare(String(a.periodEnd || ''));
      if (pe !== 0) return pe;
      const ps = String(b.periodStart || '').localeCompare(String(a.periodStart || ''));
      if (ps !== 0) return ps;
      return String(a.staffName || '').localeCompare(String(b.staffName || ''));
    });

    res.json({ summaryRows: rows, unmatchedStaffNames: [] });
  } catch (err) {
    console.error('[admin pay-summary]', err);
    res.status(500).json({ error: err.message || 'Failed to load pay summary' });
  }
});

export default router;
