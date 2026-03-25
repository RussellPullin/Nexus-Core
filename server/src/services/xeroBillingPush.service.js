/**
 * Push Nexus billing invoices to Xero (ACCREC, AUTHORISED) for accounts receivable / payment.
 */
import { db } from '../db/index.js';
import { getXeroAccessToken, parseXeroApiBodyOrThrow, XERO_API_BASE } from '../routes/settings.js';
import { participantInvoiceIncludesGst, roundMoney } from '../lib/invoiceGst.js';

const SALES_ACCOUNT = process.env.XERO_SALES_ACCOUNT_CODE?.trim() || '200';
/** Australian Xero org: GST on sales 10% */
const TAX_GST = process.env.XERO_LINE_TAX_TYPE_GST?.trim() || 'OUTPUT';
/** GST-free / bas excluded (common NDIS supports) */
const TAX_EXEMPT = process.env.XERO_LINE_TAX_TYPE_EXEMPT?.trim() || 'BASEXCLUDED';

function xeroHeaders(accessToken, tenantId) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'Xero-tenant-id': tenantId,
  };
}

function extractXeroValidationMessage(data) {
  const tryBlock = (obj) => obj?.ValidationErrors?.map((e) => e.Message).filter(Boolean).join('; ');
  const inv = data?.Invoices?.[0];
  const c = data?.Contacts?.[0];
  return tryBlock(inv) || tryBlock(c) || tryBlock(data) || null;
}

function getPaymentTermsDays(orgId = null) {
  const row = orgId
    ? db.prepare('SELECT payment_terms_days FROM business_settings WHERE org_id = ?').get(orgId)
    : db.prepare('SELECT payment_terms_days FROM business_settings WHERE id = ?').get('default');
  const envDays = parseInt(process.env.PAYMENT_TERMS_DAYS || '7', 10);
  if (row?.payment_terms_days != null && row.payment_terms_days !== '') return Number(row.payment_terms_days) || 7;
  return Number.isNaN(envDays) ? 7 : envDays;
}

