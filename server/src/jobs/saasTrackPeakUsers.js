/**
 * Track peak user count per billing period for Nexus Core SaaS billing.
 * Counts profiles per org_id. Runs every hour.
 */

import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

function getCurrentPeriodStart(anchorDate) {
  const anchor = new Date(anchorDate);
  const now = new Date();
  let start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  while (start <= now) {
    const next = new Date(start);
    next.setMonth(next.getMonth() + 1);
    if (next > now) break;
    start = next;
  }
  return start;
}

function getCurrentPeriodEnd(periodStart) {
  const end = new Date(periodStart);
  end.setMonth(end.getMonth() + 1);
  return end;
}

export async function run() {
  const supabase = getSupabase();
  const log = (msg, data) => console.log(`[saasTrackPeakUsers] ${msg}`, data || '');

  const { data: orgs, error } = await supabase
    .from('organizations')
    .select('id, created_at, trial_ends_at, billing_anchor_date')
    .in('subscription_status', ['trialing', 'active', 'past_due']);

  if (error) { log('Failed to fetch orgs', error); return; }

  for (const org of orgs || []) {
    try {
      let periodStart, periodEnd;
      if (!org.billing_anchor_date) {
        periodStart = new Date(org.created_at || org.trial_ends_at);
        periodEnd = new Date(org.trial_ends_at);
      } else {
        periodStart = getCurrentPeriodStart(org.billing_anchor_date);
        periodEnd = getCurrentPeriodEnd(periodStart);
      }

      const { count, error: countErr } = await supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', org.id);

      if (countErr) { log(`Org ${org.id} count failed`, countErr); continue; }

      const currentCount = count ?? 0;

      const { data: existing } = await supabase
        .from('org_user_peak_counts')
        .select('id, peak_user_count')
        .eq('org_id', org.id)
        .eq('billing_period_start', periodStart.toISOString())
        .single();

      if (existing) {
        if (currentCount > existing.peak_user_count) {
          await supabase
            .from('org_user_peak_counts')
            .update({ peak_user_count: currentCount, recorded_at: new Date().toISOString() })
            .eq('id', existing.id);
        }
      } else {
        await supabase.from('org_user_peak_counts').insert({
          org_id: org.id,
          billing_period_start: periodStart.toISOString(),
          billing_period_end: periodEnd.toISOString(),
          peak_user_count: currentCount,
        });
        log(`Org ${org.id} peak recorded`, { currentCount });
      }
    } catch (err) {
      log(`Org ${org.id} error`, err.message);
    }
  }
}

export function start() {
  cron.schedule('0 * * * *', run);
  console.log('[saasTrackPeakUsers] Scheduled hourly');
  run().catch((e) => console.error('[saasTrackPeakUsers] Initial run failed', e));
}
