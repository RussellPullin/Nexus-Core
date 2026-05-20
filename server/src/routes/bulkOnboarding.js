/**
 * Phase 7: Bulk one-click onboarding.
 *
 *   POST /api/admin/bulk-onboarding
 *   Body: { participant_ids?: string[], staff_ids?: string[] }
 *
 * Runs the participant + staff orchestrators (Phase 2 and Phase 3) over a selection.
 * Each orchestration is independent — one failure does not abort the rest. Returns a
 * per-target report so the UI can highlight rows that failed readiness.
 */
import { Router } from 'express';
import { requireAuth, requireAdminOrDelegate } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { orchestrateParticipantOnboarding } from '../services/participantOnboardingOrchestrator.service.js';
import { orchestrateStaffOnboarding } from '../services/staffOnboardingOrchestrator.service.js';

const router = Router();
router.use(requireAuth);

router.post('/bulk-onboarding', requireAdminOrDelegate, async (req, res) => {
  const userId = req.session?.user?.id || null;
  const ipHeader = req.headers['x-forwarded-for'];
  const sourceIp = (typeof ipHeader === 'string' ? ipHeader : req.ip) || null;
  const userAgent = req.headers['user-agent'] || null;

  const participantIds = Array.isArray(req.body?.participant_ids) ? req.body.participant_ids : [];
  const staffIds = Array.isArray(req.body?.staff_ids) ? req.body.staff_ids : [];

  if (!participantIds.length && !staffIds.length) {
    return res.status(400).json({ error: 'Provide participant_ids or staff_ids.' });
  }

  const orgRow = db.prepare('SELECT org_id FROM users WHERE id = ?').get(userId);
  const providerOrganisationId = orgRow?.org_id || null;

  const startedAt = new Date().toISOString();
  const results = { participants: [], staff: [] };

  for (const pid of participantIds) {
    try {
      const r = await orchestrateParticipantOnboarding({
        participantId: pid,
        providerOrganisationId,
        userId,
        actorType: 'user',
        actorId: userId,
        sourceIp,
        userAgent
      });
      results.participants.push({ id: pid, ok: r.ready !== false, summary: r });
    } catch (err) {
      results.participants.push({ id: pid, ok: false, error: err.message });
    }
  }

  for (const sid of staffIds) {
    try {
      const r = await orchestrateStaffOnboarding({
        staffId: sid,
        providerOrganisationId,
        userId,
        actorType: 'user',
        actorId: userId,
        sourceIp,
        userAgent
      });
      results.staff.push({ id: sid, ok: r.ready !== false, summary: r });
    } catch (err) {
      results.staff.push({ id: sid, ok: false, error: err.message });
    }
  }

  res.json({
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    counts: {
      participants_total: results.participants.length,
      participants_ok: results.participants.filter((r) => r.ok).length,
      staff_total: results.staff.length,
      staff_ok: results.staff.filter((r) => r.ok).length
    },
    results
  });
});

export default router;
