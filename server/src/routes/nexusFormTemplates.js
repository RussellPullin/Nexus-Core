/**
 * System form template masters + org-specific clones (Service Agreement and future types).
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db/index.js';
import { requireAdminOrDelegate } from '../middleware/roles.js';
import {
  mergeVariableValues,
  mergeBranding,
  parseJson,
  baselineVariableDefaults
} from '../services/nexusFormTemplateRuntime.service.js';
import { VARIABLE_GROUPS } from '../data/serviceAgreementSpring2V3/variableSchema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const uploadsRoot = process.env.DATA_DIR ? join(process.env.DATA_DIR, 'uploads') : join(projectRoot, 'data', 'uploads');

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(png|jpeg|jpg)$/i.test(file.mimetype);
    cb(ok ? null : new Error('Logo must be PNG or JPEG'), ok);
  }
});

function orgIdForUser(userId) {
  const u = db.prepare('SELECT org_id FROM users WHERE id = ?').get(userId);
  return u?.org_id || null;
}

const ROUTER = Router();

ROUTER.get('/masters', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const rows = db.prepare(`SELECT id, template_key, template_type, title, version_label, created_at FROM nexus_form_template_masters ORDER BY template_type`).all();
    res.json({ masters: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

ROUTER.get('/masters/:id', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const row = db.prepare(`SELECT * FROM nexus_form_template_masters WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Template master not found' });
    const schema = parseJson(row.variable_schema_json, {});
    res.json({
      master: row,
      variable_groups: VARIABLE_GROUPS,
      merged_defaults: mergeVariableValues(row.variable_schema_json, '{}')
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

ROUTER.get('/instances', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return res.json({ instances: [] });
    const rows = db
      .prepare(
        `
      SELECT i.*, m.template_key, m.template_type, m.title AS master_title, m.version_label
      FROM nexus_org_form_templates i
      JOIN nexus_form_template_masters m ON m.id = i.master_id
      WHERE i.org_id = ?
      ORDER BY datetime(i.updated_at) DESC
    `
      )
      .all(orgId);
    res.json({ instances: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

ROUTER.post('/instances', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.' });
    const masterId = req.body?.master_id || req.body?.master_definition_id;
    if (!masterId) return res.status(400).json({ error: 'master_id is required.' });
    const master = db.prepare(`SELECT * FROM nexus_form_template_masters WHERE id = ?`).get(masterId);
    if (!master) return res.status(404).json({ error: 'Master template not found.' });
    const label = String(req.body?.label || master.title || 'Service Agreement').trim();
    const id = uuidv4();
    db.prepare(
      `INSERT INTO nexus_org_form_templates (id, org_id, master_id, label, variable_values_json, branding_json, metadata_json)
       VALUES (?, ?, ?, ?, '{}', ?, '{}')`
    ).run(id, orgId, masterId, label, JSON.stringify(mergeBranding(null)));
    const created = db.prepare(`SELECT * FROM nexus_org_form_templates WHERE id = ?`).get(id);
    res.status(201).json({ instance: created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

ROUTER.patch('/instances/:id', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return res.status(400).json({ error: 'No organisation.' });
    const row = db
      .prepare(`SELECT * FROM nexus_org_form_templates WHERE id = ? AND org_id = ?`)
      .get(req.params.id, orgId);
    if (!row) return res.status(404).json({ error: 'Not found.' });

    const { label, variable_values, branding, metadata } = req.body || {};
    const updates = [];
    const params = [];
    if (label != null) {
      updates.push('label = ?');
      params.push(String(label).trim());
    }
    if (variable_values != null) {
      updates.push('variable_values_json = ?');
      params.push(JSON.stringify(variable_values));
    }
    if (branding != null) {
      updates.push('branding_json = ?');
      params.push(JSON.stringify(branding));
    }
    if (metadata != null) {
      updates.push('metadata_json = ?');
      params.push(JSON.stringify(metadata));
    }
    if (!updates.length) return res.json({ instance: row });
    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);
    db.prepare(`UPDATE nexus_org_form_templates SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    const updated = db.prepare(`SELECT * FROM nexus_org_form_templates WHERE id = ?`).get(req.params.id);
    res.json({ instance: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

ROUTER.get('/instances/:id/preview-model', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return res.status(400).json({ error: 'No organisation.' });
    const row = db
      .prepare(
        `
      SELECT i.*,
             m.variable_schema_json AS master_variable_schema_json,
             m.definition_json AS master_definition_json
      FROM nexus_org_form_templates i
      JOIN nexus_form_template_masters m ON m.id = i.master_id
      WHERE i.id = ? AND i.org_id = ?
    `
      )
      .get(req.params.id, orgId);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    const merged = mergeVariableValues(row.master_variable_schema_json, row.variable_values_json);
    const branding = mergeBranding(row.branding_json);
    res.json({
      variable_values: merged,
      variable_defaults: baselineVariableDefaults(row.master_variable_schema_json),
      branding,
      variable_groups: VARIABLE_GROUPS,
      definition_json: parseJson(row.master_definition_json, {}),
      instance: {
        id: row.id,
        label: row.label,
        metadata_json: row.metadata_json,
        branding_json: row.branding_json,
        variable_values_json: row.variable_values_json
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

ROUTER.post('/instances/:id/logo', requireAdminOrDelegate, logoUpload.single('file'), (req, res) => {
  try {
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return res.status(400).json({ error: 'No organisation.' });
    const row = db
      .prepare(`SELECT * FROM nexus_org_form_templates WHERE id = ? AND org_id = ?`)
      .get(req.params.id, orgId);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (!req.file?.buffer) return res.status(400).json({ error: 'No file.' });
    mkdirSync(join(uploadsRoot, 'form-templates', orgId), { recursive: true });
    const ext = req.file.mimetype.includes('png') ? 'png' : 'jpg';
    const rel = ['data', 'uploads', 'form-templates', orgId, `${req.params.id}.${ext}`].join('/');
    const abs = join(projectRoot, 'data', 'uploads', 'form-templates', orgId, `${req.params.id}.${ext}`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, req.file.buffer);
    const branding = { ...mergeBranding(row.branding_json), logo_relative_path: rel };
    db.prepare(`UPDATE nexus_org_form_templates SET branding_json = ?, updated_at = datetime('now') WHERE id = ?`).run(
      JSON.stringify(branding),
      req.params.id
    );
    res.json({ ok: true, logo_relative_path: branding.logo_relative_path });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default ROUTER;
