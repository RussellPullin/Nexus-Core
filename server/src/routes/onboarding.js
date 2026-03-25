import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { db } from '../db/index.js';
import { canAccessParticipant } from '../middleware/roles.js';
import {
  initializeParticipantOnboarding,
  upsertIntakeFields,
  saveIntakeAndSyncParticipant,
  generateFormPack,
  getOnboardingByParticipant,
  getLatestGeneratedForms,
  computeHybridPackets,
  createEnvelopeRecords,
  markEnvelopeCompleted,
  getParticipantEvidenceBundle,
  getProviderComplianceDashboard,
  upsertRenewalTasksForParticipant,
  ensureProviderProfile,
  seedCoreTemplates,
  getTemplateCoverage,
  createAuditEvent
} from '../services/onboarding.service.js';
import { createAgreementPacket, createAgreementWithDocument, uploadTransientDocument, verifyWebhookPayload } from '../services/adobeSign.service.js';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fillConsentForm, getConsentFormPath, convertDocxToPdf } from '../services/consentForm.service.js';
import { tryPushParticipantDocument } from '../services/orgOnedriveSync.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const onboardingDir = join(projectRoot, 'data', 'onboarding');

const router = Router();
const memoryUpload = multer({ storage: multer.memoryStorage() });

function actorContext(req) {
  return {
    actorType: req.headers['x-actor-type'] || 'user',
    actorId: req.headers['x-actor-id'] || null,
    sourceIp: req.headers['x-forwarded-for'] || req.ip || null,
    userAgent: req.headers['user-agent'] || null
  };
}

router.param('id', (req, res, next, id) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!canAccessParticipant(req.session.user.id, id)) return res.status(403).json({ error: 'Access denied' });
  next();
});

function parseSnapshot(form) {
  if (!form?.source_snapshot_json) return {};
  try {
    return JSON.parse(form.source_snapshot_json);
  } catch {
    return {};
  }
}

