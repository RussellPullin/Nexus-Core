/**
 * Email billing invoice PDFs to plan manager / self-managed recipients; optionally create matching invoices in Xero for reconciliation.
 */
import { db } from '../db/index.js';
import { participantInvoiceIncludesGst, roundMoney, gstBreakdownFromSubtotal } from '../lib/invoiceGst.js';
import { generateBillingInvoicePdfBuffer } from './billingInvoicePdf.service.js';
import { pushBillingInvoiceToXero, isXeroLinked, resolveInvoiceEmailsForXero } from './xeroBillingPush.service.js';
import { sendEmailViaRelay, isEmailConfiguredForUser } from './notification.service.js';
import { getEmailConfigForUser } from '../lib/emailSendConfig.js';
import {
  tryPushParticipantBinaryCategory,
  resolveOrgIdForBillingParticipant,
  billingInvoicePdfAlreadyInRegister
} from './orgOnedriveSync.service.js';
import { getOnedriveLinkRow } from './orgOnedriveTokens.service.js';

function lineSubtotalExGst(invoiceId) {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(quantity AS REAL) * CAST(unit_price AS REAL)), 0) as s
       FROM billing_invoice_line_items WHERE billing_invoice_id = ?`
    )
    .get(invoiceId);
  return roundMoney(r?.s || 0);
}

/**
 * @param {string} batchRef
 * @param {string|null} orgId
 * @param {string|null} userId - sender (OAuth mailbox for relay)
 */
export async function sendBillingBatch(batchRef, orgId = null, userId = null) {
  if (!userId) {
    const err = new Error('You must be signed in to send invoices.');
    err.code = 'USER_REQUIRED';
    throw err;
  }
  if (!isEmailConfiguredForUser(userId)) {
    const err = new Error(
      'Connect your email under Settings (same as roster emails) so Nexus can send invoice PDFs to participants and plan managers.'
    );
    err.code = 'EMAIL_NOT_CONNECTED';
    throw err;
  }

  const pattern = `BINV-${batchRef}-%`;
  const rowSql = `
    SELECT bi.id, bi.invoice_number, bi.xero_invoice_id, bi.participant_id,
           p.invoice_emails, p.management_type, p.email as participant_email,
           p.invoice_includes_gst, p.name as participant_name, p.provider_org_id,
           o.email as plan_manager_org_email
    FROM billing_invoices bi
    JOIN participants p ON p.id = bi.participant_id
    LEFT JOIN organisations o ON p.plan_manager_id = o.id
    WHERE bi.invoice_number LIKE ? AND bi.status = 'draft'
      ${orgId ? 'AND p.provider_org_id = ?' : ''}
    ORDER BY invoice_number
  `;
  const rows = orgId ? db.prepare(rowSql).all(pattern, orgId) : db.prepare(rowSql).all(pattern);

  const anyBatch = orgId
    ? db
        .prepare(`
          SELECT 1
          FROM billing_invoices bi
          JOIN participants p ON p.id = bi.participant_id
          WHERE bi.invoice_number LIKE ? AND p.provider_org_id = ?
          LIMIT 1
        `)
        .get(pattern, orgId)
    : db.prepare('SELECT 1 FROM billing_invoices WHERE invoice_number LIKE ? LIMIT 1').get(pattern);

  if (!anyBatch) {
    const err = new Error('No invoices found for this batch');
    err.code = 'BATCH_NOT_FOUND';
    throw err;
  }

  if (rows.length === 0) {
    return {
      sent: 0,
      failed: 0,
      invoices: [],
      errors: [],
      xero_warnings: [],
      message: 'No draft invoices to send (already sent or paid).',
    };
  }

  const cfg = getEmailConfigForUser(userId);
  const from = cfg.from;
  const xeroLinked = isXeroLinked(orgId);

  const invoices = [];
  const errors = [];
  const xeroWarnings = [];

  for (const row of rows) {
    try {
      if (orgId && row.provider_org_id && String(row.provider_org_id) !== String(orgId)) {
        throw new Error('Invoice does not belong to your organisation');
      }

      let invoiceEmails = [];
      try {
        invoiceEmails = JSON.parse(row.invoice_emails || '[]');
      } catch {
        invoiceEmails = [];
      }
      if (!Array.isArray(invoiceEmails)) invoiceEmails = [];

      const recipients = resolveInvoiceEmailsForXero(
        invoiceEmails,
        row.management_type,
        row.plan_manager_org_email,
        row.participant_email
      );
      if (recipients.length === 0) {
        throw new Error(
          'No invoice email: add Invoice email(s) on the participant, or set the plan manager organisation email, or add the participant email for self-managed participants.'
        );
      }

      const pdfBuf = await generateBillingInvoicePdfBuffer(row.id);
      if (!pdfBuf) throw new Error('Invoice not found');

      let xeroInvoiceId = row.xero_invoice_id || null;
      let xeroInvoiceNumber = null;
      if (xeroLinked && !xeroInvoiceId) {
        try {
          const r = await pushBillingInvoiceToXero(row.id, orgId);
          xeroInvoiceId = r.xeroInvoiceId;
          xeroInvoiceNumber = r.xeroInvoiceNumber;
          db.prepare(
            `UPDATE billing_invoices SET xero_invoice_id = ?, updated_at = datetime('now') WHERE id = ?`
          ).run(xeroInvoiceId, row.id);
        } catch (xe) {
          xeroWarnings.push({
            billing_invoice_id: row.id,
            invoice_number: row.invoice_number,
            error: xe.message || String(xe),
          });
        }
      } else if (xeroLinked && row.xero_invoice_id) {
        xeroInvoiceId = row.xero_invoice_id;
      }

      const sub = lineSubtotalExGst(row.id);
      const includesGst = participantInvoiceIncludesGst(row.invoice_includes_gst);
      const { total_incl_gst: totalDue } = gstBreakdownFromSubtotal(sub, includesGst);

      const subj = `Invoice ${row.invoice_number} – ${row.participant_name || 'Participant'}`;
      const text = [
        'Please find your invoice attached.',
        '',
        `Invoice: ${row.invoice_number}`,
        `Amount due: $${totalDue.toFixed(2)} (includes GST where applicable).`,
        '',
        xeroLinked && xeroInvoiceId
          ? 'This invoice is also recorded in Xero for payment tracking and reconciliation.'
          : xeroLinked
            ? 'Xero did not receive this invoice automatically; you can add it in Xero if needed.'
            : 'Link Xero under Settings to sync invoices for payment tracking and reconciliation.',
      ].join('\n');

      const safeFile = `invoice-${String(row.invoice_number).replace(/[^\w.-]+/g, '_')}.pdf`;
      await sendEmailViaRelay(userId, recipients, subj, text, from, [
        { filename: safeFile, content: pdfBuf, contentType: 'application/pdf' },
      ]);

      db.prepare(`UPDATE billing_invoices SET status = 'sent', updated_at = datetime('now') WHERE id = ?`).run(row.id);

      const orgIdOd = resolveOrgIdForBillingParticipant(row.participant_id);
      if (orgIdOd && getOnedriveLinkRow(orgIdOd) && !billingInvoicePdfAlreadyInRegister(orgIdOd, row.id)) {
        void tryPushParticipantBinaryCategory({
          participantId: row.participant_id,
          registerCategory: 'Invoice',
          folderSegment: 'Financial',
          buffer: pdfBuf,
          originalFilename: safeFile,
          mimeType: 'application/pdf',
          notes: `billing_invoice:${row.id}`,
        });
      }

      invoices.push({
        billing_invoice_id: row.id,
        invoice_number: row.invoice_number,
        xero_invoice_id: xeroInvoiceId,
        xero_invoice_number: xeroInvoiceNumber,
        emailed_to: recipients,
      });
    } catch (e) {
      errors.push({
        billing_invoice_id: row.id,
        invoice_number: row.invoice_number,
        error: e.message || String(e),
      });
    }
  }

  const parts = [];
  if (invoices.length) parts.push(`Emailed ${invoices.length} invoice(s).`);
  if (errors.length) parts.push(`${errors.length} failed.`);
  if (xeroWarnings.length) parts.push(`${xeroWarnings.length} Xero warning(s).`);

  return {
    sent: invoices.length,
    failed: errors.length,
    invoices,
    errors,
    xero_warnings: xeroWarnings,
    message: parts.length ? parts.join(' ') : 'Nothing sent.',
  };
}
