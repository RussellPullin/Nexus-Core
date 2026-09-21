import { Router } from 'express';
import { getSubscriptionAccount } from '../services/saasSubscriptionAccount.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const orgId = req.session.user?.org_id || null;
    const account = await getSubscriptionAccount(orgId, { fresh: true });
    res.json(account);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not read subscription' });
  }
});

export default router;