router.post('/participants/:id/initialize', (req, res) => {
  try {
    const payload = initializeParticipantOnboarding({
      participantId: req.params.id,
      providerOrganisationId: req.body?.provider_organisation_id || null,
      ...actorContext(req)
    });
    res.status(201).json(payload);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/participants/:id', (req, res) => {
  try {
    const onboarding = getOnboardingByParticipant(req.params.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });
    res.json(onboarding);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/participants/:id/intake-fields', (req, res) => {
  try {
    const updated = upsertIntakeFields({
      participantId: req.params.id,
      fields: req.body?.fields || {},
      ...actorContext(req)
    });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/participants/:id/intake-save', (req, res) => {
  try {
    const { participant: participantData, intake: intakeData, contacts: contactsData } = req.body || {};
    const updated = saveIntakeAndSyncParticipant({
      participantId: req.params.id,
      participantData: participantData || {},
      intakeData: intakeData || {},
      contactsData: contactsData || [],
      ...actorContext(req)
    });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/participants/:id/generate-form-pack', async (req, res) => {
  try {
    const generated = await generateFormPack({
      participantId: req.params.id,
      ...actorContext(req)
    });
    res.status(201).json(generated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/participants/:id/send-form/:formInstanceId', async (req, res) => {
  try {
    const onboarding = getOnboardingByParticipant(req.params.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });

    const participant = db.prepare('SELECT id, name, email, phone, address, date_of_birth, ndis_number, parent_guardian_phone, parent_guardian_email FROM participants WHERE id = ?').get(req.params.id);
    if (!participant) return res.status(404).json({ error: 'Participant not found' });

    const form = db.prepare(`
      SELECT pfi.*, ft.form_type, ft.display_name
      FROM participant_form_instances pfi
      JOIN form_templates ft ON ft.id = pfi.form_template_id
      WHERE pfi.id = ? AND pfi.participant_onboarding_id = ?
    `).get(req.params.formInstanceId, onboarding.id);
    if (!form) return res.status(404).json({ error: 'Form not found' });
    if (!['generated', 'draft'].includes(form.status)) {
      return res.status(400).json({ error: `Form already ${form.status}. Cannot send again.` });
    }

    const packets = [[form]];
    const envelopeRecords = createEnvelopeRecords({
      participantId: participant.id,
      participantOnboardingId: onboarding.id,
      packets,
      packetMode: 'separate',
      ...actorContext(req)
    });

    const envelope = envelopeRecords[0];
    let agreement;
    /** @type {{ buffer: Buffer, originalFilename: string, mimeType: string, category: string } | null} */
    let oneDriveCopy = null;

    if (form.form_type === 'privacy_consent' && getConsentFormPath()) {
      const intakeRows = db.prepare(`
        SELECT field_key, field_value FROM participant_intake_fields
        WHERE participant_onboarding_id = ?
      `).all(onboarding.id);
      const intake = Object.fromEntries(intakeRows.map((r) => [r.field_key, r.field_value]));
      const coordinatorSignatureDataUrl = req.session?.user?.id
        ? (db.prepare('SELECT signature_data FROM users WHERE id = ?').get(req.session.user.id)?.signature_data || null)
        : null;
      const docBuffer = fillConsentForm(participant, intake, coordinatorSignatureDataUrl ? { coordinatorSignatureDataUrl } : {});
      const pdfBuffer = convertDocxToPdf(docBuffer);
      const consentFilename = pdfBuffer ? 'FM-Consent-NDIS-information.pdf' : 'FM-Consent-NDIS-information.docx';
      const uploadBuf = pdfBuffer || docBuffer;
      oneDriveCopy = {
        buffer: uploadBuf,
        originalFilename: consentFilename,
        mimeType: pdfBuffer
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        category: 'Consent and service agreement'
      };
      const transientId = await uploadTransientDocument(uploadBuf, consentFilename);
      agreement = await createAgreementWithDocument({
        participantName: participant.name,
        participantEmail: participant.email,
        envelopeId: envelope.envelope_id,
        transientDocumentId: transientId,
        documentName: 'Privacy Consent (NDIS)'
      });
    } else if (form.draft_document_path && existsSync(form.draft_document_path)) {
      const ext = form.draft_document_path.toLowerCase().endsWith('.docx') ? 'docx' : 'pdf';
      const docBuffer = readFileSync(form.draft_document_path);
      const filename = `${form.display_name || form.form_type}-${participant.name || 'Participant'}.${ext}`.replace(/[^a-zA-Z0-9._-]/g, '_');
      oneDriveCopy = {
        buffer: docBuffer,
        originalFilename: filename,
        mimeType:
          ext === 'docx'
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/pdf',
        category: form.display_name || form.form_type || 'Service agreement'
      };
      const transientId = await uploadTransientDocument(docBuffer, filename);
      agreement = await createAgreementWithDocument({
        participantName: participant.name,
        participantEmail: participant.email,
        envelopeId: envelope.envelope_id,
        transientDocumentId: transientId,
        documentName: form.display_name || form.form_type
      });
    } else {
      agreement = await createAgreementPacket({
        participantName: participant.name,
        participantEmail: participant.email,
        envelopeId: envelope.envelope_id,
        forms: [form]
      });
    }

    db.prepare(`
      UPDATE signature_envelopes
      SET external_envelope_id = ?, provider_name = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(agreement.external_envelope_id, agreement.provider || 'adobe_sign', agreement.status || 'sent', envelope.envelope_id);

    if (oneDriveCopy) {
      try {
        void tryPushParticipantDocument({
          participantId: participant.id,
          category: oneDriveCopy.category,
          buffer: oneDriveCopy.buffer,
          originalFilename: oneDriveCopy.originalFilename,
          mimeType: oneDriveCopy.mimeType,
          notes: `Sent for signature: ${form.display_name || form.form_type}`
        });
      } catch (pushErr) {
        console.warn('[onboarding] OneDrive copy after send-form:', pushErr?.message);
      }
    }

    res.status(201).json({ envelope_id: envelope.envelope_id, form_type: form.form_type, display_name: form.display_name, ...agreement });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/participants/:id/send-signatures', async (req, res) => {
  try {
    const onboarding = getOnboardingByParticipant(req.params.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });

    const participant = db.prepare('SELECT id, name, email FROM participants WHERE id = ?').get(req.params.id);
    if (!participant) return res.status(404).json({ error: 'Participant not found' });

    const forms = getLatestGeneratedForms(onboarding.id);
    if (!forms.length) return res.status(400).json({ error: 'No generated forms to send. Generate form pack first.' });

    const packets = computeHybridPackets(forms);
    const envelopeRecords = createEnvelopeRecords({
      participantId: participant.id,
      participantOnboardingId: onboarding.id,
      packets,
      packetMode: onboarding.signature_mode || 'hybrid',
      ...actorContext(req)
    });

    const envelopeResponses = [];
    for (let i = 0; i < envelopeRecords.length; i += 1) {
      const envelope = envelopeRecords[i];
      const packetForms = forms.filter((f) => envelope.form_instance_ids.includes(f.id));
      const agreement = await createAgreementPacket({
        participantName: participant.name,
        participantEmail: participant.email,
        envelopeId: envelope.envelope_id,
        forms: packetForms
      });
      db.prepare(`
        UPDATE signature_envelopes
        SET external_envelope_id = ?, provider_name = ?, status = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(agreement.external_envelope_id, agreement.provider || 'adobe_sign', agreement.status || 'sent', envelope.envelope_id);
      envelopeResponses.push({ ...envelope, ...agreement });
    }

    res.status(201).json({ envelopes: envelopeResponses, count: envelopeResponses.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/webhooks/adobe-sign', (req, res) => {
  try {
    const verification = verifyWebhookPayload(req.body, req.headers);
    if (!verification.valid) {
      return res.status(401).json({ error: `Invalid webhook signature: ${verification.reason}` });
    }

    const externalEnvelopeId = req.body?.agreement?.id || req.body?.agreementId || req.body?.externalId || null;
    const eventType = req.body?.event || req.body?.eventType || 'agreement_signed';
    if (!externalEnvelopeId) return res.status(400).json({ error: 'Missing external envelope id' });

    const envelope = db.prepare('SELECT * FROM signature_envelopes WHERE external_envelope_id = ?').get(externalEnvelopeId);
    if (!envelope) return res.status(404).json({ error: 'Envelope not found for webhook' });

    if (eventType.toLowerCase().includes('signed') || eventType === 'agreement_signed') {
      markEnvelopeCompleted({
        envelopeId: envelope.id,
        externalEventId: req.body?.eventId || null,
        eventType: 'agreement_signed',
        payload: req.body,
        sourceIp: req.headers['x-forwarded-for'] || req.ip || null,
        userAgent: req.headers['user-agent'] || null
      });
    } else {
      db.prepare(`
        INSERT INTO signature_events (
          id, envelope_id, provider_name, external_event_id, event_type, event_timestamp, payload_json
        ) VALUES (?, ?, 'adobe_sign', ?, ?, datetime('now'), ?)
      `).run(
        randomUUID(),
        envelope.id,
        req.body?.eventId || null,
        eventType,
        JSON.stringify(req.body)
      );
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/participants/:id/status', (req, res) => {
  try {
    const onboarding = getOnboardingByParticipant(req.params.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });
    res.json(onboarding);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/participants/:id/regenerate', async (req, res) => {
  try {
    const onboarding = getOnboardingByParticipant(req.params.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });

    db.prepare(`
      UPDATE participant_form_instances
      SET status = 'superseded', superseded_at = ?, updated_at = datetime('now')
      WHERE participant_onboarding_id = ? AND status IN ('draft', 'generated', 'sent', 'viewed')
    `).run(new Date().toISOString(), onboarding.id);

    const generated = await generateFormPack({
      participantId: req.params.id,
      userId: req.session?.user?.id,
      ...actorContext(req)
    });
    res.status(201).json(generated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/participants/:id/signed-artifacts', (req, res) => {
  try {
    const onboarding = getOnboardingByParticipant(req.params.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });
    const signedForms = onboarding.forms.filter((f) => f.status === 'signed').map((f) => ({
      id: f.id,
      form_type: f.form_type,
      display_name: f.display_name,
      signed_at: f.signed_at,
      signed_document_path: f.signed_document_path,
      certificate_document_path: f.certificate_document_path
    }));
    res.json({ signed_forms: signedForms, count: signedForms.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/participants/:id/evidence-bundle', (req, res) => {
  try {
    const bundle = getParticipantEvidenceBundle(req.params.id);
    if (!bundle) return res.status(404).json({ error: 'Evidence bundle not found' });
    res.json(bundle);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/participants/:id/renewals/run', (req, res) => {
  try {
    const onboarding = getOnboardingByParticipant(req.params.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });
    const created = upsertRenewalTasksForParticipant(onboarding.id);
    createAuditEvent({
      participantId: req.params.id,
      participantOnboardingId: onboarding.id,
      actorType: actorContext(req).actorType,
      actorId: actorContext(req).actorId,
      eventType: 'renewal_scan_run',
      entityType: 'onboarding',
      entityId: onboarding.id,
      newValue: { tasks_created: created },
      sourceIp: actorContext(req).sourceIp,
      userAgent: actorContext(req).userAgent
    });
    res.json({ tasks_created: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/providers/:organisationId/compliance', (req, res) => {
  try {
    const dashboard = getProviderComplianceDashboard(req.params.organisationId);
    res.json(dashboard);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/providers/:organisationId/settings', (req, res) => {
  try {
    const profile = ensureProviderProfile(req.params.organisationId);
    const {
      onboarding_enabled,
      onboarding_pilot,
      default_renewal_days,
      signature_mode,
      adobe_template_set_id,
      config
    } = req.body || {};

    db.prepare(`
      UPDATE provider_profiles
      SET
        onboarding_enabled = COALESCE(?, onboarding_enabled),
        onboarding_pilot = COALESCE(?, onboarding_pilot),
        default_renewal_days = COALESCE(?, default_renewal_days),
        signature_mode = COALESCE(?, signature_mode),
        adobe_template_set_id = COALESCE(?, adobe_template_set_id),
        config_json = COALESCE(?, config_json),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      onboarding_enabled == null ? null : (onboarding_enabled ? 1 : 0),
      onboarding_pilot == null ? null : (onboarding_pilot ? 1 : 0),
      default_renewal_days ?? null,
      signature_mode ?? null,
      adobe_template_set_id ?? null,
      config ? JSON.stringify(config) : null,
      profile.id
    );

    seedCoreTemplates(profile.id);
    const coverage = getTemplateCoverage(profile.id);
    const updated = db.prepare('SELECT * FROM provider_profiles WHERE id = ?').get(profile.id);
    res.json({ provider_profile: updated, template_coverage: coverage });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/providers/:organisationId/templates', (req, res) => {
  try {
    const profile = ensureProviderProfile(req.params.organisationId);
    seedCoreTemplates(profile.id);
    const coverage = getTemplateCoverage(profile.id);
    res.json(coverage);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/participants/:id/forms/:formId/prefill-snapshot', (req, res) => {
  try {
    const onboarding = getOnboardingByParticipant(req.params.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });
    const form = onboarding.forms.find((f) => f.id === req.params.formId);
    if (!form) return res.status(404).json({ error: 'Form not found' });
    res.json({ form_id: form.id, snapshot: parseSnapshot(form) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/participants/:id/forms/:formId/document', (req, res) => {
  try {
    const onboarding = getOnboardingByParticipant(req.params.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });
    const form = onboarding.forms.find((f) => f.id === req.params.formId);
    if (!form) return res.status(404).json({ error: 'Form not found' });
    let buf;
    let ext = 'pdf';
    if (form.form_type === 'privacy_consent' && getConsentFormPath()) {
      const participant = db.prepare('SELECT * FROM participants WHERE id = ?').get(req.params.id);
      const intakeRows = db.prepare('SELECT field_key, field_value FROM participant_intake_fields WHERE participant_onboarding_id = ?').all(onboarding.id);
      const intake = Object.fromEntries((intakeRows || []).map((r) => [r.field_key, r.field_value]));
      buf = fillConsentForm(participant, intake);
      ext = 'docx';
    } else if (form.draft_document_path && existsSync(form.draft_document_path)) {
      const lower = form.draft_document_path.toLowerCase();
      if (lower.endsWith('.json')) {
        return res.status(404).json({ error: 'No document template for this form type. Add a template to data/forms/templates/ for the relevant form type.' });
      }
      buf = readFileSync(form.draft_document_path);
      ext = lower.endsWith('.docx') ? 'docx' : 'pdf';
    } else {
      return res.status(404).json({ error: 'Document not found. Generate the form first.' });
    }
    const mime = ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf';
    const filename = `${form.display_name || form.form_type}-${onboarding.participant_id}.${ext}`.replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/participants/:id/forms/:formId/document', memoryUpload.single('document'), (req, res) => {
  try {
    const onboarding = getOnboardingByParticipant(req.params.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });
    const form = onboarding.forms.find((f) => f.id === req.params.formId);
    if (!form) return res.status(404).json({ error: 'Form not found' });
    if (!['generated', 'draft'].includes(form.status)) {
      return res.status(400).json({ error: 'Can only replace document for draft or generated forms.' });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No document file uploaded.' });
    }
    const ext = (req.file.originalname || '').toLowerCase().endsWith('.docx') ? 'docx' : 'pdf';
    mkdirSync(onboardingDir, { recursive: true });
    const newPath = join(onboardingDir, `${form.participant_id}-${form.form_type}-v${form.version}.${ext}`);
    writeFileSync(newPath, req.file.buffer);
    db.prepare('UPDATE participant_form_instances SET draft_document_path = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(newPath, req.params.formId);
    const putMime =
      ext === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/pdf';
    const putName = `${form.display_name || form.form_type}-draft.${ext}`.replace(/[^a-zA-Z0-9._-]/g, '_');
    void tryPushParticipantDocument({
      participantId: req.params.id,
      category: form.display_name || form.form_type || 'Service agreement',
      buffer: req.file.buffer,
      originalFilename: putName,
      mimeType: putMime,
      notes: 'Draft form document uploaded'
    });
    res.json({ ok: true, message: 'Document updated. You can now send for signature.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/participants/:id/forms/:formInstanceId', (req, res) => {
  try {
    const onboarding = getOnboardingByParticipant(req.params.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });
    const form = db.prepare(`
      SELECT pfi.*, ft.form_type, ft.display_name
      FROM participant_form_instances pfi
      JOIN form_templates ft ON ft.id = pfi.form_template_id
      WHERE pfi.id = ? AND pfi.participant_onboarding_id = ?
    `).get(req.params.formInstanceId, onboarding.id);
    if (!form) return res.status(404).json({ error: 'Form not found' });
    if (!['generated', 'draft'].includes(form.status)) {
      return res.status(400).json({ error: `Cannot delete form that is ${form.status}. Only draft or generated forms can be deleted.` });
    }
    db.prepare('DELETE FROM participant_form_instances WHERE id = ?').run(req.params.formInstanceId);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
