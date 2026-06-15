/**
 * Generate combined invoices for orgs that use both Nexus Core and Shifter.
 * Reads Shifter orgs with linked_nc_org_id set, fires one combined email invoice.
 * Runs every hour (same cadence as solo billing jobs).
 */

import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import { createCombinedInvoice } from '../services/combinedInvoiceService.js';

function getNcSupabase() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NC Supabase env not set');
  return createClient(url, key);
}

function getShifterSupabase() {
  const url = (process.env.SHIFTER_SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SHIFTER_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SHIFTER_SUPABASE_URL and SHIFTER_SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

function getPeriodLabel(d) {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[d.getMonth()]} ${d.getFullYear()}`;
}

export async function run() {
  const log = (msg, data) => console.log(`[combinedMonthly] ${msg}`, data || '');

  if (!process.env.SHIFTER_SUPABASE_URL) return; // skip if Shifter not configured

  const ncSupabase = getNcSupabase();
  const shifterSupabase = getShifterSupabase();

  // Find Shifter orgs due for invoicing that have a linked NC org
  const { data: shifterOrgs } = await shifterSupabase
    .from('organizations')
    .select('id, name, linked_nc_org_id, billing_anchor_date, subscription_expires_at, trial_ends_at, subscription_status')
    .not('linked_nc_org_id', 'is', null)
    .lte('subscription_expires_at', new Date().toISOString())
    .in('subscription_status', ['active', 'past_due'])
    .not('billing_anchor_date', 'is', null);

  for (const sOrg of shifterOrgs || []) {
    try {
      const periodEnd = new Date(sOrg.subscription_expires_at);
      const periodStart = new Date(periodEnd);
      periodStart.setMonth(periodStart.getMonth() - 1);
      const periodLabel = getPeriodLabel(periodStart);

      // Get peak user count for this period
      const { data: peakRows } = await shifterSupabase
        .from('org_user_peak_counts')
        .select('peak_user_count')
        .eq('org_id', sOrg.id)
        .gte('billing_period_start', periodStart.toISOString())
        .lt('billing_period_end', periodEnd.toISOString())
        .order('peak_user_count', { ascending: false })
        .limit(1);

      let userCount = peakRows?.[0]?.peak_user_count ?? null;
      if (userCount == null) {
        const { count } = await shifterSupabase
          .from('profiles')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', sOrg.id);
        userCount = count ?? 1;
      }

      await createCombinedInvoice(sOrg.linked_nc_org_id, sOrg.id, periodLabel, Math.max(1, userCount));

      // Advance subscription_expires_at on both sides
      const nextExpires = new Date(sOrg.subscription_expires_at);
      nextExpires.setMonth(nextExpires.getMonth() + 1);

      await Promise.all([
        shifterSupabase.from('organizations').update({ subscription_expires_at: nextExpires.toISOString() }).eq('id', sOrg.id),
        ncSupabase.from('organizations').update({ subscription_expires_at: nextExpires.toISOString() }).eq('id', sOrg.linked_nc_org_id),
      ]);

      log('Combined invoice created', { shifterOrg: sOrg.name, ncOrgId: sOrg.linked_nc_org_id, periodLabel, userCount });
    } catch (err) {
      log('Combined invoice failed', { orgId: sOrg.id, error: err.message });
    }
  }

  // Also handle first invoices for trialing linked orgs
  const { data: newShifterOrgs } = await shifterSupabase
    .from('organizations')
    .select('id, name, linked_nc_org_id, trial_ends_at, created_at')
    .not('linked_nc_org_id', 'is', null)
    .eq('subscription_status', 'trialing')
    .lte('trial_ends_at', new Date().toISOString())
    .is('billing_anchor_date', null);

  for (const sOrg of newShifterOrgs || []) {
    try {
      const { count } = await shifterSupabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', sOrg.id)
        .eq('is_active', true);
      const userCount = Math.max(1, count ?? 1);

      await createCombinedInvoice(sOrg.linked_nc_org_id, sOrg.id, 'Month 1', userCount);

      const trialEnd = new Date(sOrg.trial_ends_at);
      const nextExpires = new Date(trialEnd.getTime() + 30 * 24 * 60 * 60 * 1000);

      await Promise.all([
        shifterSupabase.from('organizations').update({
          billing_anchor_date: trialEnd.toISOString(),
          subscription_status: 'active',
          subscription_expires_at: nextExpires.toISOString(),
        }).eq('id', sOrg.id),
        ncSupabase.from('organizations').update({
          billing_anchor_date: trialEnd.toISOString(),
          subscription_status: 'active',
          subscription_expires_at: nextExpires.toISOString(),
        }).eq('id', sOrg.linked_nc_org_id),
      ]);

      log('First combined invoice created', { shifterOrg: sOrg.name, userCount });
    } catch (err) {
      log('First combined invoice failed', { orgId: sOrg.id, error: err.message });
    }
  }
}

export function start() {
  cron.schedule('0 * * * *', run);
  console.log('[combinedMonthly] Scheduled hourly');
  run().catch((e) => console.error('[combinedMonthly] Initial run failed', e));
}
