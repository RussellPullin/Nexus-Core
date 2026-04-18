/**
 * Rebuild billing_invoice_line_items from coordinator_tasks / shifts still linked to an invoice.
 * Use when line rows were lost but billing_invoice_id on tasks/shifts is still set.
 */
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { isNf2fTask } from '../lib/billingConstants.js';
import { syncShiftLineItemsWithProgressNote } from './shiftLineItems.service.js';
import { getDefaultLineItemForParticipant } from './progressNoteMatcher.js';

export function rebuildBillingInvoiceLineItems(invoiceId) {
  const inv = db.prepare('SELECT id, participant_id, status FROM billing_invoices WHERE id = ?').get(invoiceId);
  if (!inv) return { ok: false, error: 'Invoice not found' };
  if (inv.status === 'void') return { ok: false, error: 'Cannot rebuild a void invoice' };

  db.prepare('DELETE FROM billing_invoice_line_items WHERE billing_invoice_id = ?').run(invoiceId);

  const insLine = db.prepare(`
    INSERT INTO billing_invoice_line_items (id, billing_invoice_id, source_type, source_task_id, source_shift_id, source_shift_line_item_id, ndis_line_item_id, support_item_number, description, quantity, unit_price, unit, line_date, source_task_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tasks = db
    .prepare(
      `
    SELECT ct.*, nli.support_item_number, nli.description as ndis_desc
    FROM coordinator_tasks ct
    LEFT JOIN ndis_line_items nli ON nli.id = ct.ndis_line_item_id
    WHERE ct.billing_invoice_id = ?
    ORDER BY ct.activity_date, ct.created_at
  `
    )
    .all(invoiceId);

  const nf2fByDate = new Map();
  const nonNf2f = [];
  for (const t of tasks) {
    if (isNf2fTask(t.task_type)) {
      const k = t.activity_date || '';
      if (!nf2fByDate.has(k)) nf2fByDate.set(k, []);
      nf2fByDate.get(k).push(t);
    } else {
      nonNf2f.push(t);
    }
  }

  for (const [, group] of nf2fByDate) {
    if (group.length === 0) continue;
    const first = group[0];
    const totalQty = group.reduce((s, t) => s + (Number(t.quantity) || 0), 0);
    const taskIds = group.map((t) => t.id);
    insLine.run(
      uuidv4(),
      invoiceId,
      'task',
      first.id,
      null,
      null,
      first.ndis_line_item_id,
      first.support_item_number || '-',
      'Non-face-to-face (consolidated)',
      totalQty,
      Number(first.unit_price) || 0,
      'hour',
      first.activity_date,
      JSON.stringify(taskIds)
    );
  }

  for (const t of nonNf2f) {
    const desc = t.description || t.task_type;
    insLine.run(
      uuidv4(),
      invoiceId,
      'task',
      t.id,
      null,
      null,
      t.ndis_line_item_id,
      t.support_item_number || '-',
      desc,
      Number(t.quantity) || 0,
      Number(t.unit_price) || 0,
      'hour',
      t.activity_date,
      null
    );
  }

  const shiftIds = db.prepare('SELECT id FROM shifts WHERE billing_invoice_id = ?').all(invoiceId).map((r) => r.id);
  const toUnit = (u) => (u === 'each' ? 'unit' : u || 'hour');

  for (const sid of shiftIds) {
    syncShiftLineItemsWithProgressNote(sid);
    const shiftLines = db
      .prepare(
        `
      SELECT sli.*, nli.support_item_number, nli.description, nli.unit
      FROM shift_line_items sli
      JOIN ndis_line_items nli ON nli.id = sli.ndis_line_item_id
      WHERE sli.shift_id = ?
    `
      )
      .all(sid);
    const shift = db.prepare('SELECT participant_id, start_time, end_time FROM shifts WHERE id = ?').get(sid);
    const lineDate = shift?.start_time ? shift.start_time.slice(0, 10) : new Date().toISOString().slice(0, 10);
    if (shiftLines.length > 0) {
      for (const li of shiftLines) {
        insLine.run(
          uuidv4(),
          invoiceId,
          'shift',
          null,
          sid,
          li.id,
          li.ndis_line_item_id,
          li.support_item_number,
          li.description,
          Number(li.quantity) || 0,
          Number(li.unit_price) || 0,
          toUnit(li.unit),
          lineDate,
          null
        );
      }
    } else {
      const defaultItem = getDefaultLineItemForParticipant(
        shift?.participant_id,
        shift?.start_time,
        lineDate,
        shift?.end_time
      );
      if (defaultItem) {
        const nli = db.prepare('SELECT support_item_number, description, unit FROM ndis_line_items WHERE id = ?').get(defaultItem.id);
        const hours =
          shift?.start_time && shift?.end_time
            ? (new Date(shift.end_time) - new Date(shift.start_time)) / (1000 * 60 * 60)
            : 1;
        insLine.run(
          uuidv4(),
          invoiceId,
          'shift',
          null,
          sid,
          null,
          defaultItem.id,
          nli?.support_item_number || '-',
          nli?.description || 'Support',
          hours,
          defaultItem.rate,
          toUnit(nli?.unit),
          lineDate,
          null
        );
      }
    }
  }

  const countRow = db.prepare('SELECT COUNT(*) as c FROM billing_invoice_line_items WHERE billing_invoice_id = ?').get(invoiceId);
  return { ok: true, line_items: countRow?.c ?? 0 };
}
