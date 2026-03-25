import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { sendICSByEmail, isEmailConfiguredForUser } from '../services/notification.service.js';
import { generateICS, generateICSForMultipleShifts } from '../services/calendar.service.js';
import { recordEvent } from '../services/learningEvent.service.js';
import { updateAggregatesForShift } from '../services/featureStore.service.js';
import { pullShiftsFromExcel } from '../services/excelPull.service.js';
import {
  scheduleMirrorShiftToNexusSupabase,
  scheduleRemoveShiftFromNexusSupabase,
} from '../services/nexusPublicShiftsSync.service.js';

const router = Router();

router.get('/', (req, res) => {
  try {
    const { start, end, participant_id, staff_id, recurring_group_id } = req.query;
    let shifts = db.prepare(`
      SELECT s.*, p.name as participant_name, p.ndis_number, st.name as staff_name, st.email as staff_email, st.phone as staff_phone, st.notify_email, st.notify_sms
      FROM shifts s
      JOIN participants p ON s.participant_id = p.id
      JOIN staff st ON s.staff_id = st.id
      ORDER BY s.start_time
    `).all();

    if (start) {
      shifts = shifts.filter(s => s.start_time >= start);
    }
    if (end) {
      shifts = shifts.filter(s => s.start_time <= end);
    }
    if (participant_id) {
      shifts = shifts.filter(s => s.participant_id === participant_id);
    }
    if (staff_id) {
      shifts = shifts.filter(s => s.staff_id === staff_id);
    }
    if (recurring_group_id) {
      shifts = shifts.filter(s => s.recurring_group_id === recurring_group_id);
    }

    res.json(shifts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/send-roster', async (req, res) => {
  try {
    const { start, end } = req.body;
    if (!start || !end) return res.status(400).json({ error: 'start and end dates required (YYYY-MM-DD)' });
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not logged in', errorDetail: 'Please log in again.' });
    }
    if (!isEmailConfiguredForUser(userId)) {
      return res.status(400).json({
        error: 'Connect your email in Settings to send rosters.',
        code: 'EMAIL_NOT_CONNECTED',
        errorDetail: 'Open Settings and use Connect email (Gmail or Microsoft 365).'
      });
    }
    console.log('[send-roster] userId:', userId);
    const shifts = db.prepare(`
      SELECT s.*, p.name as participant_name, st.name as staff_name, st.email as staff_email
      FROM shifts s
      JOIN participants p ON s.participant_id = p.id
      JOIN staff st ON s.staff_id = st.id
      WHERE s.start_time >= ? AND s.start_time <= ? AND s.roster_sent_at IS NULL
      ORDER BY st.id, s.start_time
    `).all(`${start}T00:00:00`, `${end}T23:59:59`);
    const byStaff = {};
    for (const s of shifts) {
      if (!byStaff[s.staff_id]) byStaff[s.staff_id] = { staff: { name: s.staff_name, email: s.staff_email }, shifts: [] };
      byStaff[s.staff_id].shifts.push(s);
    }
    if (Object.keys(byStaff).length === 0) {
      const anyShifts = db.prepare(`
        SELECT 1 FROM shifts s
        WHERE s.start_time >= ? AND s.start_time <= ?
      `).get(`${start}T00:00:00`, `${end}T23:59:59`);
      return res.status(400).json({
        error: anyShifts ? 'No unsent shifts in this date range.' : 'No staff with shifts in this date range.',
        errorDetail: anyShifts ? 'All shifts have already been sent. Move or edit a shift to send again.' : ''
      });
    }
    const results = { sent: 0, skipped: 0, errors: [] };
    const weekLabel = `${new Date(start).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} – ${new Date(end).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    const safeFilename = `roster-${start}-to-${end}.ics`;
    for (const staffId of Object.keys(byStaff)) {
      const { staff: st, shifts: staffShifts } = byStaff[staffId];
      if (!st.email) {
        results.skipped++;
        results.errors.push(`${st.name}: no email`);
        continue;
      }
      try {
        const ics = generateICSForMultipleShifts(staffShifts);
        await sendICSByEmail(st.email, `Your roster – ${weekLabel}`, ics, safeFilename, staffShifts, userId);
        for (const sh of staffShifts) {
          db.prepare('UPDATE shifts SET roster_sent_at = datetime(\'now\') WHERE id = ?').run(sh.id);
        }
        results.sent++;
        console.log('[send-roster] sent to', st.email);
      } catch (err) {
        console.error('[send-roster] failed for', st.email, ':', err.message);
        results.errors.push(`${st.name}: ${err.message}`);
      }
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /shifts/duplicates - find shifts that look like duplicates (for cleanup).
 * Query: staff_id (optional) - limit to one staff.
 * Primary: bySameSlot = same participant name + staff name + date + time. Secondary: byShifterId = same import ID.
 * Returns: { bySameSlot: [...], byShifterId: [...], summary } with 2+ shifts per group.
 */
router.get('/duplicates', (req, res) => {
  try {
    const { staff_id } = req.query;
    const baseSql = `
      SELECT s.id, s.participant_id, s.staff_id, s.start_time, s.end_time, s.shifter_shift_id, s.status,
             p.name as participant_name, st.name as staff_name
      FROM shifts s
      JOIN participants p ON s.participant_id = p.id
      JOIN staff st ON s.staff_id = st.id
    `;
    const staffFilter = staff_id ? ' WHERE s.staff_id = ?' : '';
    const params = staff_id ? [staff_id] : [];

    // 1) Same shifter_shift_id in more than one row (imported twice)
    const duplicateShifterIds = db.prepare(`
      SELECT shifter_shift_id FROM shifts
      WHERE shifter_shift_id IS NOT NULL AND TRIM(shifter_shift_id) != ''
      GROUP BY shifter_shift_id HAVING COUNT(*) > 1
    `).all().map((r) => r.shifter_shift_id);
    const byShifterIdRows = duplicateShifterIds.length === 0 ? [] : db.prepare(`
      SELECT s.id, s.participant_id, s.staff_id, s.start_time, s.end_time, s.shifter_shift_id, s.status,
             p.name as participant_name, st.name as staff_name
      FROM shifts s
      JOIN participants p ON s.participant_id = p.id
      JOIN staff st ON s.staff_id = st.id
      WHERE s.shifter_shift_id IN (${duplicateShifterIds.map(() => '?').join(',')})
      ${staff_id ? ' AND s.staff_id = ?' : ''}
      ORDER BY s.shifter_shift_id, s.start_time
    `).all(...(staff_id ? [...duplicateShifterIds, staff_id] : duplicateShifterIds));

    const byShifterId = [];
    const seen = new Set();
    for (const row of byShifterIdRows) {
      const key = (row.shifter_shift_id || '').trim();
      if (!key || seen.has(key)) continue;
      const group = byShifterIdRows.filter((r) => (r.shifter_shift_id || '').trim() === key);
      if (group.length > 1) {
        seen.add(key);
        byShifterId.push({ shifter_shift_id: key, shifts: group });
      }
    }

    // 2) Same participant name + staff name + date + time (primary duplicate check)
    const allShifts = db.prepare(`
      ${baseSql}
      ${staffFilter}
      ORDER BY p.name, st.name, s.start_time
    `).all(...params);

    const normalize = (str) => (str || '').trim().toLowerCase();
    const slotKey = (s) => `${normalize(s.participant_name)}|${normalize(s.staff_name)}|${(s.start_time || '').slice(0, 19)}`;
    const bySlot = {};
    for (const s of allShifts) {
      const key = slotKey(s);
      if (!bySlot[key]) bySlot[key] = [];
      bySlot[key].push(s);
    }
    const bySameSlot = Object.values(bySlot).filter((arr) => arr.length > 1);

    res.json({
      bySameSlot,
      byShifterId,
      summary: {
        duplicateGroupsBySameSlot: bySameSlot.length,
        duplicateGroupsByShifterId: byShifterId.length,
        totalDuplicateShifts: bySameSlot.reduce((n, g) => n + (Array.isArray(g) ? g.length : 0), 0) + byShifterId.reduce((n, g) => n + (g.shifts?.length ?? 0), 0)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const shift = db.prepare(`
      SELECT s.*, p.name as participant_name, p.ndis_number, p.email as participant_email,
             p.default_ndis_line_item_id as participant_default_ndis_line_item_id,
             st.name as staff_name, st.email as staff_email, st.phone as staff_phone
      FROM shifts s
      JOIN participants p ON s.participant_id = p.id
      JOIN staff st ON s.staff_id = st.id
      WHERE s.id = ?
    `).get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    res.json(shift);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/refresh-expense', async (req, res) => {
  try {
    const shift = db.prepare(`
      SELECT s.*, p.name as participant_name, p.ndis_number, p.email as participant_email,
             p.default_ndis_line_item_id as participant_default_ndis_line_item_id,
             st.name as staff_name, st.email as staff_email, st.phone as staff_phone
      FROM shifts s
      JOIN participants p ON s.participant_id = p.id
      JOIN staff st ON s.staff_id = st.id
      WHERE s.id = ?
    `).get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    if (!shift.shifter_shift_id) {
      return res.json(shift);
    }
    const { shifts } = await pullShiftsFromExcel({}).catch(() => ({ shifts: [] }));
    const excelShift = (shifts || []).find(
      (s) => String(s.shiftId || '').trim() === String(shift.shifter_shift_id).trim()
    );
    if (excelShift && (parseFloat(excelShift.expenses) || 0) > 0) {
      const expensesVal = parseFloat(excelShift.expenses) || 0;
      db.prepare('UPDATE shifts SET expenses = ?, updated_at = datetime(\'now\') WHERE id = ?').run(expensesVal, req.params.id);
      const updated = db.prepare(`
        SELECT s.*, p.name as participant_name, p.ndis_number, p.email as participant_email,
               p.default_ndis_line_item_id as participant_default_ndis_line_item_id,
               st.name as staff_name, st.email as staff_email, st.phone as staff_phone
        FROM shifts s
        JOIN participants p ON s.participant_id = p.id
        JOIN staff st ON s.staff_id = st.id
        WHERE s.id = ?
      `).get(req.params.id);
      return res.json(updated);
    }
    res.json(shift);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/receipts', (req, res) => {
  try {
    const shift = db.prepare('SELECT participant_id, shifter_shift_id FROM shifts WHERE id = ?').get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    const docCols = db.prepare("PRAGMA table_info(participant_documents)").all();
    const hasShiftId = docCols.some((c) => c.name === 'shift_id');
    if (!hasShiftId || !shift.shifter_shift_id) {
      return res.json([]);
    }
    const hasReceiptDesc = docCols.some((c) => c.name === 'receipt_description');
    const receipts = db.prepare(`
      SELECT id, filename, ${hasReceiptDesc ? 'receipt_description, ' : ''}created_at
      FROM participant_documents
      WHERE participant_id = ? AND shift_id = ? AND category = 'Expense Receipt'
      ORDER BY created_at DESC
    `).all(shift.participant_id, shift.shifter_shift_id);
    res.json(receipts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NO emails on create – only via "Send roster" or "Send to staff" button
router.post('/', async (req, res) => {
  try {
    const id = uuidv4();
    const { participant_id, staff_id, start_time, end_time, notes, recurring_group_id } = req.body;
    db.prepare(`
      INSERT INTO shifts (id, participant_id, staff_id, start_time, end_time, notes, status, recurring_group_id)
      VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?)
    `).run(id, participant_id, staff_id, start_time, end_time, notes || null, recurring_group_id || null);

    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);

    try {
      recordEvent({
        event_type: 'shift_created',
        participant_id, staff_id, shift_id: id,
        date: start_time, start_time, end_time
      });
      updateAggregatesForShift({
        participant_id, staff_id,
        day_of_week: new Date(start_time).getDay(),
        time_bucket: null, start_time, end_time,
        shift_type: 'standard', line_items: []
      });
    } catch (e) { console.warn('[shifts] learning event error:', e.message); }

    scheduleMirrorShiftToNexusSupabase(id);
    res.status(201).json(shift);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NO emails on update/move – only via "Send roster" or "Send to staff" button
router.put('/:id', async (req, res) => {
  try {
    const { participant_id, staff_id, start_time, end_time, status, notes, recurring_group_id } = req.body;
    const existing = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Shift not found' });

    const rgId = recurring_group_id !== undefined ? recurring_group_id : existing.recurring_group_id;

    db.prepare(`
      UPDATE shifts SET
        participant_id = ?, staff_id = ?, start_time = ?, end_time = ?, status = ?, notes = ?,
        recurring_group_id = ?,
        updated_at = datetime('now'),
        roster_sent_at = NULL
      WHERE id = ?
    `).run(
      participant_id ?? existing.participant_id,
      staff_id ?? existing.staff_id,
      start_time ?? existing.start_time,
      end_time ?? existing.end_time,
      status ?? existing.status,
      notes ?? existing.notes,
      rgId,
      req.params.id
    );

    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
    // Invoicing is done via batch (Financial > Batch invoices); no per-shift invoice creation.

    try {
      const changedFields = {};
      if (start_time && start_time !== existing.start_time) changedFields.start_time = { old: existing.start_time, new: start_time };
      if (end_time && end_time !== existing.end_time) changedFields.end_time = { old: existing.end_time, new: end_time };
      if (participant_id && participant_id !== existing.participant_id) changedFields.participant_id = { old: existing.participant_id, new: participant_id };
      if (staff_id && staff_id !== existing.staff_id) changedFields.staff_id = { old: existing.staff_id, new: staff_id };

      for (const [field, vals] of Object.entries(changedFields)) {
        recordEvent({
          event_type: 'shift_edited',
          participant_id: shift.participant_id, staff_id: shift.staff_id, shift_id: shift.id,
          date: shift.start_time, start_time: shift.start_time, end_time: shift.end_time,
          field_name: field, old_value: vals.old, new_value: vals.new
        });
      }
      updateAggregatesForShift({
        participant_id: shift.participant_id, staff_id: shift.staff_id,
        day_of_week: new Date(shift.start_time).getDay(),
        start_time: shift.start_time, end_time: shift.end_time,
        shift_type: 'standard', line_items: []
      });
    } catch (e) { console.warn('[shifts] learning event error:', e.message); }

    scheduleMirrorShiftToNexusSupabase(req.params.id);
    res.json(shift);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  const id = req.params.id;
  // Remove dependent rows so FK constraint doesn't block shift delete
  try {
    db.prepare('DELETE FROM billing_invoice_line_items WHERE source_shift_id = ?').run(id);
  } catch (e) { /* table may not exist or no FK */ }
  try {
    db.prepare('DELETE FROM invoices WHERE shift_id = ?').run(id);
  } catch (e) { /* table may not exist */ }
  try {
    db.prepare('UPDATE progress_notes SET shift_id = NULL WHERE shift_id = ?').run(id);
  } catch (e) { /* table may not exist */ }
  db.prepare('DELETE FROM shift_line_items WHERE shift_id = ?').run(id);
  db.prepare('DELETE FROM shifts WHERE id = ?').run(id);
  scheduleRemoveShiftFromNexusSupabase(id);
  res.status(204).send();
});

// Shift line items (charges)
router.get('/:id/line-items', (req, res) => {
  try {
    const shift = db.prepare('SELECT id FROM shifts WHERE id = ?').get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    const items = db.prepare(`
      SELECT sli.*, nli.support_item_number, nli.description, nli.unit, nli.rate_type
      FROM shift_line_items sli
      JOIN ndis_line_items nli ON sli.ndis_line_item_id = nli.id
      WHERE sli.shift_id = ?
      ORDER BY sli.id
    `).all(req.params.id);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/line-items', (req, res) => {
  try {
    const shift = db.prepare('SELECT id, participant_id, start_time FROM shifts WHERE id = ?').get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    const { ndis_line_item_id, quantity, unit_price, claim_type } = req.body;
    if (!ndis_line_item_id) return res.status(400).json({ error: 'ndis_line_item_id is required' });
    const ndis = db.prepare('SELECT id, rate, rate_remote, rate_very_remote FROM ndis_line_items WHERE id = ?').get(ndis_line_item_id);
    if (!ndis) return res.status(400).json({ error: 'NDIS line item not found' });
    const effectiveRate = ndis.rate_remote ?? ndis.rate_very_remote ?? ndis.rate;
    const isQuotable = (effectiveRate == null || Number(effectiveRate) === 0);
    if (isQuotable && (unit_price == null || unit_price === '')) {
      return res.status(400).json({ error: 'This is a quotable support (no set price). Please enter the agreed unit price.' });
    }
    const price = unit_price != null && unit_price !== '' ? parseFloat(unit_price) : effectiveRate;
    const qty = parseFloat(quantity) || 0;
    if (qty <= 0) return res.status(400).json({ error: 'Quantity must be greater than 0' });
    const id = uuidv4();
    db.prepare(`
      INSERT INTO shift_line_items (id, shift_id, ndis_line_item_id, quantity, unit_price, claim_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.params.id, ndis_line_item_id, qty, price, claim_type || 'standard');
    const item = db.prepare(`
      SELECT sli.*, nli.support_item_number, nli.description, nli.unit
      FROM shift_line_items sli
      JOIN ndis_line_items nli ON sli.ndis_line_item_id = nli.id
      WHERE sli.id = ?
    `).get(id);

    try {
      recordEvent({
        event_type: 'line_item_selected',
        participant_id: shift.participant_id, shift_id: shift.id,
        date: shift.start_time, start_time: shift.start_time,
        field_name: 'ndis_line_item_id', new_value: ndis_line_item_id,
        metadata: { quantity: qty, unit_price: price, claim_type: claim_type || 'standard' }
      });
      updateAggregatesForShift({
        participant_id: shift.participant_id,
        day_of_week: new Date(shift.start_time).getDay(),
        start_time: shift.start_time,
        shift_type: 'standard',
        line_items: [{ ndis_line_item_id }]
      });
    } catch (e) { console.warn('[shifts] learning event error:', e.message); }

    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/line-items/:lineItemId', (req, res) => {
  try {
    const existing = db.prepare(`
      SELECT sli.* FROM shift_line_items sli
      WHERE sli.id = ? AND sli.shift_id = ?
    `).get(req.params.lineItemId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Line item not found' });
    const { quantity, unit_price, claim_type } = req.body;
    const qty = quantity != null ? parseFloat(quantity) : existing.quantity;
    const price = unit_price != null ? parseFloat(unit_price) : existing.unit_price;
    if (qty < 0) return res.status(400).json({ error: 'Quantity cannot be negative' });
    db.prepare(`
      UPDATE shift_line_items SET quantity = ?, unit_price = ?, claim_type = ?
      WHERE id = ?
    `).run(qty, price, claim_type ?? existing.claim_type, req.params.lineItemId);
    const item = db.prepare(`
      SELECT sli.*, nli.support_item_number, nli.description, nli.unit
      FROM shift_line_items sli
      JOIN ndis_line_items nli ON sli.ndis_line_item_id = nli.id
      WHERE sli.id = ?
    `).get(req.params.lineItemId);
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/line-items/:lineItemId', (req, res) => {
  const result = db.prepare(`
    DELETE FROM shift_line_items WHERE id = ? AND shift_id = ?
  `).run(req.params.lineItemId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Line item not found' });
  res.status(204).send();
});

router.get('/:id/ics', (req, res) => {
  const shift = db.prepare(`
    SELECT s.*, p.name as participant_name, st.name as staff_name
    FROM shifts s
    JOIN participants p ON s.participant_id = p.id
    JOIN staff st ON s.staff_id = st.id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  const ics = generateICS(shift, shift.participant_name, shift.staff_name);
  res.setHeader('Content-Type', 'text/calendar');
  res.setHeader('Content-Disposition', `attachment; filename="shift-${req.params.id}.ics"`);
  res.send(ics);
});

router.post('/:id/send-ics', async (req, res) => {
  try {
    const shift = db.prepare(`
      SELECT s.*, p.name as participant_name, st.name as staff_name, st.email as staff_email
      FROM shifts s
      JOIN participants p ON s.participant_id = p.id
      JOIN staff st ON s.staff_id = st.id
      WHERE s.id = ?
    `).get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    if (!shift.staff_email) return res.status(400).json({ error: 'Staff member has no email address' });
    if (shift.roster_sent_at) {
      return res.status(400).json({
        error: 'Shift already sent',
        errorDetail: 'This shift has already been sent. Move or edit the shift to send again.'
      });
    }
    const userId = req.session?.user?.id;
    if (!isEmailConfiguredForUser(userId)) {
      return res.status(400).json({
        error: 'Connect your email in Settings to send rosters.',
        code: 'EMAIL_NOT_CONNECTED',
        errorDetail: 'Open Settings and use Connect email.'
      });
    }
    const ics = generateICS(shift, shift.participant_name, shift.staff_name);
    const dateStr = new Date(shift.start_time).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
    await sendICSByEmail(shift.staff_email, `Your shift – ${dateStr}`, ics, `shift-${req.params.id}.ics`, [shift], userId);
    db.prepare('UPDATE shifts SET roster_sent_at = datetime(\'now\') WHERE id = ?').run(req.params.id);
    res.json({ sent: true, to: shift.staff_email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
