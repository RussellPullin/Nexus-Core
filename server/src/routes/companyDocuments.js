/**
 * Company documents API — bulk upload, OneDrive import sync, onboarding pack wiring.
 */
import { Router } from 'express';
import multer from 'multer';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdminOrDelegate } from '../middleware/roles.js';
import {
  listOrgCompanyDocuments,
  ingestCompanyDocumentBatch,
  ingestCompanyDocumentZip,
  updateOrgCompanyDocument,
  deleteOrgCompanyDocument,
  getOrgCompanyDocumentFile,
  getCompanyDocumentSettings,
  setCompanyDocumentSettings,
  mirrorLibraryMastersToOrgDocuments,
  VALID_CATEGORIES,
  projectRoot
} from '../services/companyDocuments.service.js';
import {
  syncAllOnboardingPoliciesForOrg,
  syncCompanyDocumentToPolicyFile,
  bootstrapCompanyDocumentsForOrg
} from '../services/companyDocumentsOnboardingSync.service.js';
import {
  getOnedriveImportSettings,
  setOnedriveImportSettings,
  syncCompanyDocumentsFromOnedrive
} from '../services/companyDocumentsOnedriveImport.service.js';

const router = Router();
router.use(requireAuth);

const bulkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 100 }
});

function requesterOrgId(req) {
  return db.prepare('SELECT org_id FROM users WHERE id = ?').get(req.session?.user?.id)?.org_id || null;
}

function mimeForPath(filePath) {
  const ext = extname(filePath || '').toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === '.html') return 'text/html';
  return 'application/octet-stream';
}

router.get('/', (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.json({ documents: [], settings: null });
    res.json({
      documents: listOrgCompanyDocuments(orgId),
      settings: getCompanyDocumentSettings(orgId),
      onedrive_import: getOnedriveImportSettings(orgId)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/settings', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.' });
    const settings = setCompanyDocumentSettings(orgId, req.body || {});
    res.json(settings);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/bulk-upload', requireAdminOrDelegate, bulkUpload.array('files', 100), async (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.' });
    if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded.' });

    const syncFlag = req.body?.sync_to_onboarding;
    const result = ingestCompanyDocumentBatch(orgId, req.files, {
      category: req.body?.category || null,
      sync_to_onboarding: syncFlag === 'true' || syncFlag === true ? true : syncFlag === 'false' ? false : undefined
    });
    if (result.imported?.length) {
      try {
        result.onboarding = await syncAllOnboardingPoliciesForOrg(orgId);
      } catch (e) {
        result.onboarding_error = e.message;
      }
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/bulk-upload-zip', requireAdminOrDelegate, bulkUpload.single('file'), async (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.' });
    if (!req.file?.buffer) return res.status(400).json({ error: 'Upload a .zip file.' });
    if (!/\.zip$/i.test(req.file.originalname || '')) {
      return res.status(400).json({ error: 'File must be a .zip archive.' });
    }
    const result = ingestCompanyDocumentZip(orgId, req.file.buffer, {});
    if (result.imported?.length) {
      try {
        result.onboarding = await syncAllOnboardingPoliciesForOrg(orgId);
      } catch (e) {
        result.onboarding_error = e.message;
      }
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.' });
    const updated = updateOrgCompanyDocument(orgId, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Document not found.' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.' });
    const ok = deleteOrgCompanyDocument(orgId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Document not found.' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/file', (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation.' });
    const resolved = getOrgCompanyDocumentFile(orgId, req.params.id);
    if (!resolved?.absPath || !existsSync(resolved.absPath)) {
      return res.status(404).json({ error: 'File not found.' });
    }
    const buf = readFileSync(resolved.absPath);
    res.setHeader('Content-Type', mimeForPath(resolved.absPath));
    res.setHeader('Content-Disposition', `inline; filename="${resolved.row.slug}${extname(resolved.absPath)}"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/mirror-library', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation.' });
    const mirror = mirrorLibraryMastersToOrgDocuments(orgId);
    res.json(mirror);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync-onboarding', requireAdminOrDelegate, async (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation.' });
    const result = await syncAllOnboardingPoliciesForOrg(orgId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/sync-onboarding', requireAdminOrDelegate, async (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation.' });
    const pf = await syncCompanyDocumentToPolicyFile(orgId, req.params.id);
    res.json(pf);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/bootstrap', requireAdminOrDelegate, async (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation.' });
    const result = await bootstrapCompanyDocumentsForOrg(orgId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/meta/categories', (_req, res) => {
  res.json({ categories: [...VALID_CATEGORIES] });
});

router.patch('/onedrive-import/settings', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation.' });
    const settings = setOnedriveImportSettings(orgId, req.body || {});
    res.json(settings);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/onedrive-import/sync', requireAdminOrDelegate, async (req, res) => {
  try {
    const orgId = requesterOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation.' });
    const result = await syncCompanyDocumentsFromOnedrive(orgId, req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
