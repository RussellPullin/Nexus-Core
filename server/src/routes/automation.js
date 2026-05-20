/**
 * Phase 6: Daily automation endpoints.
 *
 *   POST /api/automation/tick               — run the daily sweep (auth: session OR CRON_API_KEY)
 *   GET  /api/automation/daily-digest       — coordinator dashboard payload (auth required)
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { runDailyAutomationTick, getCoordinatorDailyDigest } from '../services/dailyAutomation.service.js';

const router = Router();

function authoriseTick(req) {
  if (req.session?.user?.id) return { ok: true, actorType: 'user', actorId: req.session.user.id };
  const headerKey = req.headers['x-cron-key'] || req.query?.cron_key || null;
  if (process.env.CRON_API_KEY && headerKey === process.env.CRON_API_KEY) {
    return { ok: true, actorType: 'cron', actorId: 'cron' };
  }
  return { ok: false };
}

router.post('/tick', async (req, res) => {
  const auth = authoriseTick(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorised. Provide session or X-Cron-Key.' });
  try {
    const result = await runDailyAutomationTick({
      orgId: req.body?.organisation_id || null,
      actorType: auth.actorType,
      actorId: auth.actorId
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/daily-digest', requireAuth, (req, res) => {
  try {
    const userId = req.session?.user?.id;
    const orgRow = db.prepare('SELECT org_id FROM users WHERE id = ?').get(userId);
    const digest = getCoordinatorDailyDigest(userId, orgRow?.org_id || null);
    res.json(digest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
