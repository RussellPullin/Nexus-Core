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
import {
  INVOICE_FOOTER_FROM_BOTTOM,
  INVOICE_FOOTER_RESERVE,
  INVOICE_PAGE_MARGIN,
  invoiceLineItemColumns,
} from '../lib/invoicePdfLayout.js';
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

    // A4 + ~19mm margins: US Letter pages printed on AU A4 stock clip the right/bottom edges,
    // and fixed columns at x=520 overflow A4's printable width.
    const doc = new PDFDocument({ size: 'A4', margin: INVOICE_PAGE_MARGIN, bufferPages: true });
    doc.font('Helvetica');
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const col = invoiceLineItemColumns(doc.page.width, INVOICE_PAGE_MARGIN);
    const pageMaxY = () => doc.page.height - INVOICE_FOOTER_RESERVE;

    function drawLineItemsTableHeader(y) {
      doc.fontSize(9);
      doc.text('Item', col.itemX, y, { width: col.itemW });
      doc.text('Details', col.detailsX, y, { width: col.detailsW });
      doc.text('Quantity', col.qtyX, y, { width: col.qtyW, align: 'right' });
      doc.text('Price', col.priceX, y, { width: col.priceW, align: 'right' });
      doc.text('GST', col.gstX, y, { width: col.gstW, align: 'right' });
      doc.text('Total', col.totalX, y, { width: col.totalW, align: 'right' });
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

    let startY = INVOICE_PAGE_MARGIN;
    if (logoPath && existsSync(logoPath)) {
      try {
        doc.image(logoPath, col.left, INVOICE_PAGE_MARGIN, { width: 120 });
        startY = INVOICE_PAGE_MARGIN + 80;
      } catch (e) {
        console.warn('[billing pdf] logo load failed:', e?.message);
      }
    }
    doc.y = startY;

    doc.fontSize(18).text(includesGst ? 'Tax Invoice' : 'Invoice', { align: 'center', width: col.contentWidth });
    doc.moveDown();
    if (inv.status === 'void') {
      doc.fontSize(12).fillColor('#b91c1c').text('VOID — not payable', { align: 'center', width: col.contentWidth });
      doc.fillColor('black');
      doc.moveDown(0.5);
    }

    const metaY = doc.y;
    const metaW = col.right - col.metaX;
    doc.fontSize(10);
    doc.text(`Invoice Number ${sanitizePdfText(inv.invoice_number)}`, col.metaX, metaY, { width: metaW });
    doc.text(`Invoice Date ${formatDate(invDate)}`, col.metaX, metaY + 14, { width: metaW });
    doc.text(`Due Date ${formatDate(dueDate)}`, col.metaX, metaY + 28, { width: metaW });
    doc.text(`Total $${grandTotal.toFixed(2)}`, col.metaX, metaY + 42, { width: metaW });
    doc.text(`Amount Due $${grandTotal.toFixed(2)}`, col.metaX, metaY + 56, { width: metaW });
    doc.y = metaY + 70;

    doc.text('From', col.left, doc.y, { width: col.contentWidth });
    doc.moveDown(0.3);
    doc.text(companyName, { width: col.contentWidth });
    if (companyEmail) doc.text(companyEmail, { width: col.contentWidth });
    if (companyAbn) doc.text(`ABN ${companyAbn}`, { width: col.contentWidth });
    if (companyAcn) doc.text(`ACN ${companyAcn}`, { width: col.contentWidth });
    if (ndisProviderNumber) doc.text(`NDIS Provider # ${ndisProviderNumber}`, { width: col.contentWidth });
    if (companyRegistration) doc.text(`Registration # ${companyRegistration}`, { width: col.contentWidth });
    doc.moveDown();

    doc.text('To', { width: col.contentWidth });
    doc.moveDown(0.3);
    const pName = sanitizePdfText(inv.participant_name);
    const pNdis = sanitizePdfText(inv.ndis_number || 'N/A');
    const pAddr = inv.participant_address ? sanitizePdfText(inv.participant_address) : '';
    const pmName = inv.plan_manager_name ? sanitizePdfText(inv.plan_manager_name) : '';
    const emailsJoined = sanitizePdfText(invoiceEmails.map((e) => sanitizePdfText(e)).join(', '));

    doc.text(pName, { width: col.contentWidth });
    doc.text(`NDIS Number ${pNdis}`, { width: col.contentWidth });
    doc.text(`Type ${participantType}`, { width: col.contentWidth });
    if (pAddr) doc.text(`Address ${pAddr}`, { width: col.contentWidth });
    if (pmName) doc.text(`Plan Manager ${pmName}`, { width: col.contentWidth });
    if (invoiceEmails.length > 0) doc.text(`Invoice To ${emailsJoined}`, { width: col.contentWidth });
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
      const hLeft = doc.heightOfString(itemCell, { width: col.itemW });
      const hDetail = doc.heightOfString(descBlock, { width: col.detailsW });
      const rowH = Math.max(hLeft, hDetail, 14);

      if (rowY + rowH > pageMaxY()) {
        doc.addPage();
        rowY = drawLineItemsTableHeader(INVOICE_PAGE_MARGIN) + 6;
      }

      doc.text(itemCell, col.itemX, rowY, { width: col.itemW });
      doc.text(descBlock, col.detailsX, rowY, { width: col.detailsW });
      doc.text(String(li.quantity ?? ''), col.qtyX, rowY, { width: col.qtyW, align: 'right' });
      doc.text((li.unit_price ?? 0).toFixed(2), col.priceX, rowY, { width: col.priceW, align: 'right' });
      doc.text(includesGst ? lineGst.toFixed(2) : '0.00', col.gstX, rowY, { width: col.gstW, align: 'right' });
      doc.text(lineTotal.toFixed(2), col.totalX, rowY, { width: col.totalW, align: 'right' });

      rowY += rowH + 6;
    });

    const tailBlockMin = 210;
    if (rowY + tailBlockMin > pageMaxY()) {
      doc.addPage();
      rowY = INVOICE_PAGE_MARGIN;
    } else {
      rowY += 8;
    }

    const summaryY = rowY;
    if (includesGst) {
      doc.text(`Subtotal (ex GST) ${subtotal.toFixed(2)}`, col.summaryX, summaryY, { width: col.summaryW, align: 'right' });
      doc.text(`GST (10%) ${totalGst.toFixed(2)}`, col.summaryX, summaryY + 14, { width: col.summaryW, align: 'right' });
      doc.text(`Total ${grandTotal.toFixed(2)}`, col.summaryX, summaryY + 28, { width: col.summaryW, align: 'right' });
      doc.text(`Amount Due $${grandTotal.toFixed(2)}`, col.summaryX, summaryY + 42, { width: col.summaryW, align: 'right' });
      doc.y = summaryY + 58;
    } else {
      doc.text('GST 0.00', col.summaryX, summaryY, { width: col.summaryW, align: 'right' });
      doc.text(`Total ${grandTotal.toFixed(2)}`, col.summaryX, summaryY + 14, { width: col.summaryW, align: 'right' });
      doc.text(`Amount Due $${grandTotal.toFixed(2)}`, col.summaryX, summaryY + 28, { width: col.summaryW, align: 'right' });
      doc.y = summaryY + 50;
    }

    doc.moveDown(0.5);
    doc.fontSize(8).text(
      includesGst
        ? `Amounts are ex GST unless noted. Total includes GST of $${totalGst.toFixed(2)}.`
        : 'GST does not apply to these supports (GST-free).',
      col.left,
      doc.y,
      { width: col.contentWidth }
    );
    doc.moveDown(1.2);

    doc.fontSize(9);
    const payY = doc.y;
    doc.text('Payment Details', col.left, payY, { width: col.contentWidth });
    doc.text(`Payment Terms: ${paymentTermsDays} days`, col.left, payY + 18, { width: col.contentWidth });
    doc.text(`Account Name: ${accountName}`, col.left, payY + 32, { width: col.contentWidth });
    doc.text(`BSB ${companyBsb || '-'}`, col.left, payY + 46, { width: col.contentWidth });
    doc.text(`Account ${companyAccount || '-'}`, col.left, payY + 60, { width: col.contentWidth });
    doc.text(`Reference ${sanitizePdfText(inv.invoice_number)}`, col.left, payY + 74, { width: col.contentWidth });
    doc.y = payY + 90;

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      doc.fontSize(8).text(`Page ${i + 1} of ${range.count}`, col.left, doc.page.height - INVOICE_FOOTER_FROM_BOTTOM, {
        width: col.contentWidth,
        align: 'center'
      });
    }
    doc.end();
  });
}
