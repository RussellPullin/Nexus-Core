/**
 * Phase 1: Master document library REST endpoints.
 *
 *  GET    /document-library/masters                    – list every master (with this org's clone state)
 *  POST   /document-library/sync                       – re-walk data/forms/templates/library/
 *  POST   /document-library/masters/:id/clone-to-org   – ensure a clone for the requester's org
 *  POST   /document-library/clone-all-to-org           – clone every active master into the requester's org
 *  PATCH  /document-library/masters/:id/pack          – change automation pack (admin/delegate)
 *  POST   /document-library/masters/:id/render         – render the document for a participant/staff record
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdminOrDelegate } from '../middleware/roles.js';
import {
  syncDocumentLibraryFromDisk,
  cloneLibraryMasterToOrg,
  cloneAllLibraryMastersForOrg,
  listLibraryMasters,
  updateLibraryMasterPack,
  updateLibraryMasterContextTags
} from '../services/documentLibrary.service.js';
import {
  listOnboardingPackDocumentsForSelection,
  VALID_PARTICIPANT_SERVICE_TYPES,
  VALID_STAFF_ONBOARDING_ROLES
} from '../services/onboardingDocumentPacks.service.js';
import { renderLibraryDocument } from '../services/documentLibraryRender.service.js';

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

router.patch('/masters/:id/pack', requireAdminOrDelegate, (req, res) => {
  try {
    const pack = req.body?.pack;
    if (!pack || typeof pack !== 'string') {
      return res.status(400).json({ error: 'pack is required' });
    }
    const updated = updateLibraryMasterPack(req.params.id, pack.trim());
    res.json(updated);
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

router.patch('/masters/:id/context-tags', requireAdminOrDelegate, (req, res) => {
  try {
    const { participant_service_types, staff_roles } = req.body || {};
    if (participant_service_types == null && staff_roles == null) {
      return res.status(400).json({ error: 'participant_service_types or staff_roles required' });
    }
    const updated = updateLibraryMasterContextTags(req.params.id, {
      participant_service_types,
      staff_roles
    });
    res.json(updated);
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

/** Documents in an onboarding pack for runtime selection modals. */
router.get('/onboarding-pack', (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'No organisation for this user' });

    const workflow = req.query?.workflow;
    if (workflow !== 'participant_onboarding' && workflow !== 'staff_onboarding') {
      return res.status(400).json({ error: 'workflow must be participant_onboarding or staff_onboarding' });
    }

    const participantServiceType = req.query?.participant_service_type || 'all';
    const staffRole = req.query?.staff_role || 'all';
    if (workflow === 'participant_onboarding' && !VALID_PARTICIPANT_SERVICE_TYPES.has(participantServiceType)) {
      return res.status(400).json({ error: 'invalid participant_service_type' });
    }
    if (workflow === 'staff_onboarding' && !VALID_STAFF_ONBOARDING_ROLES.has(staffRole)) {
      return res.status(400).json({ error: 'invalid staff_role' });
    }

    const documents = listOnboardingPackDocumentsForSelection(orgId, workflow, {
      participantServiceType,
      staffRole
    });
    res.json({ workflow, documents });
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
