/**
 * Xero service for Nexus Core SaaS billing.
 * Creates contacts and ACCREC invoices for orgs paying to use Nexus Core.
 * Uses xero_saas_tokens table (separate from per-org Xero tokens used for NDIS invoicing).
 */

import { createClient } from '@supabase/supabase-js';
import { MONTHLY_FLAT_RATE, calculateInvoiceAmount } from '../lib/saasBillingTiers.js';

const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const VENDOR_FALLBACK_EMAIL = 'nexuscoresolutions@outlook.com';

function getSupabase() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

async function refreshTokens(refreshToken) {
  const clientId = process.env.XERO_SAAS_CLIENT_ID || process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_SAAS_CLIENT_SECRET || process.env.XERO_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('XERO_SAAS_CLIENT_ID and XERO_SAAS_CLIENT_SECRET required');

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${auth}`,
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Xero token refresh failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_in: data.expires_in || 1800,
  };
}

async function getValidToken() {
  const supabase = getSupabase();
  const { data: row, error } = await supabase
    .from('xero_saas_tokens')
    .select('access_token, refresh_token, expires_at, tenant_id')
    .eq('id', 1)
    .single();

  if (error || !row) throw new Error('No Nexus Core Xero tokens. Run /auth/xero-saas to connect.');

  const now = new Date();
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  const needsRefresh = !expiresAt || expiresAt.getTime() - TOKEN_REFRESH_BUFFER_MS < now.getTime();

  if (needsRefresh && row.refresh_token) {
    const tokens = await refreshTokens(row.refresh_token);
    const newExpiresAt = new Date(now.getTime() + tokens.expires_in * 1000);
    await supabase.from('xero_saas_tokens').upsert(
      { id: 1, access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: newExpiresAt.toISOString() },
      { onConflict: 'id' }
    );
    return { accessToken: tokens.access_token, tenantId: row.tenant_id };
  }

  if (!row.access_token) throw new Error('No Xero access token. Run /auth/xero-saas to connect.');
  return { accessToken: row.access_token, tenantId: row.tenant_id };
}

function xeroHeaders(accessToken, tenantId) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Xero-Tenant-Id': tenantId || process.env.XERO_SAAS_TENANT_ID || '',
  };
}

async function xeroRequest(method, path, body = null) {
  const { accessToken, tenantId } = await getValidToken();
  const url = `${XERO_API_BASE}${path}`;
  const opts = { method, headers: xeroHeaders(accessToken, tenantId) };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Xero API ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

/**
 * Ensure org has a Xero contact. Create if missing.
 * Email priority: org.billing_email → admin profile email → vendor fallback
 */
async function ensureXeroContact(orgId) {
  const supabase = getSupabase();
  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('id, name, xero_contact_id, billing_email')
    .eq('id', orgId)
    .single();

  if (orgError || !org) throw new Error(`Org not found: ${orgId}`);
  if (org.xero_contact_id) return org.xero_contact_id;

  let email = org.billing_email || null;
  if (!email) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('email')
      .eq('org_id', orgId)
      .order('created_at', { ascending: true })
      .limit(1)
      .single();
    email = profile?.email || null;
  }
  if (!email) email = VENDOR_FALLBACK_EMAIL;

  const created = await xeroRequest('POST', '/Contacts', {
    Contacts: [{ Name: org.name || 'Nexus Core Org', EmailAddress: email }],
  });
  const contact = created?.Contacts?.[0];
  if (!contact?.ContactID) throw new Error('Failed to create Xero contact');

  await supabase.from('organizations').update({ xero_contact_id: contact.ContactID }).eq('id', orgId);
  return contact.ContactID;
}

/**
 * Create an ACCREC invoice in Xero for an org's billing period.
 * @param {string} orgId
 * @param {string} periodLabel - e.g. 'Month 1', 'June 2026'
 */
export async function createSaasInvoice(orgId, periodLabel) {
  const { subtotal, gst, total } = calculateInvoiceAmount();
  const contactId = await ensureXeroContact(orgId);

  const today = new Date().toISOString().split('T')[0];
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 14);
  const dueDateStr = dueDate.toISOString().split('T')[0];

  const result = await xeroRequest('POST', '/Invoices', {
    Invoices: [
      {
        Type: 'ACCREC',
        Contact: { ContactID: contactId },
        Date: today,
        DueDate: dueDateStr,
        Status: 'AUTHORISED',
        LineItems: [
          {
            Description: `Nexus Core – ${periodLabel}`,
            Quantity: 1,
            UnitAmount: MONTHLY_FLAT_RATE,
            TaxType: 'OUTPUT2',
            AccountCode: process.env.XERO_SAAS_ACCOUNT_CODE || '200',
          },
        ],
      },
    ],
  });

  const invoice = result?.Invoices?.[0];
  if (!invoice?.InvoiceID) throw new Error('Failed to create Xero invoice');

  const supabase = getSupabase();
  await supabase.from('saas_invoices').insert({
    org_id: orgId,
    xero_invoice_id: invoice.InvoiceID,
    period_label: periodLabel,
    subtotal,
    gst,
    total,
    status: 'pending',
    issued_at: new Date().toISOString(),
    due_at: dueDate.toISOString(),
  });

  return { invoiceId: invoice.InvoiceID, total };
}

export { ensureXeroContact, getValidToken };
