/**
 * System form template masters + org-specific clones (Service Agreement and future types).
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import { writeFileSync, mkdirSync, existsSync, createReadStream } from 'fs';
import { join, resolve, dirname } from 'path';
import { EDITABLE_SECTIONS } from '../data/serviceAgreementSpring2V3/fieldCatalog.js';
import { fileURLToPath } from 'url';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { canAccessParticipant, requireAdmin, requireAdminOrDelegate } from '../middleware/roles.js';
import {
  mergeVariableValues,
  mergeBranding,
  parseJson,
  baselineVariableDefaults,
  enrichVariablesFromOrgProfile
} from '../services/nexusFormTemplateRuntime.service.js';
import { renderBrandedForm } from '../services/brandedFormPdf.service.js';
import { assessOrgSampleReadiness } from '../services/formSample.service.js';
import { VARIABLE_GROUPS } from '../data/serviceAgreementSpring2V3/variableSchema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const uploadsRoot = process.env.DATA_DIR ? join(process.env.DATA_DIR, 'uploads') : join(projectRoot, 'data', 'uploads');
const generatedRoot = process.env.DATA_DIR
  ? join(process.env.DATA_DIR, 'generated-forms')
  : join(projectRoot, 'data', 'generated-forms');

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

function jsonResponse(res, data, extra = {}) {
  return res.json({ success: true, data, ...extra });
}

function parseJsonValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function descriptionForMaster(row) {
  const definition = parseJsonValue(row.definition_json, {});
  return definition?.meta?.description || row.title || '';
}

function previewUrlForMaster(row) {
  return `/api/form-templates/masters/${encodeURIComponent(row.id)}/preview`;
}

function normalizeSectionForCompare(section) {
  return JSON.stringify({
    id: section?.id || '',
    title: String(section?.title || '').trim(),
    body_html: String(section?.body_html || '').trim(),
    locked: Boolean(section?.locked)
  });
}

function validateUnlockedSectionEdits(masterSectionsJson, nextSections) {
  if (nextSections == null) return;
  if (!Array.isArray(nextSections)) throw new Error('sections must be an array.');
  const masterSections = parseJsonValue(masterSectionsJson, []);
  const nextById = new Map(nextSections.map((section) => [section.id, section]));
  for (const masterSection of masterSections) {
    if (!masterSection?.locked) continue;
    const incoming = nextById.get(masterSection.id);
    if (!incoming) continue;
    if (normalizeSectionForCompare(incoming) !== normalizeSectionForCompare(masterSection)) {
      throw new Error(`Locked section "${masterSection.title || masterSection.id}" cannot be changed.`);
    }
  }
}

function rowToMasterCard(row, orgId = null) {
  return {
    id: row.id,
    template_key: row.template_key,
    template_type: row.template_type,
    category: row.category || row.template_type || 'custom',
    name: row.title,
    title: row.title,
    version_label: row.version_label,
    description: descriptionForMaster(row),
    preview_url: previewUrlForMaster(row),
    already_added: Boolean(row.clone_id),
    org_template_id: row.clone_id || null,
    org_id: orgId
  };
}

function fullOrgTemplate(row) {
  const masterSections = parseJsonValue(row.master_sections_json, []);
  const orgSections = parseJsonValue(row.sections_json, null);
  return {
    id: row.id,
    org_id: row.org_id,
    master_id: row.master_id,
    label: row.label,
    category: row.category || row.master_category || row.template_type || 'custom',
    template_key: row.template_key,
    template_type: row.template_type,
    name: row.label || row.master_title,
    master_title: row.master_title,
    description: descriptionForMaster({
      ...row,
      title: row.master_title,
      definition_json: row.master_definition_json
    }),
    branding: mergeBranding(row.branding_json),
    branding_slots: parseJsonValue(row.branding_slots_json, parseJsonValue(row.master_branding_slots_json, [])),
    variable_values: parseJsonValue(row.variable_values_json, {}),
    variable_slots: parseJsonValue(row.variable_slots_json, parseJsonValue(row.master_variable_slots_json, [])),
    sections: Array.isArray(orgSections) ? orgSections : masterSections,
    master_sections: masterSections,
    page_layout: parseJsonValue(row.page_layout_json, parseJsonValue(row.master_page_layout_json, {})),
    metadata: parseJsonValue(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function selectOrgTemplate(id, orgId) {
  return db
    .prepare(
      `SELECT i.*,
              m.template_key,
              m.template_type,
              m.title AS master_title,
              m.version_label,
              m.definition_json AS master_definition_json,
              m.variable_schema_json AS master_variable_schema_json,
              m.branding_slots_json AS master_branding_slots_json,
              m.variable_slots_json AS master_variable_slots_json,
              m.sections_json AS master_sections_json,
              m.page_layout_json AS master_page_layout_json,
              m.category AS master_category
       FROM nexus_org_form_templates i
       JOIN nexus_form_template_masters m ON m.id = i.master_id
       WHERE i.id = ? AND i.org_id = ?`
    )
    .get(id, orgId);
}

const ROUTER = Router();

ROUTER.use(requireAuth);

ROUTER.get('/masters', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const orgId = orgIdForUser(req.session.user.id);
    const rows = db
      .prepare(
        `SELECT m.*, c.id AS clone_id
         FROM nexus_form_template_masters m
         LEFT JOIN nexus_org_form_templates c ON c.master_id = m.id AND c.org_id = ?
         ORDER BY category, template_type`
      )
      .all(orgId);
    const masters = rows.map((row) => rowToMasterCard(row, orgId));
    res.json({ success: true, data: masters, masters });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

ROUTER.get('/masters/:id', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const row = db.prepare(`SELECT * FROM nexus_form_template_masters WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Template master not found' });
    res.json({
      success: true,
      data: {
        master: row,
        variable_groups: VARIABLE_GROUPS,
        merged_defaults: mergeVariableValues(row.variable_schema_json, '{}'),
        branding_slots: parseJson(row.branding_slots_json, []),
        variable_slots: parseJson(row.variable_slots_json, []),
        sections: parseJson(row.sections_json, []),
        page_layout: parseJson(row.page_layout_json, {})
      },
      master: row,
      variable_groups: VARIABLE_GROUPS,
      merged_defaults: mergeVariableValues(row.variable_schema_json, '{}'),
      branding_slots: parseJson(row.branding_slots_json, []),
      variable_slots: parseJson(row.variable_slots_json, []),
      sections: parseJson(row.sections_json, []),
      page_layout: parseJson(row.page_layout_json, {})
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

ROUTER.post('/masters/:id/clone', requireAdmin, (req, res) => {
  try {
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.' });
    const master = db.prepare('SELECT * FROM nexus_form_template_masters WHERE id = ?').get(req.params.id);
    if (!master) return res.status(404).json({ error: 'Master template not found.' });

    const existing = db
      .prepare('SELECT id FROM nexus_org_form_templates WHERE org_id = ? AND master_id = ?')
      .get(orgId, master.id);
    if (existing?.id) {
      return jsonResponse(res, { id: existing.id, org_template_id: existing.id, already_added: true });
    }

    const id = uuidv4();
    db.prepare(
      `INSERT INTO nexus_org_form_templates (
         id, org_id, master_id, label, variable_values_json, branding_json,
         branding_slots_json, variable_slots_json, sections_json, page_layout_json, category, metadata_json
       )
       VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, '{}')`
    ).run(
      id,
      orgId,
      master.id,
      master.title || 'Untitled template',
      JSON.stringify(mergeBranding(null)),
      master.branding_slots_json || null,
      master.variable_slots_json || null,
      master.sections_json || null,
      master.page_layout_json || null,
      master.category || master.template_type || 'custom'
    );
    return jsonResponse(res, { id, org_template_id: id, already_added: false });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

ROUTER.get('/masters/:id/preview', async (req, res) => {
  try {
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.' });
    const clone = db
      .prepare('SELECT id FROM nexus_org_form_templates WHERE master_id = ? AND org_id = ?')
      .get(req.params.id, orgId);
    if (!clone?.id) return res.status(400).json({ error: 'Add this master to your forms before previewing it.' });
    const pdfBuf = await renderBrandedForm(clone.id, null, db);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="template-preview.pdf"');
    return res.send(pdfBuf);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

ROUTER.get('/org', (req, res) => {
  try {
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return jsonResponse(res, []);
    const rows = db
      .prepare(
        `SELECT i.*, m.template_key, m.template_type, m.title AS master_title, m.version_label,
                m.definition_json AS master_definition_json,
                m.category AS master_category
         FROM nexus_org_form_templates i
         JOIN nexus_form_template_masters m ON m.id = i.master_id
         WHERE i.org_id = ?
         ORDER BY datetime(i.updated_at) DESC`
      )
      .all(orgId);
    return jsonResponse(res, rows.map((row) => ({
      id: row.id,
      master_id: row.master_id,
      name: row.label || row.master_title,
      label: row.label,
      category: row.category || row.master_category || row.template_type || 'custom',
      template_type: row.template_type,
      template_key: row.template_key,
      description: descriptionForMaster({ ...row, title: row.master_title, definition_json: row.master_definition_json }),
      updated_at: row.updated_at,
      preview_url: `/api/form-templates/org/${encodeURIComponent(row.id)}/preview`
    })));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

ROUTER.get('/org/:id', (req, res) => {
  try {
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.' });
    const row = selectOrgTemplate(req.params.id, orgId);
    if (!row) return res.status(404).json({ error: 'Template not found.' });
    return jsonResponse(res, fullOrgTemplate(row));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

ROUTER.put('/org/:id', requireAdmin, (req, res) => {
  try {
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.' });
    const row = selectOrgTemplate(req.params.id, orgId);
    if (!row) return res.status(404).json({ error: 'Template not found.' });

    const body = req.body || {};
    validateUnlockedSectionEdits(row.master_sections_json, body.sections);

    const branding = body.branding != null ? JSON.stringify({ ...mergeBranding(row.branding_json), ...body.branding }) : null;
    const variableValues = body.variable_values != null ? JSON.stringify(body.variable_values || {}) : null;
    const brandingSlots = body.branding_slots != null ? JSON.stringify(body.branding_slots || []) : null;
    const variableSlots = body.variable_slots != null ? JSON.stringify(body.variable_slots || []) : null;
    const sections = body.sections != null ? JSON.stringify(body.sections || []) : null;
    const pageLayout = body.page_layout != null ? JSON.stringify(body.page_layout || {}) : null;
    const label = body.label != null ? String(body.label || '').trim() : null;

    const updates = [];
    const params = [];
    if (label != null) {
      updates.push('label = ?');
      params.push(label || row.label);
    }
    if (branding != null) {
      updates.push('branding_json = ?');
      params.push(branding);
    }
    if (variableValues != null) {
      updates.push('variable_values_json = ?');
      params.push(variableValues);
    }
    if (brandingSlots != null) {
      updates.push('branding_slots_json = ?');
      params.push(brandingSlots);
    }
    if (variableSlots != null) {
      updates.push('variable_slots_json = ?');
      params.push(variableSlots);
    }
    if (sections != null) {
      updates.push('sections_json = ?');
      params.push(sections);
    }
    if (pageLayout != null) {
      updates.push('page_layout_json = ?');
      params.push(pageLayout);
    }
    if (!updates.length) return jsonResponse(res, fullOrgTemplate(row));
    updates.push("updated_at = datetime('now')");
    params.push(row.id);
    db.prepare(`UPDATE nexus_org_form_templates SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updated = selectOrgTemplate(req.params.id, orgId);
    return jsonResponse(res, fullOrgTemplate(updated));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

ROUTER.get('/org/:id/preview', async (req, res) => {
  try {
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.' });
    const row = db.prepare('SELECT id FROM nexus_org_form_templates WHERE id = ? AND org_id = ?').get(req.params.id, orgId);
    if (!row) return res.status(404).json({ error: 'Template not found.' });
    const pdfBuf = await renderBrandedForm(req.params.id, null, db);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="template-preview.pdf"');
    return res.send(pdfBuf);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

ROUTER.post('/org/:id/generate', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const orgId = orgIdForUser(userId);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.' });
    const participantId = req.body?.participant_id;
    if (!participantId) return res.status(400).json({ error: 'participant_id is required.' });
    if (!canAccessParticipant(userId, participantId)) return res.status(403).json({ error: 'Access denied' });

    const row = selectOrgTemplate(req.params.id, orgId);
    if (!row) return res.status(404).json({ error: 'Template not found.' });
    const participant = db.prepare('SELECT provider_org_id FROM participants WHERE id = ?').get(participantId);
    if (participant?.provider_org_id && participant.provider_org_id !== orgId) {
      return res.status(403).json({ error: 'Participant belongs to another organisation.' });
    }

    const pdfBuf = await renderBrandedForm(req.params.id, participantId, db);
    const docId = uuidv4();
    mkdirSync(join(generatedRoot, orgId), { recursive: true });
    const relPath = join('data', 'generated-forms', orgId, `${docId}.pdf`).split(/[/\\]/).join('/');
    const absPath = join(projectRoot, 'data', 'generated-forms', orgId, `${docId}.pdf`);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, pdfBuf);

    const snapshot = {
      org_template_id: row.id,
      master_id: row.master_id,
      participant_id: participantId,
      category: row.category || row.master_category || row.template_type || 'custom',
      generated_at_iso: new Date().toISOString()
    };
    db.prepare(
      `INSERT INTO nexus_generated_form_documents (
         id, org_id, participant_id, org_template_id, status, snapshot_json, pdf_relative_path, generated_by_user_id
       ) VALUES (?, ?, ?, ?, 'generated', ?, ?, ?)`
    ).run(docId, orgId, participantId, row.id, JSON.stringify(snapshot), relPath, userId);

    return jsonResponse(res, {
      id: docId,
      doc_id: docId,
      download_url: `/api/form-templates/org/${encodeURIComponent(row.id)}/download/${encodeURIComponent(docId)}`
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

ROUTER.get('/org/:id/download/:docId', (req, res) => {
  try {
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.' });
    const docRow = db
      .prepare(
        `SELECT g.*, t.id AS template_id, t.label
         FROM nexus_generated_form_documents g
         JOIN nexus_org_form_templates t ON t.id = g.org_template_id
         WHERE g.id = ? AND g.org_template_id = ? AND g.org_id = ?`
      )
      .get(req.params.docId, req.params.id, orgId);
    if (!docRow) return res.status(404).json({ error: 'Document not found.' });
    if (!canAccessParticipant(req.session.user.id, docRow.participant_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const rel = docRow.pdf_relative_path;
    if (!rel) return res.status(404).json({ error: 'PDF not stored.' });
    const abs = join(projectRoot, rel.split(/[/\\]/).join('/'));
    if (!existsSync(abs)) return res.status(404).json({ error: 'File missing on server.' });
    const safeName = String(docRow.label || 'form').replace(/[^a-zA-Z0-9._-]/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName || 'form'}-${docRow.id.slice(0, 8)}.pdf"`);
    return createReadStream(abs).pipe(res);
  } catch (e) {
    return res.status(500).json({ error: e.message });
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
      `INSERT INTO nexus_org_form_templates (
         id, org_id, master_id, label, variable_values_json, branding_json,
         branding_slots_json, variable_slots_json, sections_json, page_layout_json, category, metadata_json
       )
       VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, '{}')`
    ).run(
      id,
      orgId,
      masterId,
      label,
      JSON.stringify(mergeBranding(null)),
      master.branding_slots_json || null,
      master.variable_slots_json || null,
      master.sections_json || null,
      master.page_layout_json || null,
      master.category || master.template_type || 'custom'
    );
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

    const { label, variable_values, branding, branding_slots, variable_slots, sections, page_layout, category, metadata } = req.body || {};
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
    if (branding_slots != null) {
      updates.push('branding_slots_json = ?');
      params.push(JSON.stringify(branding_slots));
    }
    if (variable_slots != null) {
      updates.push('variable_slots_json = ?');
      params.push(JSON.stringify(variable_slots));
    }
    if (sections != null) {
      updates.push('sections_json = ?');
      params.push(JSON.stringify(sections));
    }
    if (page_layout != null) {
      updates.push('page_layout_json = ?');
      params.push(JSON.stringify(page_layout));
    }
    if (category != null) {
      updates.push('category = ?');
      params.push(String(category).trim() || 'custom');
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
             m.definition_json AS master_definition_json,
             m.branding_slots_json AS master_branding_slots_json,
             m.variable_slots_json AS master_variable_slots_json,
             m.sections_json AS master_sections_json,
             m.page_layout_json AS master_page_layout_json,
             m.category AS master_category
      FROM nexus_org_form_templates i
      JOIN nexus_form_template_masters m ON m.id = i.master_id
      WHERE i.id = ? AND i.org_id = ?
    `
      )
      .get(req.params.id, orgId);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    let merged = mergeVariableValues(row.master_variable_schema_json, row.variable_values_json);
    const org = db.prepare('SELECT * FROM organisations WHERE id = ?').get(orgId);
    const biz = db.prepare('SELECT * FROM business_settings WHERE org_id = ?').get(orgId);
    const adminUser = db
      .prepare(`SELECT name FROM users WHERE org_id = ? AND role = 'admin' ORDER BY created_at ASC LIMIT 1`)
      .get(orgId);
    merged = enrichVariablesFromOrgProfile(merged, org, biz, adminUser?.name || '');
    const branding = mergeBranding(row.branding_json);
    const definition = parseJson(row.master_definition_json, {});
    res.json({
      variable_values: merged,
      variable_defaults: baselineVariableDefaults(row.master_variable_schema_json),
      branding,
      variable_groups: VARIABLE_GROUPS,
      definition_json: definition,
      editable_sections: definition.editableSections || EDITABLE_SECTIONS,
      branding_slots: parseJson(row.branding_slots_json, parseJson(row.master_branding_slots_json, [])),
      variable_slots: parseJson(row.variable_slots_json, parseJson(row.master_variable_slots_json, [])),
      sections: parseJson(row.sections_json, parseJson(row.master_sections_json, [])),
      page_layout: parseJson(row.page_layout_json, parseJson(row.master_page_layout_json, {})),
      category: row.category || row.master_category || 'custom',
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

ROUTER.get('/instances/:id/preview.pdf', requireAdminOrDelegate, async (req, res) => {
  try {
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return res.status(400).json({ error: 'No organisation.' });
    const row = db
      .prepare(
        `
      SELECT i.*, m.template_type, m.title AS master_title,
             m.definition_json AS master_definition_json, m.variable_schema_json AS master_variable_schema_json,
             m.template_key, m.branding_slots_json AS master_branding_slots_json,
             m.variable_slots_json AS master_variable_slots_json,
             m.sections_json AS master_sections_json,
             m.page_layout_json AS master_page_layout_json,
             m.category AS master_category
      FROM nexus_org_form_templates i
      JOIN nexus_form_template_masters m ON m.id = i.master_id
      WHERE i.id = ? AND i.org_id = ?
    `
      )
      .get(req.params.id, orgId);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    const readiness = assessOrgSampleReadiness(orgId);
    if (!readiness.sample_ready) {
      return res.status(400).json({ error: 'Add your organisation name before downloading a sample.' });
    }
    const pdfBuf = await renderBrandedForm(row.id, null, db);
    res.setHeader('Content-Type', 'application/pdf');
    const safeName = String(row.label || row.master_title || 'form-sample').replace(/[^a-zA-Z0-9._-]/g, '-');
    res.setHeader('Content-Disposition', `inline; filename="${safeName || 'form-sample'}.pdf"`);
    res.send(pdfBuf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

ROUTER.get('/instances/:id/logo', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const orgId = orgIdForUser(req.session.user.id);
    if (!orgId) return res.status(404).end();
    const row = db
      .prepare(`SELECT branding_json FROM nexus_org_form_templates WHERE id = ? AND org_id = ?`)
      .get(req.params.id, orgId);
    if (!row) return res.status(404).end();
    const branding = mergeBranding(row.branding_json);
    const rel = branding.logo_relative_path;
    if (!rel) return res.status(404).end();
    const abs = join(projectRoot, rel);
    if (!existsSync(abs)) return res.status(404).end();
    const ext = abs.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    res.setHeader('Content-Type', ext);
    createReadStream(abs).pipe(res);
  } catch {
    res.status(500).end();
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
