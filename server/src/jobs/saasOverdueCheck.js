/**
 * Check saas_invoices for overdue Nexus Core invoices. Runs daily at 9am AEST (23:00 UTC).
 * Any pending invoice past its due_at date is marked overdue and the org is marked past_due.
 */

import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

export async function run() {
  const supabase = getSupabase();
  const log = (msg, data) => console.log(`[saasOverdueCheck] ${msg}`, data || '');

  try {
    const now = new Date().toISOString();

    // Find pending invoices whose due date has passed
    const { data: overdueInvoices } = await supabase
      .from('saas_invoices')
      .select('id, org_id, invoice_number')
      .eq('status', 'pending')
      .lt('due_at', now);

    if (!overdueInvoices?.length) return;

    for (const inv of overdueInvoices) {
      await supabase
        .from('saas_invoices')
        .update({ status: 'overdue' })
        .eq('id', inv.id);

      await supabase
        .from('organizations')
        .update({ subscription_status: 'past_due', locked_at: now })
        .eq('id', inv.org_id)
        .neq('subscription_status', 'cancelled');

      log('Invoice overdue', { invoice: inv.invoice_number, orgId: inv.org_id });
    }
  } catch (err) {
    log('Overdue check failed', err.message);
  }
}

export function start() {
  cron.schedule('0 23 * * *', run); // 9am AEST
  console.log('[saasOverdueCheck] Scheduled daily at 23:00 UTC');
  run().catch((e) => console.error('[saasOverdueCheck] Initial run failed', e));
}
