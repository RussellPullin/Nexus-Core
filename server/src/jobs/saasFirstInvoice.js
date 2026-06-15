/**
 * Generate first Nexus Core SaaS invoice when trial ends. Runs every hour.
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

export async function run() {
  const supabase = getSupabase();
  const log = (msg, data) => console.log(`[saasFirstInvoice] ${msg}`, data || '');

  const { data: orgs, error } = await supabase
    .from('organizations')
    .select('id, name, trial_ends_at, created_at')
    .eq('subscription_status', 'trialing')
    .lte('trial_ends_at', new Date().toISOString())
    .is('billing_anchor_date', null)
    .is('linked_shifter_org_id', null); // combined orgs handled by saasCombinedMonthlyInvoices

  if (error) { log('Failed to fetch orgs', error); return; }

  for (const org of orgs || []) {
    try {
      const trialEnd = new Date(org.trial_ends_at);

      await createSaasInvoice(org.id, 'Month 1');

      const nextExpires = new Date(trialEnd.getTime() + 30 * 24 * 60 * 60 * 1000);
      await supabase
        .from('organizations')
        .update({
          billing_anchor_date: trialEnd.toISOString(),
          subscription_status: 'active',
          subscription_expires_at: nextExpires.toISOString(),
        })
        .eq('id', org.id);

      log('First invoice created', { orgId: org.id, orgName: org.name });
    } catch (err) {
      log('First invoice failed', { orgId: org.id, error: err.message });
    }
  }
}

export function start() {
  cron.schedule('0 * * * *', run);
  console.log('[saasFirstInvoice] Scheduled hourly');
  run().catch((e) => console.error('[saasFirstInvoice] Initial run failed', e));
}
