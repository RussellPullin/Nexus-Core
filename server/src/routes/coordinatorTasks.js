import { Router } from 'express';
import { participantInvoiceIncludesGst, roundMoney, gstBreakdownFromSubtotal } from '../lib/invoiceGst.js';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { getAssignedParticipantIds, canAccessParticipant } from '../middleware/roles.js';
import {
  getSupportCoordLineItem,
  roundToBillableUnits
} from '../services/coordinatorTasks.service.js';
import PDFDocument from 'pdfkit';

const router = Router();
const TASK_TYPES = ['email', 'meeting_f2f', 'meeting_non_f2f', 'phone', 'other'];

function getBillingIntervalForUser(userId) {
  const u = db.prepare('SELECT billing_interval_minutes FROM users WHERE id = ?').get(userId);
  return u?.billing_interval_minutes ?? 15;
}

router.get('/', (req, res) => {
  try {
    const { participant_id, staff_id, from_date, to_date } = req.query;
    const userId = req.session?.user?.id;
    const assignedIds = userId ? getAssignedParticipantIds(userId) : null;

    let tasks = db.prepare(`
      SELECT ct.*, p.name as participant_name, p.ndis_number, st.name as staff_name,
             nli.support_item_number, nli.description as ndis_description
      FROM coordinator_tasks ct
      JOIN participants p ON p.id = ct.participant_id
      JOIN staff st ON st.id = ct.staff_id
      LEFT JOIN ndis_line_items nli ON nli.id = ct.ndis_line_item_id
      ORDER BY ct.activity_date DESC, ct.created_at DESC
    `).all();

    if (assignedIds !== null) {
      const idSet = new Set(assignedIds);
      tasks = tasks.filter((t) => idSet.has(t.participant_id));
    }
    if (participant_id) tasks = tasks.filter((t) => t.participant_id === participant_id);
    if (staff_id) tasks = tasks.filter((t) => t.staff_id === staff_id);
    if (from_date) tasks = tasks.filter((t) => t.activity_date >= from_date);
    if (to_date) tasks = tasks.filter((t) => t.activity_date <= to_date);

    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/task-types', (req, res) => {
  res.json(TASK_TYPES);
});

router.get('/default-line-item', (req, res) => {
  try {
    const { participant_id, activity_date } = req.query;
    if (!participant_id) return res.status(400).json({ error: 'participant_id required' });
    const item = getSupportCoordLineItem(participant_id, activity_date);
    if (!item) return res.status(404).json({ error: 'No support coordination line item found' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const {
      participant_id,
      staff_id,
      task_type,
      description,
      evidence_text,
      activity_date,
      duration_minutes,
      includes_travel,
      travel_km,
      travel_time_min,
      ndis_line_item_id
    } = req.body;

    if (!participant_id || !staff_id || !task_type || !activity_date || duration_minutes == null) {
      return res.status(400).json({ error: 'participant_id, staff_id, task_type, activity_date, duration_minutes required' });
    }

    const userId = req.session?.user?.id;
    if (userId && !canAccessParticipant(userId, participant_id)) {
      return res.status(403).json({ error: 'Access denied to this participant' });
    }
    const user = userId ? db.prepare('SELECT role, staff_id FROM users WHERE id = ?').get(userId) : null;
    if (user?.role === 'support_coordinator' && user?.staff_id && staff_id !== user.staff_id) {
      return res.status(403).json({ error: 'Support coordinators must use their own staff record for tasks' });
    }
    if (!TASK_TYPES.includes(task_type)) {
      return res.status(400).json({ error: `task_type must be one of: ${TASK_TYPES.join(', ')}` });
    }

    const interval = userId ? getBillingIntervalForUser(userId) : 15;

    const lineItem = ndis_line_item_id
      ? db.prepare('SELECT id, rate FROM ndis_line_items WHERE id = ?').get(ndis_line_item_id)
      : getSupportCoordLineItem(participant_id, activity_date);

    if (!lineItem) return res.status(400).json({ error: 'No NDIS line items found. Import the NDIS pricing catalogue in NDIS Pricing first.' });

    const quantity = roundToBillableUnits(Number(duration_minutes) || 0, interval);
    const unitPrice = lineItem.rate;

    const id = uuidv4();
    db.prepare(`
      INSERT INTO coordinator_tasks (
        id, participant_id, staff_id, task_type, description, evidence_text,
        activity_date, duration_minutes, bill_interval_minutes, includes_travel,
        travel_km, travel_time_min, ndis_line_item_id, quantity, unit_price
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      participant_id,
      staff_id,
      task_type,
      description || null,
      evidence_text || null,
      activity_date,
      Number(duration_minutes) || 0,
      null,
      includes_travel ? 1 : 0,
      travel_km ?? null,
      travel_time_min ?? null,
      lineItem.id,
      quantity,
      unitPrice
    );

    const task = db.prepare(`
      SELECT ct.*, p.name as participant_name, st.name as staff_name
      FROM coordinator_tasks ct
      JOIN participants p ON p.id = ct.participant_id
      JOIN staff st ON st.id = ct.staff_id
      WHERE ct.id = ?
    `).get(id);
    res.status(201).json(task);
  } catch (err) {
    console.error('[coordinator-tasks POST]', err);
    res.status(500).json({ error: err.message || 'Failed to save task' });
  }
});

// Task invoice routes must come before /:id
router.get('/task-invoices', (req, res) => {
  try {
    const invoices = db.prepare(`
      SELECT ti.*, p.name as participant_name, p.ndis_number, st.name as staff_name
      FROM task_invoices ti
      JOIN participants p ON p.id = ti.participant_id
      JOIN staff st ON st.id = ti.staff_id
      ORDER BY ti.created_at DESC
    `).all();
    res.json(invoices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/create-invoice', (req, res) => {
  try {
    const { participant_id, staff_id, from_date, to_date } = req.body;
    if (!participant_id || !staff_id) {
      return res.status(400).json({ error: 'participant_id and staff_id required' });
    }

    const tasks = db.prepare(`
      SELECT ct.* FROM coordinator_tasks ct
      WHERE ct.participant_id = ? AND ct.staff_id = ? AND ct.task_invoice_id IS NULL
    `).all(participant_id, staff_id);

    let filtered = tasks;
    if (from_date) filtered = filtered.filter((t) => t.activity_date >= from_date);
    if (to_date) filtered = filtered.filter((t) => t.activity_date <= to_date);

    if (filtered.length === 0) {
      return res.status(400).json({ error: 'No unbilled tasks found for the selected criteria' });
    }

    const dates = filtered.map((t) => t.activity_date).sort();
    const supportDateFrom = dates[0];
    const supportDateTo = dates[dates.length - 1];

    const invoiceId = uuidv4();
    const invoiceNumber = `TINV-${Date.now()}`;

    db.prepare(`
      INSERT INTO task_invoices (id, participant_id, staff_id, invoice_number, support_date_from, support_date_to, status)
      VALUES (?, ?, ?, ?, ?, ?, 'draft')
    `).run(invoiceId, participant_id, staff_id, invoiceNumber, supportDateFrom, supportDateTo);

    const updateTask = db.prepare('UPDATE coordinator_tasks SET task_invoice_id = ?, updated_at = datetime(\'now\') WHERE id = ?');
    for (const t of filtered) {
      updateTask.run(invoiceId, t.id);
    }

    const invoice = db.prepare(`
      SELECT ti.*, p.name as participant_name, p.ndis_number, st.name as staff_name
      FROM task_invoices ti
      JOIN participants p ON p.id = ti.participant_id
      JOIN staff st ON st.id = ti.staff_id
      WHERE ti.id = ?
    `).get(invoiceId);

    res.status(201).json(invoice);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const task = db.prepare(`
      SELECT ct.*, p.name as participant_name, p.ndis_number, st.name as staff_name,
             nli.support_item_number, nli.description as ndis_description
      FROM coordinator_tasks ct
      JOIN participants p ON p.id = ct.participant_id
      JOIN staff st ON st.id = ct.staff_id
      LEFT JOIN ndis_line_items nli ON nli.id = ct.ndis_line_item_id
      WHERE ct.id = ?
    `).get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const userId = req.session?.user?.id;
    if (userId && !canAccessParticipant(userId, task.participant_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const task = db.prepare('SELECT * FROM coordinator_tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const userId = req.session?.user?.id;
    if (userId && !canAccessParticipant(userId, task.participant_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (task.task_invoice_id) {
      return res.status(400).json({ error: 'Cannot edit task that has been invoiced' });
    }

    const {
      task_type,
      description,
      evidence_text,
      activity_date,
      duration_minutes,
      includes_travel,
      travel_km,
      travel_time_min,
      ndis_line_item_id
    } = req.body;

    const interval = userId ? getBillingIntervalForUser(userId) : 15;

    const lineItem = ndis_line_item_id
      ? db.prepare('SELECT id, rate FROM ndis_line_items WHERE id = ?').get(ndis_line_item_id)
      : getSupportCoordLineItem(task.participant_id, activity_date || task.activity_date);

    if (!lineItem) return res.status(400).json({ error: 'No NDIS line item found' });

    const quantity = roundToBillableUnits(Number(duration_minutes ?? task.duration_minutes) || 0, interval);
    const unitPrice = lineItem.rate;

    db.prepare(`
      UPDATE coordinator_tasks SET
        task_type = COALESCE(?, task_type),
        description = COALESCE(?, description),
        evidence_text = COALESCE(?, evidence_text),
        activity_date = COALESCE(?, activity_date),
        duration_minutes = COALESCE(?, duration_minutes),
        bill_interval_minutes = NULL,
        includes_travel = ?,
        travel_km = ?,
        travel_time_min = ?,
        ndis_line_item_id = ?,
        quantity = ?,
        unit_price = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      task_type ?? task.task_type,
      description !== undefined ? description : task.description,
      evidence_text !== undefined ? evidence_text : task.evidence_text,
      activity_date ?? task.activity_date,
      duration_minutes ?? task.duration_minutes,
      includes_travel !== undefined ? (includes_travel ? 1 : 0) : task.includes_travel,
      travel_km !== undefined ? travel_km : task.travel_km,
      travel_time_min !== undefined ? travel_time_min : task.travel_time_min,
      lineItem.id,
      quantity,
      unitPrice,
      req.params.id
    );

    const updated = db.prepare(`
      SELECT ct.*, p.name as participant_name, st.name as staff_name
      FROM coordinator_tasks ct
      JOIN participants p ON p.id = ct.participant_id
      JOIN staff st ON st.id = ct.staff_id
      WHERE ct.id = ?
    `).get(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const task = db.prepare('SELECT * FROM coordinator_tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const userId = req.session?.user?.id;
    if (userId && !canAccessParticipant(userId, task.participant_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (task.task_invoice_id) {
      return res.status(400).json({ error: 'Cannot delete task that has been invoiced' });
    }
    db.prepare('DELETE FROM coordinator_tasks WHERE id = ?').run(req.params.id);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/task-invoices/:id', (req, res) => {
  try {
    const invoice = db.prepare(`
      SELECT ti.*, p.name as participant_name, p.ndis_number, p.address as participant_address,
             p.invoice_includes_gst,
             st.name as staff_name, o.name as plan_manager_name, o.abn as plan_manager_abn
      FROM task_invoices ti
      JOIN participants p ON p.id = ti.participant_id
      JOIN staff st ON st.id = ti.staff_id
      LEFT JOIN organisations o ON p.plan_manager_id = o.id
      WHERE ti.id = ?
    `).get(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const tasks = db.prepare(`
      SELECT ct.*, nli.support_item_number, nli.description as ndis_description, nli.unit
      FROM coordinator_tasks ct
      LEFT JOIN ndis_line_items nli ON nli.id = ct.ndis_line_item_id
      WHERE ct.task_invoice_id = ?
      ORDER BY ct.activity_date, ct.created_at
    `).all(req.params.id);

    const travelItem = db.prepare('SELECT id, support_item_number, description, rate, unit FROM ndis_line_items WHERE support_item_number LIKE ?').get('07_799%');

    const includesGst = participantInvoiceIncludesGst(invoice.invoice_includes_gst);
    let subtotal = 0;
    const lineItems = [];
    for (const t of tasks) {
      const amt = roundMoney((t.quantity || 0) * (t.unit_price || 0));
      subtotal += amt;
      lineItems.push({
        support_item_number: t.support_item_number,
        description: t.ndis_description || t.task_type,
        quantity: t.quantity,
        unit: t.unit || 'hour',
        unit_price: t.unit_price,
        total: amt,
        task_type: t.task_type,
        activity_date: t.activity_date
      });
      if (t.includes_travel && t.travel_km > 0 && travelItem) {
        const travelAmt = roundMoney(t.travel_km * (travelItem.rate || 1));
        subtotal += travelAmt;
        lineItems.push({
          support_item_number: travelItem.support_item_number,
          description: travelItem.description || 'Provider travel',
          quantity: t.travel_km,
          unit: travelItem.unit || 'km',
          unit_price: travelItem.rate || 1,
          total: travelAmt,
          task_type: 'travel',
          activity_date: t.activity_date
        });
      }
    }
    subtotal = roundMoney(subtotal);
    const { gst_amount: gstAmount, total_incl_gst: totalInclGst } = gstBreakdownFromSubtotal(subtotal, includesGst);

    res.json({
      ...invoice,
      line_items: lineItems,
      subtotal,
      gst_amount: gstAmount,
      total: totalInclGst,
      tasks
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/task-invoices/:id/pdf', async (req, res) => {
  try {
    const invoice = db.prepare(`
      SELECT ti.*, p.name as participant_name, p.ndis_number, p.address as participant_address,
             p.invoice_includes_gst,
             st.name as staff_name, o.name as plan_manager_name, o.abn as plan_manager_abn
      FROM task_invoices ti
      JOIN participants p ON p.id = ti.participant_id
      JOIN staff st ON st.id = ti.staff_id
      LEFT JOIN organisations o ON p.plan_manager_id = o.id
      WHERE ti.id = ?
    `).get(req.params.id);
    if (!invoice) return res.status(404).send('Invoice not found');

    const tasks = db.prepare(`
      SELECT ct.*, nli.support_item_number, nli.description as ndis_description, nli.unit
      FROM coordinator_tasks ct
      LEFT JOIN ndis_line_items nli ON nli.id = ct.ndis_line_item_id
      WHERE ct.task_invoice_id = ?
      ORDER BY ct.activity_date, ct.created_at
    `).all(req.params.id);

    const travelItem = db.prepare('SELECT id, support_item_number, description, rate, unit FROM ndis_line_items WHERE support_item_number LIKE ?').get('07_799%');

    const includesGst = participantInvoiceIncludesGst(invoice.invoice_includes_gst);
    let subtotal = 0;
    const lineItems = [];
    for (const t of tasks) {
      const amt = roundMoney((t.quantity || 0) * (t.unit_price || 0));
      subtotal += amt;
      lineItems.push({
        support_item_number: t.support_item_number,
        description: t.ndis_description || t.task_type,
        quantity: t.quantity,
        unit: t.unit || 'hour',
        unit_price: t.unit_price,
        total: amt
      });
      if (t.includes_travel && t.travel_km > 0 && travelItem) {
        const travelAmt = roundMoney(t.travel_km * (travelItem.rate || 1));
        subtotal += travelAmt;
        lineItems.push({
          support_item_number: travelItem.support_item_number,
          description: travelItem.description || 'Provider travel',
          quantity: t.travel_km,
          unit: travelItem.unit || 'km',
          unit_price: travelItem.rate || 1,
          total: travelAmt
        });
      }
    }
    subtotal = roundMoney(subtotal);
    const { gst_amount: gstAmount, total_incl_gst: grandTotal } = gstBreakdownFromSubtotal(subtotal, includesGst);

    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="task-invoice-${invoice.invoice_number}.pdf"`);
      res.send(Buffer.concat(chunks));
    });
    doc.on('error', (err) => res.status(500).json({ error: err.message }));

    const companyName = process.env.COMPANY_NAME || 'Provider';
    const companyAbn = process.env.COMPANY_ABN || '';

    doc.fontSize(18).text(includesGst ? 'TAX INVOICE – Support Coordination' : 'INVOICE – Support Coordination', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Invoice #: ${invoice.invoice_number}`, { align: 'right' });
    doc.text(`Date: ${new Date(invoice.created_at).toLocaleDateString('en-AU')}`, { align: 'right' });
    doc.moveDown(2);

    doc.text(`From: ${companyName}`);
    if (companyAbn) doc.text(`ABN: ${companyAbn}`);
    doc.moveDown();

    doc.text(`Bill To: ${invoice.participant_name}`);
    doc.text(`NDIS Number: ${invoice.ndis_number || 'N/A'}`);
    if (invoice.participant_address) doc.text(`Address: ${invoice.participant_address}`);
    if (invoice.plan_manager_name) doc.text(`Plan Manager: ${invoice.plan_manager_name}`);
    doc.moveDown(2);

    doc.text(`Support Period: ${invoice.support_date_from} to ${invoice.support_date_to}`);
    doc.text(`Coordinator: ${invoice.staff_name}`);
    doc.moveDown(2);

    doc.fontSize(12).text('Support Items', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10);
    lineItems.forEach((li) => {
      doc.text(`${li.support_item_number || '-'} - ${li.description}`);
      doc.text(`  ${li.quantity} ${li.unit} @ $${li.unit_price?.toFixed(2)} = $${li.total.toFixed(2)}`);
    });
    doc.moveDown();
    if (includesGst) {
      doc.fontSize(10).text(`Subtotal (ex GST): $${subtotal.toFixed(2)}`, { align: 'right' });
      doc.text(`GST (10%): $${gstAmount.toFixed(2)}`, { align: 'right' });
    }
    doc.fontSize(12).text(`Total: $${grandTotal.toFixed(2)}`, { align: 'right' });
    doc.moveDown(2);

    doc.fontSize(9).text(
      includesGst
        ? `Total includes GST of $${gstAmount.toFixed(2)}. Payment terms: 14 days.`
        : 'GST does not apply (GST-free). Payment terms: 14 days.',
      { align: 'center' }
    );
    doc.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/task-invoices/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    db.prepare('UPDATE task_invoices SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, req.params.id);
    res.json({ id: req.params.id, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
