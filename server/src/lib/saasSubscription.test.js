import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSubscriptionAccount,
  isSubscriptionLocked,
  isSubscriptionOpenPath,
  reminderCoverageLine,
  shouldUnlockAfterPayment,
} from './saasSubscription.js';

test('trial and active organisations stay open', () => {
  assert.equal(isSubscriptionLocked('trialing'), false);
  assert.equal(isSubscriptionLocked('active'), false);
  assert.equal(isSubscriptionLocked(null), false);
});

test('past due and cancelled organisations are locked', () => {
  assert.equal(isSubscriptionLocked('past_due'), true);
  assert.equal(isSubscriptionLocked('cancelled'), true);
});

test('marking one invoice paid stays locked while another invoice is unpaid', () => {
  assert.equal(shouldUnlockAfterPayment(1, 'past_due'), false);
  assert.equal(shouldUnlockAfterPayment(0, 'past_due'), true);
  assert.equal(shouldUnlockAfterPayment(0, 'cancelled'), false);
});

test('login, billing dashboard, and public links stay available while locked', () => {
  assert.equal(isSubscriptionOpenPath('/api/auth/me'), true);
  assert.equal(isSubscriptionOpenPath('/api/saas/billing/dashboard'), true);
  assert.equal(isSubscriptionOpenPath('/api/saas/subscription'), true);
  assert.equal(isSubscriptionOpenPath('/api/intake/abc'), true);
  assert.equal(isSubscriptionOpenPath('/api/participants'), false);
  assert.equal(isSubscriptionOpenPath('/api/billing'), false);
});

test('owner organisations stay open even when an invoice is overdue', () => {
  for (const name of ['Nexus Core solutions', 'nexus core solutions', 'Spring 2 Health']) {
    const account = buildSubscriptionAccount({
      org: { name, subscription_status: 'past_due' },
      invoices: [{ id: 'inv-1', invoice_number: 'NC-1', total: 69, status: 'overdue' }],
    });
    assert.equal(account.locked, false, name);
    assert.equal(account.billing_exempt, true, name);
  }
});

test('payment screen payload lists unpaid Nexus invoices and bank details', () => {
  const account = buildSubscriptionAccount({
    org: { name: 'Community Care links', subscription_status: 'past_due' },
    invoices: [
      {
        id: 'inv-1',
        invoice_number: 'NC-SPRI-202609-100',
        period_label: 'September 2026',
        total: 89,
        status: 'overdue',
        due_at: '2026-09-01T00:00:00.000Z',
        line_items: [{ app: 'shifter' }, { app: 'nexus_core' }],
      },
      {
        id: 'inv-2',
        invoice_number: 'NC-SPRI-202608-100',
        total: 69,
        status: 'paid',
      },
    ],
  });
  assert.equal(account.locked, true);
  assert.equal(account.billing_exempt, false);
  assert.equal(account.organization_name, 'Community Care links');
  assert.equal(account.invoices.length, 1);
  assert.equal(account.invoices[0].invoice_number, 'NC-SPRI-202609-100');
  assert.equal(account.invoices[0].covers_shifter, true);
  assert.equal(account.bank.bsb, '923-100');
  assert.equal(account.bank.account, '811730015');
});

test('an organisation that is not past due is not locked even with a pending invoice', () => {
  const account = buildSubscriptionAccount({
    org: { name: 'Trial Org', subscription_status: 'active' },
    invoices: [{ id: 'inv-1', invoice_number: 'NC-1', total: 69, status: 'pending' }],
  });
  assert.equal(account.locked, false);
  assert.equal(account.invoices.length, 1);
});

test('reminder copy is one Nexus Core invoice, including Shifter when it is on the bill', () => {
  assert.match(reminderCoverageLine([{ app: 'shifter' }]), /only reminder/i);
  assert.match(reminderCoverageLine([]), /does not send its own reminders/i);
});
