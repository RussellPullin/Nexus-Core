/**
 * Generate and list Service Agreement PDFs for a participant (org-scoped).
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db/index.js';
import { canAccessParticipant } from '../middleware/roles.js';
import { buildServiceAgreementSnapshot } from '../services/serviceAgreementSnapshot.service.js';
import { computeServiceAgreementGaps } from '../services/serviceAgreementGaps.service.js';
import { generateServiceAgreementPdfBuffer } from '../services/serviceAgreementPdf.service.js';
import { tryPushParticipantDocument } from '../services/orgOnedriveSync.service.js';
import {
  bridgeNexusServiceAgreementToFormInstance,
  createAuditEvent
} from '../services/onboarding.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const generatedRoot = process.env.DATA_DIR ? join(process.env.DATA_DIR, 'generated-forms') : join(projectRoot, 'data', 'generated-forms');

function userOrgId(userId) {
  const u = db.prepare(`SELECT org_id FROM users WHERE id = ?`).get(userId);
  return u?.org_id || null;
}

function assertParticipantOrg(participantId, orgId) {
  const p = db.prepare(`SELECT provider_org_id FROM participants WHERE id = ?`).get(participantId);
  if (!p) return { ok: false, error: 'Participant not found' };
  if (p.provider_org_id && orgId && p.provider_org_id !== orgId) {
    return { ok: false, error: 'Participant belongs to another organisation.' };
  }
  return { ok: true, participant: p };
}

const ROUTER = Router({ mergeParams: true });

ROUTER.post('/:participantId/service-agreements/preflight', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const userId = req.session.user.id;
    const { participantId } = req.params;
    if (!canAccessParticipant(userId, participantId)) return res.status(403).json({ error: 'Access denied' });

    const orgId = userOrgId(userId);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.' });

    const gate = assertParticipantOrg(participantId, orgId);
    if (!gate.ok) return res.status(404).json({ error: gate.error });

    const orgTemplateId = req.body?.org_template_id || req.body?.org_template_instance_id;
    if (!orgTemplateId) return res.status(400).json({ error: 'org_template_id is required.' });

    const orgTpl = db.prepare(`SELECT * FROM nexus_org_form_templates WHERE id = ? AND org_id = ?`).get(orgTemplateId, orgId);
    if (!orgTpl) return res.status(404).json({ error: 'Organisation template not found.' });

    const master = db.prepare(`SELECT * FROM nexus_form_template_masters WHERE id = ?`).get(orgTpl.master_id);
    if (!master) return res.status(500).json({ error: 'Master template missing.' });

    const instanceOverrides = req.body?.instance_overrides || {};
    const result = computeServiceAgreementGaps({
      participantId,
      orgId,
      masterRow: master,
      orgTemplateRow: orgTpl,
      instanceOverrides
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

ROUTER.post('/:participantId/service-agreements/generate', async (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const userId = req.session.user.id;
    const { participantId } = req.params;
    if (!canAccessParticipant(userId, participantId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const orgId = userOrgId(userId);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.' });

    const gate = assertParticipantOrg(participantId, orgId);
    if (!gate.ok) return res.status(404).json({ error: gate.error });

    const orgTemplateId = req.body?.org_template_id || req.body?.org_template_instance_id;
    if (!orgTemplateId) return res.status(400).json({ error: 'org_template_id is required.' });

    const orgTpl = db
      .prepare(`SELECT * FROM nexus_org_form_templates WHERE id = ? AND org_id = ?`)
      .get(orgTemplateId, orgId);
    if (!orgTpl) return res.status(404).json({ error: 'Organisation template not found.' });

    const master = db.prepare(`SELECT * FROM nexus_form_template_masters WHERE id = ?`).get(orgTpl.master_id);
    if (!master) return res.status(500).json({ error: 'Master template missing.' });

    const instanceOverrides = req.body?.instance_overrides || {};

    const gapResult = computeServiceAgreementGaps({
      participantId,
      orgId,
      masterRow: master,
      orgTemplateRow: orgTpl,
      instanceOverrides
    });
    if (!gapResult.can_generate) {
      return res.status(400).json({
        error: 'Complete required fields before generating this agreement.',
        gaps: gapResult.gaps,
        blocking_count: gapResult.blocking_count,
        warning_count: gapResult.warning_count
      });
    }

    const snapshot = buildServiceAgreementSnapshot({
      participantId,
      orgId,
      masterRow: master,
      orgTemplateRow: orgTpl,
      instanceOverrides
    });

    const pdfBuf = await generateServiceAgreementPdfBuffer(snapshot);

    mkdirSync(join(generatedRoot, orgId), { recursive: true });
    const docId = uuidv4();
    const safeName = `Service-Agreement-${docId.slice(0, 8)}.pdf`;
    const relPath = join('data', 'generated-forms', orgId, `${docId}.pdf`).split(/[/\\]/).join('/');
    const absPath = join(projectRoot, 'data', 'generated-forms', orgId, `${docId}.pdf`);
    mkdirSync(dirname(absPath), { recursive: true });
    await writeFile(absPath, pdfBuf);

    db.prepare(
      `INSERT INTO nexus_generated_form_documents (
        id, org_id, participant_id, org_template_id, status, snapshot_json, pdf_relative_path, generated_by_user_id
      ) VALUES (?, ?, ?, ?, 'generated', ?, ?, ?)`
    ).run(docId, orgId, participantId, orgTemplateId, JSON.stringify(snapshot), relPath, userId);

    let onedrive_web_url = null;
    try {
      const pushed = await tryPushParticipantDocument({
        participantId,
        category: 'Service agreements',
        buffer: pdfBuf,
        originalFilename: safeName,
        mimeType: 'application/pdf',
        notes: `nexus_generated_form:${docId}`
      });
      onedrive_web_url = pushed?.webUrl || null;
      const itemId = pushed?.itemId || null;
      if (itemId || onedrive_web_url) {
        db.prepare(
          `UPDATE nexus_generated_form_documents SET onedrive_item_id = COALESCE(?, onedrive_item_id), onedrive_web_url = COALESCE(?, onedrive_web_url) WHERE id = ?`
        ).run(itemId, onedrive_web_url, docId);
      }
    } catch (e) {
      console.warn('[service-agreements] OneDrive upload skipped:', e.message);
    }

    try {
      const pdId = uuidv4();
      db.prepare(
        `INSERT INTO participant_documents (id, participant_id, filename, category, file_path, metadata_json)
         VALUES (?, ?, ?, 'Service Agreement', ?, ?)`
      ).run(pdId, participantId, safeName, absPath, JSON.stringify({ nexus_generated_form_id: docId }));
    } catch (e) {
      try {
        const pdId = uuidv4();
        db.prepare(
          `INSERT INTO participant_documents (id, participant_id, filename, category, file_path)
           VALUES (?, ?, ?, 'Service Agreement', ?)`
        ).run(pdId, participantId, safeName, absPath);
      } catch {
        /* ignore */
      }
    }

    // Bridge into the legacy participant_form_instances lifecycle so Dropbox Sign +
    // onboarding completion treat the Nexus SA uniformly with privacy_consent / support_plan.
    let bridgedFormInstanceId = null;
    let bridgedOnboardingId = null;
    try {
      const bridged = bridgeNexusServiceAgreementToFormInstance({
        participantId,
        organisationId: orgId,
        pdfAbsolutePath: absPath,
        snapshot,
        nexusGeneratedDocumentId: docId
      });
      bridgedFormInstanceId = bridged?.form_instance_id || null;
      bridgedOnboardingId = bridged?.participant_onboarding_id || null;
    } catch (e) {
      console.warn('[service-agreements] bridge to participant_form_instances skipped:', e?.message);
    }

    try {
      createAuditEvent({
        participantId,
        participantOnboardingId: bridgedOnboardingId,
        actorType: 'user',
        actorId: userId,
        eventType: 'nexus_service_agreement_generated',
        entityType: 'nexus_generated_form',
        entityId: docId,
        newValue: {
          org_template_id: orgTemplateId,
          form_instance_id: bridgedFormInstanceId,
          onedrive_web_url
        },
        sourceIp: req.headers['x-forwarded-for'] || req.ip || null,
        userAgent: req.headers['user-agent'] || null
      });
    } catch (e) {
      console.warn('[service-agreements] audit event failed:', e?.message);
    }

    res.status(201).json({
      id: docId,
      participant_id: participantId,
      download_url: `/api/generated-forms/${docId}/pdf`,
      onedrive_web_url,
      form_instance_id: bridgedFormInstanceId
    });
  } catch (err) {
    console.error('[service-agreements/generate]', err);
    res.status(500).json({ error: err.message });
  }
});

ROUTER.get('/:participantId/service-agreements', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const userId = req.session.user.id;
    const { participantId } = req.params;
    if (!canAccessParticipant(userId, participantId)) return res.status(403).json({ error: 'Access denied' });
    const orgId = userOrgId(userId);
    if (!orgId) return res.json({ items: [] });
    const gate = assertParticipantOrg(participantId, orgId);
    if (!gate.ok) return res.status(404).json({ error: gate.error });

    const rows = db
      .prepare(
        `
      SELECT g.*, t.label AS template_label
      FROM nexus_generated_form_documents g
      LEFT JOIN nexus_org_form_templates t ON t.id = g.org_template_id
      WHERE g.participant_id = ? AND g.org_id = ?
      ORDER BY datetime(g.generated_at) DESC
    `
      )
      .all(participantId, orgId);
    res.json({ items: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default ROUTER;
