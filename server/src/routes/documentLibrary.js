/**
 * Phase 1: Master document library REST endpoints.
 *
 *  GET    /document-library/masters                    – list every master (with this org's clone state)
 *  POST   /document-library/sync                       – re-walk data/forms/templates/library/
 *  POST   /document-library/masters/:id/clone-to-org   – ensure a clone for the requester's org
 *  POST   /document-library/clone-all-to-org            – clone every active master into the requester's org
 *  PATCH  /document-library/masters/:id/pack          – change automation pack (admin/delegate, legacy)
 *  PATCH  /document-library/masters/:id/packs         – change automation packs (admin/delegate)
 *  POST   /document-library/masters/:id/render         – render the document for a participant/staff record
 *
 * Per-org content overrides (policy-category masters only — see documentLibrary.service.js):
 *  GET    /document-library/masters/:id/sections            – master's section list
 *  GET    /document-library/org/masters/:id/overrides        – this org's override_mode + section overrides
 *  PUT    /document-library/org/masters/:id/mode              – switch inherit | sections | full_upload
 *  PUT    /document-library/org/masters/:id/sections/:key    – save one section override
 *  DELETE /document-library/org/masters/:id/sections/:key    – revert one section to master
 *  POST   /document-library/org/masters/:id/upload            – upload a full replacement document
 */
import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdminOrDelegate } from '../middleware/roles.js';
import {
  syncDocumentLibraryFromDisk,
  cloneLibraryMasterToOrg,
  cloneAllLibraryMastersForOrg,
  listLibraryMasters,
  updateLibraryMasterPack,
  updateLibraryMasterPacks,
  updateLibraryMasterContextTags,
  getMasterSections,
  listOrgSectionOverrides,
  upsertOrgSectionOverride,
  deleteOrgSectionOverride,
  setOrgCloneOverrideMode,
  getOrgFullUploadDocument,
  upsertOrgFullUploadDocument
} from '../services/documentLibrary.service.js';
import {
  listOnboardingPackDocumentsForSelection,
  VALID_PARTICIPANT_SERVICE_TYPES,
  VALID_STAFF_ONBOARDING_ROLES
} from '../services/onboardingDocumentPacks.service.js';
import { renderLibraryDocument } from '../services/documentLibraryRender.service.js';
import { resolveActiveServiceAgreementTemplate, CORE_SERVICE_AGREEMENT_MASTER_ID } from '../services/onboarding.service.js';

const router = Router();
router.use(requireAuth);

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB
const orgDocumentsDir = join(process.env.DATA_DIR || join(projectRoot, 'data'), 'org-documents');

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

router.patch('/masters/:id/packs', requireAdminOrDelegate, (req, res) => {
  try {
    const packs = req.body?.packs;
    if (!Array.isArray(packs)) {
      return res.status(400).json({ error: 'packs must be an array' });
    }
    const updated = updateLibraryMasterPacks(req.params.id, packs);
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

/** A policy master's section list (empty for non-policy / non-docxtemplater masters). */
router.get('/masters/:id/sections', (req, res) => {
  try {
    res.json(getMasterSections(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** This org's current override mode + saved section overrides for a master. */
router.get('/org/masters/:id/overrides', (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'No organisation for this user' });
    const clone = db
      .prepare('SELECT override_mode FROM document_library_org_clones WHERE org_id = ? AND master_id = ?')
      .get(orgId, req.params.id);
    res.json({
      override_mode: clone?.override_mode || 'inherit',
      section_overrides: listOrgSectionOverrides(orgId, req.params.id),
      full_upload: getOrgFullUploadDocument(orgId, req.params.id)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Switch an org's clone between inherit / sections / full_upload. */
router.put('/org/masters/:id/mode', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'No organisation for this user' });
    const mode = req.body?.mode;
    setOrgCloneOverrideMode(orgId, req.params.id, mode);
    res.json({ override_mode: mode });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Save (or update) an org's override for one section. */
router.put('/org/masters/:id/sections/:key', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'No organisation for this user' });
    const contentHtml = req.body?.content_html;
    upsertOrgSectionOverride(orgId, req.params.id, req.params.key, contentHtml, req.session?.user?.id || null);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Revert one section back to the master's own content. */
router.delete('/org/masters/:id/sections/:key', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'No organisation for this user' });
    deleteOrgSectionOverride(orgId, req.params.id, req.params.key);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Upload a full replacement document for this master (switches the clone to full_upload mode). */
router.post('/org/masters/:id/upload', requireAdminOrDelegate, memoryUpload.single('file'), (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'No organisation for this user' });
    if (!req.file?.buffer) return res.status(400).json({ error: 'No file uploaded' });

    const mime = req.file.mimetype;
    const isDocx = mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const isPdf = mime === 'application/pdf';
    if (!isDocx && !isPdf) {
      return res.status(400).json({ error: 'Only .docx or .pdf uploads are supported' });
    }

    mkdirSync(orgDocumentsDir, { recursive: true });
    const ext = isDocx ? 'docx' : 'pdf';
    const filename = `${req.params.id}-${orgId}-${Date.now()}.${ext}`;
    writeFileSync(join(orgDocumentsDir, filename), req.file.buffer);
    const relPath = join('data', 'org-documents', filename);

    setOrgCloneOverrideMode(orgId, req.params.id, 'full_upload');
    upsertOrgFullUploadDocument({
      orgId,
      masterId: req.params.id,
      filePath: relPath,
      originalFilename: req.file.originalname,
      mime
    });
    res.status(201).json({ ok: true, file_path: relPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

    // The structured Service Agreement isn't a document_library_masters row, but the sender
    // should be able to pick it from the same list as Service Schedule etc. instead of using a
    // separate screen — see CORE_SERVICE_AGREEMENT_MASTER_ID's doc comment.
    if (workflow === 'participant_onboarding' && resolveActiveServiceAgreementTemplate(orgId)) {
      documents.push({
        id: CORE_SERVICE_AGREEMENT_MASTER_ID,
        slug: 'service_agreement',
        display_name: 'Service Agreement',
        signature_count: 2,
        requires_signature: true,
        participant_service_types: ['all'],
        staff_roles: ['all'],
        suggested: true,
        admin_fields: [
          {
            key: 'signer_type',
            label: 'Who is completing and signing this document?',
            type: 'select',
            options: ['participant', 'guardian'],
            required: true
          }
        ]
      });
    }

    res.json({ workflow, documents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync', requireAdminOrDelegate, async (_req, res) => {
  try {
    const result = await syncDocumentLibraryFromDisk();
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
