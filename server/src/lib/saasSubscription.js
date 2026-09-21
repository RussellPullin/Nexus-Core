/**
 * Nexus Core subscription access.
 * Shifter is billed on the same Nexus Core invoice, so reminders and the
 * payment lock both live here. One unpaid Nexus invoice covers both.
 */

export const SAAS_BANK = {
  bsb: '923-100',
  account: '811730015',
  account_name: 'Nexus Core Solutions',
  abn: '75 249 898 796',
};

const OPEN_PREFIXES = [
  '/api/auth',
  '/api/saas/billing',
  '/api/saas/subscription',
  '/api/public',
  '/api/webhooks',
  '/api/email/oauth',
  '/api/integrations',
  '/api/intake',
  '/api/sign',
];

export function isSubscriptionOpenPath(path) {
  const bare = String(path || '').split('?')[0];
  return OPEN_PREFIXES.some((prefix) => bare === prefix || bare.startsWith(`${prefix}/`));
}

export function isSubscriptionLocked(status) {
  return status === 'past_due' || status === 'cancelled';
}

/**
 * Organisations owned by the vendor. They use Nexus Core and are not customers,
 * so unpaid invoices must not lock them or generate further bills.
 */
export function isOwnerOrganisation(name) {
  const compact = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  if (!compact) return false;
  return compact.startsWith('nexuscore') || compact.startsWith('spring2health');
}

/** Unlock only when every Nexus invoice is settled and the org was not cancelled. */
export function shouldUnlockAfterPayment(remainingUnpaid, currentStatus) {
  if (currentStatus === 'cancelled') return false;
  return Number(remainingUnpaid) === 0;
}

export function reminderCoverageLine(lineItems) {
  const coversShifter = Array.isArray(lineItems) && lineItems.some((line) => line?.app === 'shifter');
  if (coversShifter) {
    return 'This invoice covers Nexus Core and Shifter. Shifter is part of Nexus Core, so this is the only reminder you will receive.';
  }
  return 'This is your Nexus Core subscription invoice. Shifter is included with Nexus Core and does not send its own reminders.';
}

export function buildSubscriptionAccount({ org, invoices }) {
  const unpaid = (invoices || []).filter((inv) => inv.status === 'pending' || inv.status === 'overdue');
  const status = org?.subscription_status || null;
  const owner = isOwnerOrganisation(org?.name);
  return {
    locked: Boolean(org) && !owner && isSubscriptionLocked(status),
    billing_exempt: owner,
    subscription_status: status,
    organization_name: org?.name || null,
    invoices: unpaid.map((inv) => ({
      id: inv.id,
      invoice_number: inv.invoice_number || null,
      period_label: inv.period_label || null,
      total: Number(inv.total || 0),
      status: inv.status,
      due_at: inv.due_at || null,
      covers_shifter: Array.isArray(inv.line_items) && inv.line_items.some((line) => line?.app === 'shifter'),
    })),
    bank: SAAS_BANK,
  };
}
