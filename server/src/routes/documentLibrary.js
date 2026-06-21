/**
 * Phase 1: Master document library REST endpoints.
 *
 *  GET    /document-library/masters                    – list every master (with this org's clone state)
 *  POST   /document-library/sync                       – re-walk data/forms/templates/library/
 *  POST   /document-library/masters/:id/clone-to-org   – ensure a clone for the requester's org
 *  POST   /document-library/clone-all-to-org           – clone every active master into the requester's org
 *  POST   /document-library/masters/:id/render         – render the document for a participant/staff record
 */
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdminOrDelegate } from '../middleware/roles.js';
import {
  syncDocumentLibraryFromDisk,
  cloneLibraryMasterToOrg,
  cloneAllLibraryMastersForOrg,
  listLibraryMasters
} from '../services/documentLibrary.service.js';
import { renderLibraryDocument } from '../services/documentLibraryRender.service.js';

const VALID_STAGES = new Set(['participant_intake', 'participant_sa', 'staff_intake', 'staff_contract']);
const WORKFLOW_STAGES = {
  participant_onboarding: ['participant_intake', 'participant_sa'],
  staff_onboarding:       ['staff_intake', 'staff_contract']
};

const router = Router();
router.use(requireAuth);

function requesterOrgId(req) {
  return db.prepare('SELECT org_id FROM users WHERE id = ?').get(req.session?.user?.id)?.org_id || null;
}

router.get('/masters', (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    res.json(listLibraryMasters(orgId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync', requireAdminOrDelegate, (_req, res) => {
  try {
    const result = syncDocumentLibraryFromDisk();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/masters/:id/clone-to-org', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'No organisation for this user' });
    const cloneId = cloneLibraryMasterToOrg(req.params.id, orgId);
    res.json({ clone_id: cloneId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/clone-all-to-org', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'No organisation for this user' });
    const result = cloneAllLibraryMastersForOrg(orgId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Render a master for the requester's org. Optional body:
 *   { participant_id?, staff_id?, extra?: { token_key: value } }
 * Query:
 *   ?preview=1   – serve inline so the browser displays it (for iframe previews) instead of downloading.
 * Returns the binary directly with the correct Content-Type.
 */
router.post('/masters/:id/render', (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'No organisation for this user' });

    let participant = null;
    let staff = null;
    if (req.body?.participant_id) {
      participant = db.prepare('SELECT * FROM participants WHERE id = ?').get(req.body.participant_id);
    }
    if (req.body?.staff_id) {
      staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(req.body.staff_id);
    }

    sendRender(res, req.query?.preview === '1' ? 'inline' : 'attachment', {
      masterId: req.params.id,
      orgId,
      participant,
      staff,
      extra: req.body?.extra || {}
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET preview — convenient for `<iframe src="…">`. Picks an optional participant/staff
 * from query (`?participant_id=…`, `?staff_id=…`); otherwise falls back to a sample
 * record so org tokens always render.
 */
router.get('/masters/:id/preview', (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'No organisation for this user' });

    let participant = null;
    let staff = null;
    if (req.query?.participant_id) {
      participant = db.prepare('SELECT * FROM participants WHERE id = ?').get(req.query.participant_id);
    } else {
      participant = db
        .prepare('SELECT * FROM participants WHERE provider_org_id = ? OR plan_manager_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(orgId, orgId) || null;
    }
    if (req.query?.staff_id) {
      staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(req.query.staff_id);
    } else {
      staff = db.prepare('SELECT * FROM staff WHERE org_id = ? ORDER BY created_at DESC LIMIT 1').get(orgId) || null;
    }

    sendRender(res, 'inline', {
      masterId: req.params.id,
      orgId,
      participant,
      staff,
      extra: {}
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /send-stages?workflow=participant_onboarding|staff_onboarding
 * Returns every library master for this workflow, with an array of which stages it's in for this org.
 */
router.get('/send-stages', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'No organisation for this user' });
    const workflow = req.query.workflow || 'participant_onboarding';
    const stages = WORKFLOW_STAGES[workflow];
    if (!stages) return res.status(400).json({ error: 'Unknown workflow' });

    const masters = db.prepare(`
      SELECT m.id, m.slug, m.display_name, m.engine, m.category,
             JSON_EXTRACT(m.manifest_json, '$.pack') AS pack
      FROM document_library_masters m
      JOIN document_library_org_clones c ON c.master_id = m.id
      WHERE c.org_id = ?
        AND JSON_EXTRACT(m.manifest_json, '$.pack') = ?
        AND c.is_active = 1
        AND m.is_active = 1
      ORDER BY m.display_name COLLATE NOCASE
    `).all(orgId, workflow);

    const assigned = db.prepare(`
      SELECT master_id, stage FROM org_library_send_stages
      WHERE org_id = ? AND stage IN (${stages.map(() => '?').join(',')})
    `).all(orgId, ...stages);

    const stageMap = {};
    for (const r of assigned) {
      if (!stageMap[r.master_id]) stageMap[r.master_id] = [];
      stageMap[r.master_id].push(r.stage);
    }

    res.json({
      workflow,
      stages,
      masters: masters.map((m) => ({ ...m, active_stages: stageMap[m.id] || [] }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /send-stages
 * Body: { workflow: 'participant_onboarding', stages: { participant_intake: [masterId,...], participant_sa: [...] } }
 * Replaces the stage assignments for this org + workflow.
 */
router.put('/send-stages', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'No organisation for this user' });
    const { workflow, stages: stageAssignments } = req.body || {};
    const validStages = WORKFLOW_STAGES[workflow];
    if (!validStages) return res.status(400).json({ error: 'Unknown workflow' });
    if (!stageAssignments || typeof stageAssignments !== 'object') {
      return res.status(400).json({ error: 'stages must be an object' });
    }

    const run = db.transaction(() => {
      // Delete all current stage assignments for this org + workflow stages
      db.prepare(
        `DELETE FROM org_library_send_stages WHERE org_id = ? AND stage IN (${validStages.map(() => '?').join(',')})`
      ).run(orgId, ...validStages);

      const insert = db.prepare(
        `INSERT OR IGNORE INTO org_library_send_stages (id, org_id, master_id, stage) VALUES (?, ?, ?, ?)`
      );

      for (const stage of validStages) {
        if (!VALID_STAGES.has(stage)) continue;
        const ids = Array.isArray(stageAssignments[stage]) ? stageAssignments[stage] : [];
        for (const masterId of ids) {
          // Verify the master exists and org has a clone
          const ok = db.prepare(`
            SELECT 1 FROM document_library_masters m
            JOIN document_library_org_clones c ON c.master_id = m.id
            WHERE m.id = ? AND c.org_id = ? AND m.is_active = 1 AND c.is_active = 1
          `).get(masterId, orgId);
          if (ok) insert.run(randomUUID(), orgId, masterId, stage);
        }
      }
    });
    run();

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function sendRender(res, disposition, opts) {
  const result = renderLibraryDocument(opts);
  res.setHeader('Content-Type', result.mime);
  res.setHeader('Content-Disposition', `${disposition}; filename="${result.suggestedFilename}"`);
  res.setHeader('Cache-Control', 'no-store');
  if (result.buffer) return res.send(result.buffer);
  if (result.html != null) return res.send(result.html);
  return res.status(500).json({ error: 'Renderer returned no output' });
}

export default router;
