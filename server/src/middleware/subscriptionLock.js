import { isSubscriptionOpenPath } from '../lib/saasSubscription.js';
import { getSubscriptionAccount } from '../services/saasSubscriptionAccount.js';

/**
 * Blocks signed-in API use when the organisation's Nexus Core invoice is overdue
 * or the subscription is cancelled. Login and the payment-status call stay open.
 */
export async function enforcePaidSubscription(req, res, next) {
  if (!req.session?.user?.org_id) return next();
  if (isSubscriptionOpenPath(req.originalUrl || req.path || '')) return next();
  try {
    const account = await getSubscriptionAccount(req.session.user.org_id);
    if (!account.locked) return next();
    return res.status(402).json({
      error: 'Nexus Core is paused until the subscription invoice is paid.',
      code: 'SUBSCRIPTION_LOCKED',
    });
  } catch (err) {
    console.warn('[subscription] lookup failed, leaving access open', err?.message || err);
    return next();
  }
}
