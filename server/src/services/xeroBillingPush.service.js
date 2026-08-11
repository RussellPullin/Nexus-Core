/**
 * Push Nexus billing invoices to Xero (ACCREC, AUTHORISED) for accounts receivable / payment.
 */
import { db } from '../db/index.js';
import { getXeroAccessToken, parseXeroApiBodyOrThrow, XERO_API_BASE } from '../routes/settings.js';
import { participantInvoiceIncludesGst, roundMoney } from '../lib/invoiceGst.js';

const DEFAULT_SALES_ACCOUNT = process.env.XERO_SALES_ACCOUNT_CODE?.trim() || '200';
/** Australian Xero org: GST on sales 10% */
const DEFAULT_TAX_GST = process.env.XERO_LINE_TAX_TYPE_GST?.trim() || 'OUTPUT';
/** GST-free / bas excluded (common NDIS supports) */
const DEFAULT_TAX_EXEMPT = process.env.XERO_LINE_TAX_TYPE_EXEMPT?.trim() || 'BASEXCLUDED';

/**
 * Per-org Xero line settings, so each org's chart of accounts / tax types can differ
 * (white-label: an org's own Xero setup shouldn't be constrained to Spring 2 Health's).
 * Falls back to the env-var defaults above when the org hasn't set an override.
 */
function getXeroLineSettings(orgId = null) {
  const row = orgId
    ? db.prepare('SELECT xero_sales_account_code, xero_tax_type_gst, xero_tax_type_exempt FROM business_settings WHERE org_id = ?').get(orgId)
    : db.prepare('SELECT xero_sales_account_code, xero_tax_type_gst, xero_tax_type_exempt FROM business_settings WHERE id = ?').get('default');
  return {
    salesAccount: row?.xero_sales_account_code?.trim() || DEFAULT_SALES_ACCOUNT,
    taxGst: row?.xero_tax_type_gst?.trim() || DEFAULT_TAX_GST,
    taxExempt: row?.xero_tax_type_exempt?.trim() || DEFAULT_TAX_EXEMPT
  };
}

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