function addDaysIso(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isXeroLinked(orgId = null) {
  const row = orgId
    ? db.prepare('SELECT xero_refresh_token, xero_tenant_id FROM business_settings WHERE org_id = ?').get(orgId)
    : db.prepare('SELECT xero_refresh_token, xero_tenant_id FROM business_settings WHERE id = ?').get('default');
  return !!(row?.xero_refresh_token && row?.xero_tenant_id);
}

async function findContactByAccountNumber(accessToken, tenantId, accountNumber) {
  const where = encodeURIComponent(`AccountNumber=="${accountNumber}"`);
  const res = await fetch(`${XERO_API_BASE}/Contacts?where=${where}`, {
    headers: xeroHeaders(accessToken, tenantId),
  });
  const text = await res.text();
  if (!res.ok) return null;
  let data;
  try {
    data = parseXeroApiBodyOrThrow(text, 'Xero Contacts lookup', res.status);
  } catch {
    return null;
  }
  const list = data?.Contacts;
  return Array.isArray(list) && list[0]?.ContactID ? list[0].ContactID : null;
}

async function createXeroContact(accessToken, tenantId, { participantId, name, email }) {
  const displayName = (name || 'Participant').slice(0, 500);
  const body = {
    Contacts: [
      {
        Name: displayName,
        AccountNumber: participantId,
        ...(email ? { EmailAddress: email.slice(0, 255) } : {}),
      },
    ],
  };
  const res = await fetch(`${XERO_API_BASE}/Contacts`, {
    method: 'POST',
    headers: xeroHeaders(accessToken, tenantId),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = parseXeroApiBodyOrThrow(text, 'Xero Contacts create', res.status);
  if (!res.ok) {
    const msg = extractXeroValidationMessage(data) || text.slice(0, 500);
    throw new Error(msg || `Xero contact create failed (${res.status})`);
  }
  const id = data?.Contacts?.[0]?.ContactID;
  if (!id) throw new Error('Xero did not return ContactID');
  return id;
}

async function ensureXeroContact(accessToken, tenantId, participantId, participantName, invoiceEmails) {
  const existing = await findContactByAccountNumber(accessToken, tenantId, participantId);
  if (existing) return existing;
  const email = Array.isArray(invoiceEmails) && invoiceEmails.length > 0 ? String(invoiceEmails[0]) : null;
  return createXeroContact(accessToken, tenantId, { participantId, name: participantName, email });
}

/**
 * Create an AUTHORISED sales invoice in Xero. Amounts are exclusive of GST; tax type per participant setting.
 * @returns {{ xeroInvoiceId: string, xeroInvoiceNumber: string|null }}
 */
export async function pushBillingInvoiceToXero(billingInvoiceId, orgId = null) {
  const inv = db
    .prepare(
      `
    SELECT bi.*, p.name as participant_name, p.ndis_number, p.invoice_emails, p.invoice_includes_gst, p.provider_org_id
    FROM billing_invoices bi
    JOIN participants p ON p.id = bi.participant_id
    WHERE bi.id = ?
  `
    )
    .get(billingInvoiceId);
  if (!inv) throw new Error('Invoice not found');
  if (orgId && inv.provider_org_id && String(inv.provider_org_id) !== String(orgId)) {
    const err = new Error('Invoice does not belong to your organisation');
    err.code = 'ORG_MISMATCH';
    throw err;
  }

  const items = db
    .prepare(
      'SELECT * FROM billing_invoice_line_items WHERE billing_invoice_id = ? ORDER BY line_date, created_at'
    )
    .all(billingInvoiceId);
  if (!items.length) throw new Error('Invoice has no line items');

  let invoiceEmails = [];
  try {
    invoiceEmails = JSON.parse(inv.invoice_emails || '[]');
  } catch {
    invoiceEmails = [];
  }
  if (!Array.isArray(invoiceEmails)) invoiceEmails = [];

  const includesGst = participantInvoiceIncludesGst(inv.invoice_includes_gst);
  const taxType = includesGst ? TAX_GST : TAX_EXEMPT;

  const lineItems = items.map((li) => {
    const qty = Number(li.quantity) || 0;
    const unit = roundMoney(Number(li.unit_price) || 0);
    const desc = [li.support_item_number && li.support_item_number !== '-' ? `${li.support_item_number}: ` : '', li.description || 'Line']
      .join('')
      .slice(0, 4000);
    return {
      Description: desc || 'Support',
      Quantity: qty,
      UnitAmount: unit,
      AccountCode: SALES_ACCOUNT,
      TaxType: taxType,
    };
  });

  const targetOrgId = orgId || inv.provider_org_id || null;
  const { accessToken, tenantId } = await getXeroAccessToken(targetOrgId);
  const contactId = await ensureXeroContact(
    accessToken,
    tenantId,
    inv.participant_id,
    inv.participant_name,
    invoiceEmails
  );

  const invoiceDate = inv.period_to?.slice(0, 10) || inv.period_from?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const dueDate = addDaysIso(invoiceDate, getPaymentTermsDays(targetOrgId));

  const payload = {
    Invoices: [
      {
        Type: 'ACCREC',
        Contact: { ContactID: contactId },
        DateString: `${invoiceDate}T00:00:00`,
        DueDateString: `${dueDate}T00:00:00`,
        Reference: inv.invoice_number.slice(0, 255),
        LineAmountTypes: 'Exclusive',
        Status: 'AUTHORISED',
        LineItems: lineItems,
      },
    ],
  };

  const res = await fetch(`${XERO_API_BASE}/Invoices`, {
    method: 'POST',
    headers: xeroHeaders(accessToken, tenantId),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const data = parseXeroApiBodyOrThrow(text, 'Xero Invoices create', res.status);
  if (!res.ok) {
    const msg = extractXeroValidationMessage(data) || text.slice(0, 800);
    throw new Error(msg || `Xero invoice failed (${res.status})`);
  }
  const created = data?.Invoices?.[0];
  const xeroInvoiceId = created?.InvoiceID;
  if (!xeroInvoiceId) throw new Error('Xero did not return InvoiceID');
  return {
    xeroInvoiceId,
    xeroInvoiceNumber: created?.InvoiceNumber ?? null,
  };
}

/**
 * For each draft invoice in the batch: create in Xero (if needed), set status sent and store xero_invoice_id.
 */
export async function sendBillingBatchToXero(batchRef, orgId = null) {
  if (!isXeroLinked(orgId)) {
    const err = new Error('Connect Xero in Settings (Accounting software) before sending invoices.');
    err.code = 'XERO_NOT_LINKED';
    throw err;
  }

  const pattern = `BINV-${batchRef}-%`;
  const rows = db
    .prepare(
      `
    SELECT bi.id, bi.invoice_number, bi.xero_invoice_id
    FROM billing_invoices bi
    JOIN participants p ON p.id = bi.participant_id
    WHERE bi.invoice_number LIKE ? AND bi.status = 'draft'
      ${orgId ? 'AND p.provider_org_id = ?' : ''}
    ORDER BY invoice_number
  `
    )
    .all(...(orgId ? [pattern, orgId] : [pattern]));

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
      message: 'No draft invoices to send (already sent or paid).',
    };
  }

  const invoices = [];
  const errors = [];

  for (const row of rows) {
    try {
      let xeroInvoiceId = row.xero_invoice_id || null;
      let xeroInvoiceNumber = null;

      if (!xeroInvoiceId) {
        const r = await pushBillingInvoiceToXero(row.id, orgId);
        xeroInvoiceId = r.xeroInvoiceId;
        xeroInvoiceNumber = r.xeroInvoiceNumber;
      }

      db.prepare(
        `
        UPDATE billing_invoices
        SET status = 'sent', xero_invoice_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `
      ).run(xeroInvoiceId, row.id);

      invoices.push({
        billing_invoice_id: row.id,
        invoice_number: row.invoice_number,
        xero_invoice_id: xeroInvoiceId,
        xero_invoice_number: xeroInvoiceNumber,
      });
    } catch (e) {
      errors.push({
        billing_invoice_id: row.id,
        invoice_number: row.invoice_number,
        error: e.message || String(e),
      });
    }
  }

  return {
    sent: invoices.length,
    failed: errors.length,
    invoices,
    errors,
    message:
      errors.length === 0
        ? `Sent ${invoices.length} invoice(s) to Xero.`
        : `Sent ${invoices.length} invoice(s); ${errors.length} failed. Check errors for details.`,
  };
}

export { isXeroLinked };
