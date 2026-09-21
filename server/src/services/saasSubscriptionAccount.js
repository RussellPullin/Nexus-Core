import { createClient } from '@supabase/supabase-js';
import { buildSubscriptionAccount, shouldUnlockAfterPayment } from '../lib/saasSubscription.js';

const CACHE_MS = 15_000;
const cache = new Map();

function getSupabase() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function invalidateSubscriptionCache(orgId) {
  if (orgId) cache.delete(String(orgId));
  else cache.clear();
}

const OPEN_ACCOUNT = {
  locked: false,
  subscription_status: null,
  organization_name: null,
  invoices: [],
  bank: null,
};

/**
 * Billing status for the signed-in organisation.
 * Missing Supabase config or a missing billing row leaves access open so a
 * lookup failure does not take the product offline.
 */
export async function getSubscriptionAccount(orgId, { fresh = false } = {}) {
  const id = String(orgId || '').trim();
  if (!id) return { ...OPEN_ACCOUNT, reason: 'no_org' };

  const now = Date.now();
  if (!fresh) {
    const hit = cache.get(id);
    if (hit && hit.expires > now) return hit.account;
  }

  const supabase = getSupabase();
  if (!supabase) return { ...OPEN_ACCOUNT, reason: 'billing_not_configured' };

  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('id, name, subscription_status')
    .eq('id', id)
    .maybeSingle();
  if (orgError || !org) return { ...OPEN_ACCOUNT, reason: 'org_not_in_billing' };

  const { data: invoices, error: invoiceError } = await supabase
    .from('saas_invoices')
    .select('id, invoice_number, period_label, total, status, due_at, line_items')
    .eq('org_id', id)
    .in('status', ['pending', 'overdue'])
    .order('issued_at', { ascending: true });
  if (invoiceError) return { ...OPEN_ACCOUNT, reason: 'invoice_lookup_failed' };

  const account = buildSubscriptionAccount({ org, invoices: invoices || [] });
  cache.set(id, { expires: now + CACHE_MS, account });
  return account;
}

/** After a payment or void, unlock only when no Nexus invoice is still unpaid. */
export async function settleOrgAfterInvoiceChange(orgId) {
  const id = String(orgId || '').trim();
  const supabase = getSupabase();
  invalidateSubscriptionCache(id);
  if (!supabase || !id) return { unlocked: false };

  const { count, error: countError } = await supabase
    .from('saas_invoices')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', id)
    .in('status', ['pending', 'overdue']);
  if (countError) return { unlocked: false };

  const { data: org } = await supabase
    .from('organizations')
    .select('subscription_status')
    .eq('id', id)
    .maybeSingle();

  if (!shouldUnlockAfterPayment(count || 0, org?.subscription_status)) {
    return { unlocked: false };
  }

  await supabase
    .from('organizations')
    .update({ subscription_status: 'active', locked_at: null })
    .eq('id', id);
  invalidateSubscriptionCache(id);
  return { unlocked: true };
}