/** Stable Nexus id stored in Xero ContactNumber (not shown as “Account number” on invoices). */
async function findContactByContactNumber(accessToken, tenantId, contactNumber) {
  const safe = String(contactNumber || '').replace(/"/g, '');
  if (!safe) return null;
  const where = encodeURIComponent(`ContactNumber=="${safe}"`);
  const res = await fetch(`${XERO_API_BASE}/Contacts?where=${where}`, {
    headers: xeroHeaders(accessToken, tenantId),
  });
  const text = await res.text();
  if (!res.ok) return null;
  let data;
  try {
    data = parseXeroApiBodyOrThrow(text, 'Xero Contacts lookup (ContactNumber)', res.status);
  } catch {
    return null;
  }
  const list = data?.Contacts;
  return Array.isArray(list) && list[0]?.ContactID ? list[0].ContactID : null;
}

async function createXeroContact(accessToken, tenantId, { participantId, name, email, ndisNumber }) {
  const displayName = (name || 'Participant').slice(0, 500);
  const ndis = (ndisNumber && String(ndisNumber).trim()) ? String(ndisNumber).trim().slice(0, 500) : '';
  const addresses =
    ndis.length > 0
      ? [{ AddressType: 'STREET', AddressLine1: `NDIS ${ndis}`.slice(0, 500) }]
      : undefined;
  const body = {
    Contacts: [
      {
        Name: displayName,
        ContactNumber: participantId.slice(0, 50),
        ...(addresses ? { Addresses: addresses } : {}),
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

async function ensureXeroContact(accessToken, tenantId, participantId, participantName, invoiceEmails, ndisNumber) {
  const existing =
    (await findContactByContactNumber(accessToken, tenantId, participantId)) ||
    (await findContactByAccountNumber(accessToken, tenantId, participantId));
  if (existing) return existing;
  const email = Array.isArray(invoiceEmails) && invoiceEmails.length > 0 ? String(invoiceEmails[0]) : null;
  return createXeroContact(accessToken, tenantId, {
    participantId,
    name: participantName,
    email,
    ndisNumber,
  });
}

/** Same order as Nexus PDFs: participant invoice_emails, else plan manager org email, else participant email (self-managed). */
export function resolveInvoiceEmailsForXero(parsedEmails, managementType, planManagerEmail, participantEmail) {
  const list = Array.isArray(parsedEmails)
    ? parsedEmails.map((e) => String(e).trim()).filter((e) => e.includes('@'))
    : [];
  if (list.length > 0) return list;
  const mt = (managementType || 'self').toLowerCase();
  const pm = String(planManagerEmail || '').trim();
  if (mt === 'plan' && pm.includes('@')) return [pm];
  const pe = String(participantEmail || '').trim();
  if (mt === 'self' && pe.includes('@')) return [pe];
  return [];
}

/**
 * Create an AUTHORISED sales invoice in Xero. Amounts are exclusive of GST; tax type per participant setting.
 * @returns {{ xeroInvoiceId: string, xeroInvoiceNumber: string|null }}
 */
export async function pushBillingInvoiceToXero(billingInvoiceId, orgId = null) {
  const inv = db
    .prepare(
      `
    SELECT bi.*, p.name as participant_name, p.ndis_number, p.invoice_emails, p.invoice_includes_gst, p.provider_org_id,
           p.management_type, p.email as participant_email, o.email as plan_manager_org_email
    FROM billing_invoices bi
    JOIN participants p ON p.id = bi.participant_id
    LEFT JOIN organisations o ON p.plan_manager_id = o.id
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

  const invoiceEmailsResolved = resolveInvoiceEmailsForXero(
    invoiceEmails,
    inv.management_type,
    inv.plan_manager_org_email,
    inv.participant_email
  );

  const targetOrgId = orgId || inv.provider_org_id || null;
  const { salesAccount, taxGst, taxExempt } = getXeroLineSettings(targetOrgId);
  const includesGst = participantInvoiceIncludesGst(inv.invoice_includes_gst);
  const taxType = includesGst ? taxGst : taxExempt;

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
      AccountCode: salesAccount,
      TaxType: taxType,
    };
  });

  const { accessToken, tenantId } = await getXeroAccessToken(targetOrgId);
  const contactId = await ensureXeroContact(
    accessToken,
    tenantId,
    inv.participant_id,
    inv.participant_name,
    invoiceEmailsResolved,
    inv.ndis_number
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
 * Void an ACCREC invoice in Xero (Status VOIDED). No-op if no id or Xero not linked for org.
 * @throws {Error} When Xero is linked and the void request fails.
 */
export async function voidXeroInvoiceById(xeroInvoiceUuid, orgId = null) {
  const id = String(xeroInvoiceUuid || '').trim();
  if (!id) return { skipped: true, reason: 'no_xero_id' };
  if (!isXeroLinked(orgId)) return { skipped: true, reason: 'xero_not_linked' };

  const { accessToken, tenantId } = await getXeroAccessToken(orgId);
  const payload = {
    Invoices: [
      {
        InvoiceID: id,
        Type: 'ACCREC',
        Status: 'VOIDED',
      },
    ],
  };

  const res = await fetch(`${XERO_API_BASE}/Invoices`, {
    method: 'POST',
    headers: xeroHeaders(accessToken, tenantId),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data;
  try {
    data = parseXeroApiBodyOrThrow(text, 'Xero void invoice', res.status);
  } catch (e) {
    throw new Error(e.message || 'Xero void invoice: invalid response');
  }

  const invOut = data?.Invoices?.[0];
  if (!res.ok) {
    const msg = extractXeroValidationMessage(data) || text.slice(0, 800);
    throw new Error(msg || `Xero void invoice failed (HTTP ${res.status})`);
  }
  if (invOut?.HasErrors && invOut?.ValidationErrors?.length) {
    const msg = invOut.ValidationErrors.map((v) => v.Message).filter(Boolean).join('; ');
    throw new Error(msg || 'Xero rejected voiding this invoice');
  }

  return { ok: true, xero_status: invOut?.Status || 'VOIDED' };
}

export { isXeroLinked };
