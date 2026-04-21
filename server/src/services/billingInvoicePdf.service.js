/**
 * Renders a billing invoice PDF (same output as GET /billing/:id/pdf).
 */
import { join } from 'path';
import { existsSync } from 'fs';
import PDFDocument from 'pdfkit';
import { db } from '../db/index.js';
import { getBusinessSettings, mergeWithEnv, uploadsDir } from '../routes/settings.js';
import { participantInvoiceIncludesGst, roundMoney, gstBreakdownFromSubtotal } from '../lib/invoiceGst.js';
import { sanitizePdfText } from '../lib/pdfInvoiceText.js';
import { resolveOrgIdForBillingParticipant } from './orgOnedriveSync.service.js';

/**
 * @param {string} invoiceId
 * @returns {Promise<Buffer|null>} PDF bytes, or null if invoice missing
 */
export function generateBillingInvoicePdfBuffer(invoiceId) {
  return new Promise((resolve, reject) => {
    const inv = db.prepare(`
      SELECT bi.*, p.name as participant_name, p.ndis_number, p.address as participant_address,
             p.management_type, p.invoice_emails, p.invoice_includes_gst, p.plan_manager_id,
             o.name as plan_manager_name, o.abn as plan_manager_abn, o.email as plan_manager_email
      FROM billing_invoices bi
      JOIN participants p ON p.id = bi.participant_id
      LEFT JOIN organisations o ON p.plan_manager_id = o.id
      WHERE bi.id = ?
    `).get(invoiceId);
    if (!inv) {
      resolve(null);
      return;
    }

    let invoiceEmails = [];
    try {
      invoiceEmails = JSON.parse(inv.invoice_emails || '[]');
    } catch {
      invoiceEmails = [];
    }
    if (!Array.isArray(invoiceEmails)) invoiceEmails = [];

    const items = db
      .prepare('SELECT * FROM billing_invoice_line_items WHERE billing_invoice_id = ? ORDER BY line_date, created_at')
      .all(invoiceId);
    const includesGst = participantInvoiceIncludesGst(inv.invoice_includes_gst);
    let subtotal = 0;
    items.forEach((li) => {
      subtotal += (li.quantity || 0) * (li.unit_price || 0);
    });
    subtotal = roundMoney(subtotal);
    const { gst_amount: totalGst, total_incl_gst: grandTotal } = gstBreakdownFromSubtotal(subtotal, includesGst);

    const doc = new PDFDocument({ margin: 50, bufferPages: true });
    doc.font('Helvetica');
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const footerReserve = 44;
    const pageMaxY = () => doc.page.height - footerReserve;

    function drawLineItemsTableHeader(y) {
      doc.fontSize(9);
      doc.text('Item', 50, y);
      doc.text('Details', 120, y);
      doc.text('Quantity', 380, y);
      doc.text('Price', 430, y);
      doc.text('GST', 480, y);
      doc.text('Total', 520, y);
      return y + 16;
    }

    const billingOrgId = resolveOrgIdForBillingParticipant(inv.participant_id);
    const bizRow = getBusinessSettings(billingOrgId);
    const biz = mergeWithEnv(bizRow, { noOrgRowYet: Boolean(billingOrgId) && !bizRow });
    const companyName = sanitizePdfText(biz.company_name || 'Provider');
    const companyEmail = sanitizePdfText(biz.company_email || '');
    const companyAbn = sanitizePdfText(biz.company_abn || '');
    const companyAcn = sanitizePdfText(biz.company_acn || '');
    const ndisProviderNumber = sanitizePdfText(biz.ndis_provider_number || '');
    const companyRegistration = sanitizePdfText(process.env.COMPANY_REGISTRATION || '');
    const paymentTermsDays = String(biz.payment_terms_days || 7);
    const companyBsb = sanitizePdfText(biz.bsb || '');
    const companyAccount = sanitizePdfText(biz.account_number || '');
    const accountName = sanitizePdfText(biz.account_name || companyName);
    const logoPath = biz.logo_path ? join(uploadsDir, biz.logo_path) : null;

    const invDate = new Date(inv.created_at);
    const dueDate = new Date(invDate);
    dueDate.setDate(dueDate.getDate() + parseInt(paymentTermsDays, 10) || 7);
    const formatDate = (d) => d.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const participantType = inv.management_type === 'plan' || inv.plan_manager_id ? 'Plan Managed' : 'Self Managed';

    let startY = 50;
    if (logoPath && existsSync(logoPath)) {
      try {
        doc.image(logoPath, 50, 50, { width: 120 });
        startY = 50 + 80;
      } catch (e) {
        console.warn('[billing pdf] logo load failed:', e?.message);
      }
    }
    doc.y = startY;

    doc.fontSize(18).text(includesGst ? 'Tax Invoice' : 'Invoice', { align: 'center' });
    doc.moveDown();
    if (inv.status === 'void') {
      doc.fontSize(12).fillColor('#b91c1c').text('VOID — not payable', { align: 'center' });
      doc.fillColor('black');
      doc.moveDown(0.5);
    }

    const metaY = doc.y;
    doc.fontSize(10);
    doc.text(`Invoice Number ${sanitizePdfText(inv.invoice_number)}`, 350, metaY);
    doc.text(`Invoice Date ${formatDate(invDate)}`, 350, metaY + 14);
    doc.text(`Due Date ${formatDate(dueDate)}`, 350, metaY + 28);
    doc.text(`Total $${grandTotal.toFixed(2)}`, 350, metaY + 42);
    doc.text(`Amount Due $${grandTotal.toFixed(2)}`, 350, metaY + 56);
    doc.y = metaY + 70;

    doc.text('From', { continued: false });
    doc.moveDown(0.3);
    doc.text(companyName);
    if (companyEmail) doc.text(companyEmail);
    if (companyAbn) doc.text(`ABN ${companyAbn}`);
    if (companyAcn) doc.text(`ACN ${companyAcn}`);
    if (ndisProviderNumber) doc.text(`NDIS Provider # ${ndisProviderNumber}`);
    if (companyRegistration) doc.text(`Registration # ${companyRegistration}`);
    doc.moveDown();

    doc.text('To');
    doc.moveDown(0.3);
    const pName = sanitizePdfText(inv.participant_name);
    const pNdis = sanitizePdfText(inv.ndis_number || 'N/A');
    const pAddr = inv.participant_address ? sanitizePdfText(inv.participant_address) : '';
    const pmName = inv.plan_manager_name ? sanitizePdfText(inv.plan_manager_name) : '';
    const emailsJoined = sanitizePdfText(invoiceEmails.map((e) => sanitizePdfText(e)).join(', '));

    doc.text(pName);
    doc.text(`NDIS Number ${pNdis}`);
    doc.text(`Type ${participantType}`);
    if (pAddr) doc.text(`Address ${pAddr}`);
    if (pmName) doc.text(`Plan Manager ${pmName}`);
    if (invoiceEmails.length > 0) doc.text(`Invoice To ${emailsJoined}`);
    doc.moveDown();

    const tableTop = doc.y;
    let rowY = drawLineItemsTableHeader(tableTop) + 6;

    items.forEach((li) => {
      const lineTotal = roundMoney((li.quantity || 0) * (li.unit_price || 0));
      const lineGst = includesGst ? roundMoney(lineTotal * 0.1) : 0;
      const lineDate = li.line_date
        ? new Date(li.line_date).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' })
        : '';
      const claimType = li.source_task_ids ? 'Non-Face-to-Face' : 'Direct Service';
      const itemCell = sanitizePdfText(`${li.support_item_number || '-'} ${lineDate}`.trim());
      const descBlock = `${sanitizePdfText(li.description || 'Support')}\nClaim Type: ${claimType}`;

      doc.fontSize(9);
      const hLeft = doc.heightOfString(itemCell, { width: 65 });
      const hDetail = doc.heightOfString(descBlock, { width: 250 });
      const rowH = Math.max(hLeft, hDetail, 14);

      if (rowY + rowH > pageMaxY()) {
        doc.addPage();
        rowY = drawLineItemsTableHeader(50) + 6;
      }

      doc.text(itemCell, 50, rowY, { width: 65 });
      doc.text(descBlock, 120, rowY, { width: 250 });
      doc.text(String(li.quantity ?? ''), 380, rowY, { width: 45, align: 'right' });
      doc.text((li.unit_price ?? 0).toFixed(2), 430, rowY, { width: 45, align: 'right' });
      doc.text(includesGst ? lineGst.toFixed(2) : '0.00', 480, rowY, { width: 35, align: 'right' });
      doc.text(lineTotal.toFixed(2), 520, rowY, { width: 45, align: 'right' });

      rowY += rowH + 6;
    });

    const tailBlockMin = 210;
    if (rowY + tailBlockMin > pageMaxY()) {
      doc.addPage();
      rowY = 50;
    } else {
      rowY += 8;
    }

    const summaryY = rowY;
    if (includesGst) {
      doc.text(`Subtotal (ex GST) ${subtotal.toFixed(2)}`, 380, summaryY, { width: 170, align: 'right' });
      doc.text(`GST (10%) ${totalGst.toFixed(2)}`, 380, summaryY + 14, { width: 170, align: 'right' });
      doc.text(`Total ${grandTotal.toFixed(2)}`, 380, summaryY + 28, { width: 170, align: 'right' });
      doc.text(`Amount Due $${grandTotal.toFixed(2)}`, 380, summaryY + 42, { width: 170, align: 'right' });
      doc.y = summaryY + 58;
    } else {
      doc.text('GST 0.00', 380, summaryY, { width: 170, align: 'right' });
      doc.text(`Total ${grandTotal.toFixed(2)}`, 380, summaryY + 14, { width: 170, align: 'right' });
      doc.text(`Amount Due $${grandTotal.toFixed(2)}`, 380, summaryY + 28, { width: 170, align: 'right' });
      doc.y = summaryY + 50;
    }

    doc.moveDown(0.5);
    doc.fontSize(8).text(
      includesGst
        ? `Amounts are ex GST unless noted. Total includes GST of $${totalGst.toFixed(2)}.`
        : 'GST does not apply to these supports (GST-free).',
      50,
      doc.y,
      { width: 500 }
    );
    doc.moveDown(1.2);

    doc.fontSize(9);
    const payY = doc.y;
    doc.text('Payment Details', 50, payY);
    doc.text(`Payment Terms: ${paymentTermsDays} days`, 50, payY + 18);
    doc.text(`Account Name: ${accountName}`, 50, payY + 32);
    doc.text(`BSB ${companyBsb || '-'}`, 50, payY + 46);
    doc.text(`Account ${companyAccount || '-'}`, 50, payY + 60);
    doc.text(`Reference ${sanitizePdfText(inv.invoice_number)}`, 50, payY + 74);
    doc.y = payY + 90;

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      doc.fontSize(8).text(`Page ${i + 1} of ${range.count}`, 50, doc.page.height - 32, {
        width: doc.page.width - 100,
        align: 'center'
      });
    }
    doc.end();
  });
}
