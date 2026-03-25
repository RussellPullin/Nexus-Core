/**
 * Forms API - list form templates, update labels, link to process, upload template files.
 * Scoped to the current user's organisation (org_id).
 */

import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db/index.js';
import {
  ensureProviderProfile,
  seedCoreTemplates,
  getTemplateCoverage,
  updateFormTemplate as updateFormTemplateService,
  createFormTemplate as createFormTemplateService
} from '../services/onboarding.service.js';
import { getTemplatePath, getTemplateDir, getCustomTemplatePath, getCustomTemplateDir } from '../services/formTemplatePath.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB
const policyDir = join(projectRoot, 'data', 'onboarding', 'policies');

const ROUTER = Router();

/** Allowed form_type for uploads (maps to templates subdir). */
const UPLOAD_FORM_TYPES = ['privacy_consent', 'service_agreement', 'support_plan'];

function getProviderProfileForUser(userId) {
  const user = db.prepare('SELECT org_id FROM users WHERE id = ?').get(userId);
  const orgId = user?.org_id || null;
  if (!orgId) {
    const first = db.prepare('SELECT id FROM organisations ORDER BY created_at ASC LIMIT 1').get();
    return { profile: first ? ensureProviderProfile(first.id) : null, organisation_id: first?.id || null };
  }
  const profile = ensureProviderProfile(orgId);
  return { profile, organisation_id: orgId };
}

