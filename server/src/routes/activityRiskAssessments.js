import { Router } from 'express';
import { readFileSync } from 'fs';
import { db } from '../db/index.js';
import {
  assignActivityRiskAssessmentToParticipant,
  createActivityRiskTemplate,
  deleteActivityRiskTemplate,
  ensureOrgActivityRiskTemplates,
  getActivityRiskTemplateFilePath,
  listActivityRiskTemplates
} from '../services/activityRiskAssessments.service.js';

const router = Router();

function orgIdForUser(userId) {
  const user = db.prepare('SELECT org_id FROM users WHERE id = ?').get(userId);
  return user?.org_id || null;
}

/** GET /api/activity-risk-assessments */
router.get('/', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return res.status(400).json({ error: 'No organisation set for your account.' });
    ensureOrgActivityRiskTemplates(orgId);
    res.json({ templates: listActivityRiskTemplates(orgId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/activity-risk-assessments — body: { activity_name } */
router.post('/', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return res.status(400).json({ error: 'No organisation set for your account.' });
    const created = createActivityRiskTemplate(orgId, req.body?.activity_name);
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** GET /api/activity-risk-assessments/:id/file — download blank template PDF */
router.get('/:id/file', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return res.status(400).json({ error: 'No organisation set for your account.' });
    const path = getActivityRiskTemplateFilePath(orgId, req.params.id);
    if (!path) return res.status(404).json({ error: 'Template not found.' });
    const row = db
      .prepare('SELECT activity_name FROM activity_risk_assessment_templates WHERE id = ?')
      .get(req.params.id);
    const slug = String(row?.activity_name || 'template')
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="health-safety-risk-assessment-${slug}.pdf"`);
    res.send(readFileSync(path));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/activity-risk-assessments/:id */
router.delete('/:id', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return res.status(400).json({ error: 'No organisation set for your account.' });
    const ok = deleteActivityRiskTemplate(orgId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Template not found.' });
    res.status(204).send();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /api/activity-risk-assessments/:id/assign — body: { participant_id } */
router.post('/:id/assign', async (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const participantId = req.body?.participant_id;
    if (!participantId) return res.status(400).json({ error: 'participant_id is required.' });
    const result = await assignActivityRiskAssessmentToParticipant(participantId, req.params.id, {
      userId: req.session.user.id
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
