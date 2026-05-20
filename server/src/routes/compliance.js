/**
 * Phase 7: Compliance dashboard endpoints.
 *
 *   GET  /api/compliance/practice-standards          — reference + per-org status
 *   PUT  /api/compliance/practice-standards/:id      — record review status / notes / evidence
 */
import { Router } from 'express';
import { requireAuth, requireAdminOrDelegate } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { getOrgPracticeStandards, upsertOrgStandardStatus } from '../services/practiceStandards.service.js';

const router = Router();
router.use(requireAuth);

function resolveOrgId(req) {
  const userId = req.session?.user?.id;
  const row = db.prepare('SELECT org_id FROM users WHERE id = ?').get(userId);
  return row?.org_id || null;
}

router.get('/practice-standards', (req, res) => {
  try {
    const orgId = resolveOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'User is not associated with an organisation.' });
    const standards = getOrgPracticeStandards(orgId);
    const coverage = standards.length
      ? standards.reduce((sum, s) => sum + (s.evidence_coverage || 0), 0) / standards.length
      : 0;
    const reviewedRecently = standards.filter((s) => {
      if (!s.last_reviewed_at) return false;
      return Date.now() - new Date(s.last_reviewed_at).getTime() < 365 * 24 * 60 * 60 * 1000;
    }).length;
    res.json({
      organisation_id: orgId,
      summary: {
        total_standards: standards.length,
        evidence_coverage: coverage,
        reviewed_in_last_year: reviewedRecently
      },
      standards
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/practice-standards/:id', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = resolveOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'User is not associated with an organisation.' });
    const result = upsertOrgStandardStatus({
      orgId,
      standardId: req.params.id,
      status: req.body?.status,
      notes: req.body?.notes,
      evidencePolicySlug: req.body?.evidence_policy_slug,
      evidenceRegisterSlug: req.body?.evidence_register_slug,
      lastReviewedAt: req.body?.last_reviewed_at,
      reviewDueAt: req.body?.review_due_at,
      userId: req.session?.user?.id || null
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
