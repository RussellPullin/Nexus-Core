/**
 * Generate monthly Nexus Core SaaS invoices. Runs every hour.
 */

import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import { createSaasInvoice } from '../services/saasInvoiceService.js';

function getSupabase() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

function getPeriodLabel(periodStart) {
  const d = new Date(periodStart);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[d.getMonth()]} ${d.getFullYear()}`;
}

export async function run() {
  const supabase = getSupabase();
  const log = (msg, data) => console.log(`[saasMonthlyInvoices] ${msg}`, data || '');

  const { data: orgs, error } = await supabase
    .from('organizations')
    .select('id, name, billing_anchor_date, subscription_expires_at')
    .in('subscription_status', ['active', 'past_due'])
    .not('billing_anchor_date', 'is', null)
    .lte('subscription_expires_at', new Date().toISOString())
    .is('linked_shifter_org_id', null); // combined orgs handled by saasCombinedMonthlyInvoices

  if (error) { log('Failed to fetch orgs', error); return; }

  for (const org of orgs || []) {
    try {
      const periodEnd = new Date(org.subscription_expires_at);
      const periodStart = new Date(periodEnd);
      periodStart.setMonth(periodStart.getMonth() - 1);
      const periodLabel = getPeriodLabel(periodStart);

      await createSaasInvoice(org.id, periodLabel);

      const nextExpires = new Date(org.subscription_expires_at);
      nextExpires.setMonth(nextExpires.getMonth() + 1);
      await supabase
        .from('organizations')
        .update({ subscription_expires_at: nextExpires.toISOString() })
        .eq('id', org.id);

      log('Monthly invoice created', { orgId: org.id, orgName: org.name, periodLabel });
    } catch (err) {
      log('Monthly invoice failed', { orgId: org.id, error: err.message });
    }
  }
}

export function start() {
  cron.schedule('0 * * * *', run);
  console.log('[saasMonthlyInvoices] Scheduled hourly');
  run().catch((e) => console.error('[saasMonthlyInvoices] Initial run failed', e));
}
