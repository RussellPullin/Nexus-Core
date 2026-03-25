import { v4 as uuidv4 } from 'uuid';
import PDFDocument from 'pdfkit';
import { db } from '../db/index.js';
import { recordEvent } from './learningEvent.service.js';
import { syncShiftLineItemsWithProgressNote } from './shiftLineItems.service.js';
import { participantInvoiceIncludesGst, roundMoney, gstBreakdownFromSubtotal } from '../lib/invoiceGst.js';

export function createInvoiceForShift(shiftId) {
  const existing = db.prepare('SELECT id FROM invoices WHERE shift_id = ?').get(shiftId);
  if (existing) return existing.id;

  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
  if (!shift || !['completed', 'completed_by_admin'].includes(shift.status)) return null;
  if (shift.billing_invoice_id) return null;

  syncShiftLineItemsWithProgressNote(shiftId);

  const invoiceNumber = `INV-${Date.now()}`;
  const id = uuidv4();
  db.prepare(`
    INSERT INTO invoices (id, shift_id, invoice_number, status)
    VALUES (?, ?, ?, 'draft')
  `).run(id, shiftId, invoiceNumber);

  try {
    const lineItems = db.prepare('SELECT ndis_line_item_id FROM shift_line_items WHERE shift_id = ?').all(shiftId);
    recordEvent({
      event_type: 'invoice_generated',
      participant_id: shift.participant_id,
      shift_id: shiftId,
      date: shift.start_time,
      start_time: shift.start_time,
      end_time: shift.end_time,
      metadata: { invoice_id: id, line_item_count: lineItems.length }
    });
  } catch (e) { console.warn('[invoice] learning event error:', e.message); }

  return id;
}

export function getInvoiceData(invoiceId) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!invoice) return null;

  const shift = db.prepare(`
    SELECT s.*, p.name as participant_name, p.ndis_number, p.address as participant_address,
           p.management_type, p.invoice_emails, p.invoice_includes_gst,
           st.name as staff_name, o.name as plan_manager_name, o.abn as plan_manager_abn, o.email as plan_manager_email
    FROM shifts s
    JOIN participants p ON s.participant_id = p.id
    JOIN staff st ON s.staff_id = st.id
    LEFT JOIN organisations o ON p.plan_manager_id = o.id
    WHERE s.id = ?
  `).get(invoice.shift_id);

  const lineItems = db.prepare(`
    SELECT sli.*, nli.support_item_number, nli.description, nli.unit
    FROM shift_line_items sli
    JOIN ndis_line_items nli ON sli.ndis_line_item_id = nli.id
    WHERE sli.shift_id = ?
  `).all(invoice.shift_id);

  const supportDate = shift.start_time ? new Date(shift.start_time).toISOString().slice(0, 10) : null;
  const includesGst = participantInvoiceIncludesGst(shift.invoice_includes_gst);
  let subtotal = 0;
  const items = lineItems.map(li => {
    const lineTotal = roundMoney(li.quantity * li.unit_price);
    subtotal += lineTotal;
    return {
      support_item_number: li.support_item_number,
      description: li.description,
      quantity: li.quantity,
      unit: li.unit,
      unit_price: li.unit_price,
      total: lineTotal
    };
  });
  subtotal = roundMoney(subtotal);
  const { gst_amount: gstAmount, total_incl_gst: totalInclGst } = gstBreakdownFromSubtotal(subtotal, includesGst);

  let invoiceEmails = [];
  try { invoiceEmails = JSON.parse(shift.invoice_emails || '[]'); } catch { invoiceEmails = []; }
  if (!Array.isArray(invoiceEmails)) invoiceEmails = [];

  return {
    ...invoice,
    company_name: process.env.COMPANY_NAME || 'Provider',
    company_abn: process.env.COMPANY_ABN || '',
    participant_name: shift.participant_name,
    ndis_number: shift.ndis_number,
    participant_address: shift.participant_address,
    management_type: shift.management_type || 'self',
    support_date: supportDate,
    staff_name: shift.staff_name,
    plan_manager_name: shift.plan_manager_name,
    plan_manager_abn: shift.plan_manager_abn,
    plan_manager_email: shift.plan_manager_email || null,
    invoice_emails: invoiceEmails,
    invoice_includes_gst: includesGst ? 1 : 0,
    line_items: items,
    subtotal,
    gst_amount: gstAmount,
    total: totalInclGst
  };
}

export async function generateInvoicePDF(invoiceId) {
  const data = getInvoiceData(invoiceId);
  if (!data) return null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text(data.invoice_includes_gst ? 'TAX INVOICE' : 'INVOICE', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Invoice #: ${data.invoice_number}`, { align: 'right' });
    doc.text(`Date: ${new Date(data.created_at).toLocaleDateString('en-AU')}`, { align: 'right' });
    doc.moveDown(2);

    doc.text(`From: ${data.company_name}`);
    if (data.company_abn) doc.text(`ABN: ${data.company_abn}`);
    doc.moveDown();

    doc.text(`Bill To: ${data.participant_name}`);
    doc.text(`NDIS Number: ${data.ndis_number || 'N/A'}`);
    if (data.participant_address) doc.text(`Address: ${data.participant_address}`);
    if (data.plan_manager_name) doc.text(`Plan Manager: ${data.plan_manager_name}`);
    if (data.invoice_emails && data.invoice_emails.length > 0) {
      doc.text(`Invoice To: ${data.invoice_emails.join(', ')}`);
    }
    doc.moveDown(2);

    doc.text(`Support Date: ${data.support_date}`);
    doc.text(`Support Worker: ${data.staff_name}`);
    doc.moveDown(2);

    doc.fontSize(12).text('Support Items', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10);
    data.line_items.forEach(li => {
      doc.text(`${li.support_item_number} - ${li.description}`);
      doc.text(`  ${li.quantity} ${li.unit} @ $${li.unit_price.toFixed(2)} = $${li.total.toFixed(2)}`);
    });
    doc.moveDown();
    if (data.invoice_includes_gst) {
      doc.fontSize(10).text(`Subtotal (ex GST): $${data.subtotal.toFixed(2)}`, { align: 'right' });
      doc.text(`GST (10%): $${data.gst_amount.toFixed(2)}`, { align: 'right' });
    }
    doc.fontSize(12).text(`Total: $${data.total.toFixed(2)}`, { align: 'right' });
    doc.moveDown(2);

    doc.fontSize(9).text(
      data.invoice_includes_gst
        ? `Total includes GST of $${data.gst_amount.toFixed(2)}. Payment terms: 14 days.`
        : 'GST does not apply (GST-free). Payment terms: 14 days.',
      { align: 'center' }
    );
    doc.end();
  });
}
