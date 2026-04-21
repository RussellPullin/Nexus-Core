/**
 * Rebuild billing_invoice_line_items from coordinator_tasks / shifts still linked to an invoice.
 * Use when line rows were lost but billing_invoice_id on tasks/shifts is still set.
 */
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { syncShiftLineItemsWithProgressNote } from './shiftLineItems.service.js';
import { buildBillingLinePayloadForScDayBucket, ALL_BUCKETS, resolveSupportCoordProviderTravelKmItem } from './coordinatorTasks.service.js';
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

  const byDate = new Map();
  for (const t of tasks) {
    const k = t.activity_date || '';
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(t);
  }

  for (const [, dayTasks] of byDate) {
    if (dayTasks.length === 0) continue;
    const travelKmItem = resolveSupportCoordProviderTravelKmItem(db, dayTasks);
    for (const b of ALL_BUCKETS) {
      const payload = buildBillingLinePayloadForScDayBucket(dayTasks, b, travelKmItem, 15);
      if (!payload) continue;
      const lineDateStr = String(payload.line_date || dayTasks[0].activity_date).slice(0, 10);
      insLine.run(
        uuidv4(),
        invoiceId,
        'task',
        payload.source_task_id,
        null,
        null,
        payload.ndis_line_item_id,
        payload.support_item_number || '-',
        payload.description,
        payload.quantity,
        payload.unit_price,
        payload.unit,
        lineDateStr,
        JSON.stringify(payload.source_task_ids)
      );
    }
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