// GET /api/forms/context - current user's organisation for forms
ROUTER.get('/context', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const { profile, organisation_id } = getProviderProfileForUser(req.session.user.id);
    if (!profile) {
      return res.json({ organisation_id: null, organisation_name: null, message: 'No organisation set. Set your organisation in Admin or use the first organisation.' });
    }
    const org = db.prepare('SELECT id, name FROM organisations WHERE id = ?').get(profile.organisation_id);
    res.json({
      organisation_id: organisation_id || org?.id,
      organisation_name: org?.name || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/forms/templates - list templates with template file status (optional ?workflow=participant_onboarding|staff_onboarding)
ROUTER.get('/templates', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const { profile } = getProviderProfileForUser(req.session.user.id);
    if (!profile) {
      return res.json({ templates: [], template_files: {}, missing_core_types: [] });
    }
    seedCoreTemplates(profile.id);
    const workflow = req.query.workflow || null;
    const coverage = getTemplateCoverage(profile.id, workflow ? { workflow } : {});
    const templateFiles = {};
    for (const ft of UPLOAD_FORM_TYPES) {
      const found = getTemplatePath(ft);
      templateFiles[ft] = found ? { filename: found.path.split(/[/\\]/).pop(), has_file: true } : { has_file: false };
    }
    coverage.templates.forEach((t) => {
      if (t.form_type === 'custom' && t.id) {
        const found = getCustomTemplatePath(t.id, t.template_filename);
        templateFiles[t.id] = found ? { filename: found.path.split(/[/\\]/).pop(), has_file: true } : { has_file: false };
      }
    });
    res.json({
      templates: coverage.templates,
      template_files: templateFiles,
      missing_core_types: coverage.missing_core_types || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/forms/templates/:id - update display_name or is_active
ROUTER.patch('/templates/:id', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const { profile } = getProviderProfileForUser(req.session.user.id);
    if (!profile) return res.status(400).json({ error: 'No organisation set for your account.' });
    const template = db.prepare('SELECT id FROM form_templates WHERE id = ? AND provider_profile_id = ?').get(req.params.id, profile.id);
    if (!template) return res.status(404).json({ error: 'Form template not found.' });
    const updated = updateFormTemplateService(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/forms/templates - create a custom form (body: display_name, workflow)
ROUTER.post('/templates', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const { profile } = getProviderProfileForUser(req.session.user.id);
    if (!profile) return res.status(400).json({ error: 'No organisation set for your account.' });
    const { display_name, workflow } = req.body || {};
    const name = (display_name || '').trim();
    if (!name) return res.status(400).json({ error: 'display_name is required.' });
    const wf = workflow === 'staff_onboarding' ? 'staff_onboarding' : 'participant_onboarding';
    const created = createFormTemplateService(profile.id, { display_name: name, workflow: wf });
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/forms/templates/upload - upload template file for a form type (or template id for custom)
ROUTER.post('/templates/upload', memoryUpload.single('file'), (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const formType = req.body?.form_type || req.query?.form_type;
    const templateId = req.body?.template_id || req.query?.template_id;
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }
    const ext = (req.file.originalname || '').toLowerCase().endsWith('.docx') ? 'docx' : 'pdf';

    if (templateId) {
      const { profile } = getProviderProfileForUser(req.session.user.id);
      if (!profile) return res.status(400).json({ error: 'No organisation set.' });
      const template = db.prepare('SELECT id, template_filename FROM form_templates WHERE id = ? AND provider_profile_id = ?').get(templateId, profile.id);
      if (!template) return res.status(404).json({ error: 'Custom form template not found.' });
      const dir = getCustomTemplateDir();
      mkdirSync(dir, { recursive: true });
      const saveName = `${template.id}.${ext}`;
      const filePath = join(dir, saveName);
      writeFileSync(filePath, req.file.buffer);
      db.prepare('UPDATE form_templates SET template_filename = ?, updated_at = datetime(\'now\') WHERE id = ?').run(saveName, template.id);
      return res.json({ ok: true, template_id: template.id, filename: saveName });
    }

    if (!UPLOAD_FORM_TYPES.includes(formType)) {
      return res.status(400).json({ error: 'Invalid form_type. Use privacy_consent, service_agreement, or support_plan (or template_id for custom forms).' });
    }
    const dir = getTemplateDir(formType);
    if (!dir) return res.status(400).json({ error: 'Invalid form type.' });
    if (formType === 'privacy_consent' && ext !== 'docx') {
      return res.status(400).json({ error: 'Privacy consent template must be a .docx file.' });
    }
    mkdirSync(dir, { recursive: true });
    const filename = (req.file.originalname && /^[^/\\]+\.(pdf|docx)$/i.test(req.file.originalname))
      ? req.file.originalname
      : `template.${ext}`;
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = join(dir, safeName);
    writeFileSync(filePath, req.file.buffer);
    res.json({ ok: true, form_type: formType, filename: safeName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PLACEHOLDER: connect policy PDF upload to the list used in onboarding emails (company_policy_files)
// GET /api/forms/policy-files - list company policy PDFs for onboarding
ROUTER.get('/policy-files', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const { profile } = getProviderProfileForUser(req.session.user.id);
    if (!profile) return res.json([]);
    const list = db.prepare('SELECT id, display_name, file_path, created_at FROM company_policy_files WHERE provider_profile_id = ? ORDER BY display_name').all(profile.id);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/forms/policy-files - upload company policy PDF
ROUTER.post('/policy-files', memoryUpload.single('file'), (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const { profile } = getProviderProfileForUser(req.session.user.id);
    if (!profile) return res.status(400).json({ error: 'No organisation set' });
    if (!req.file?.buffer) return res.status(400).json({ error: 'No file uploaded' });
    const displayName = (req.body?.display_name || req.file.originalname || 'policy').trim().replace(/\.pdf$/i, '') || 'policy';
    mkdirSync(policyDir, { recursive: true });
    const id = uuidv4();
    const filename = `${id}.pdf`;
    const filePath = join(policyDir, filename);
    writeFileSync(filePath, req.file.buffer);
    const relPath = join('data', 'onboarding', 'policies', filename);
    db.prepare('INSERT INTO company_policy_files (id, provider_profile_id, display_name, file_path) VALUES (?, ?, ?, ?)').run(id, profile.id, displayName, relPath);
    res.status(201).json({ id, display_name: displayName, file_path: relPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/forms/policy-files/:id
ROUTER.delete('/policy-files/:id', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const { profile } = getProviderProfileForUser(req.session.user.id);
    if (!profile) return res.status(400).json({ error: 'No organisation set' });
    const row = db.prepare('SELECT id, file_path FROM company_policy_files WHERE id = ? AND provider_profile_id = ?').get(req.params.id, profile.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM company_policy_files WHERE id = ?').run(req.params.id);
    const fullPath = join(projectRoot, row.file_path);
    if (existsSync(fullPath)) {
      try { unlinkSync(fullPath); } catch {}
    }
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default ROUTER;
