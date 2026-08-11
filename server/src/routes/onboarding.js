import { Router } from 'express';
import multer from 'multer';
import { db } from '../db/index.js';
import { canAccessParticipant, sessionIsAdminOrDelegate, requireAdminOrDelegate } from '../middleware/roles.js';
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
  createAuditEvent,
  assertProviderOnboardingReady,
  preparePrivacyConsentForm,
  resolveActiveServiceAgreementTemplate,
  generateServiceAgreementForBridge,
  CORE_SERVICE_AGREEMENT_MASTER_ID
} from '../services/onboarding.service.js';
import { createAgreementPacket, createAgreementWithDocument, uploadTransientDocument } from '../services/nativeSignature.service.js';
import {
  buildServiceAgreementDocuSealFields,
  isServiceAgreementSnapshot
} from '../services/serviceAgreementDocuSealFields.service.js';
import { buildServiceAgreementSnapshot } from '../services/serviceAgreementSnapshot.service.js';
import { generateServiceAgreementPdfBuffer } from '../services/serviceAgreementPdf.service.js';
import {
  buildCustomFormDocuSealFields,
  resolveOrgSignatoryForDocuSeal
} from '../services/customFormDocuSealFields.service.js';
import { buildPrivacyConsentDocuSealFields } from '../services/privacyConsentDocuSealFields.service.js';
import { parseSigningLayout } from '../services/formTemplateSigningLayout.service.js';
import { isPrivacyConsentSnapshot, buildPrivacyConsentSnapshot } from '../services/privacyConsentSnapshot.service.js';
import { generatePrivacyConsentPdfBuffer } from '../services/privacyConsentPdf.service.js';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fillConsentForm, getConsentFormPath, convertDocxToPdf } from '../services/consentForm.service.js';
import { tryPushParticipantDocument } from '../services/orgOnedriveSync.service.js';
import { sendEmailViaRelay, isEmailConfiguredForUser, formatSmtpAuthError } from '../services/notification.service.js';
import { prepareSplitOnboardingSend } from '../services/onboardingDocumentSend.service.js';
import { listOnboardingLibraryMasters, renderLibraryMasterAttachment } from '../services/onboardingDocumentPacks.service.js';
import { getLibraryMasterOrgFields } from '../services/libraryDocumentSignature.service.js';
import { VALID_PARTICIPANT_SERVICE_TYPES } from '../../../shared/onboardingDocumentContext.js';
import { orchestrateParticipantOnboarding } from '../services/participantOnboardingOrchestrator.service.js';
import {
  issueIntakeToken,
  getLatestIntakeTokenForParticipant
} from '../services/participantIntakeToken.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const onboardingDir = join(projectRoot, 'data', 'onboarding');

const router = Router();
const memoryUpload = multer({ storage: multer.memoryStorage() });

/** Same resolution the document-picker list (documentLibrary.js) uses — keeps the org that
 *  decides which library masters are selectable consistent with the org used to render/preview
 *  them. Do not resolve org via the participant's onboarding->provider_profile chain here: that
 *  can diverge from the requester's own org (e.g. via the orchestrator's org-resolution
 *  fallbacks), which previously caused "Document not found" — the picker would list a master
 *  cloned for the requester's org, but the preview looked it up under a different org. */
function requesterOrgId(req) {
  return db.prepare('SELECT org_id FROM users WHERE id = ?').get(req.session?.user?.id)?.org_id || null;
}

function actorContext(req) {
  return {
    actorType: req.headers['x-actor-type'] || 'user',
    actorId: req.headers['x-actor-id'] || null,
    sourceIp: req.headers['x-forwarded-for'] || req.ip || null,
    userAgent: req.headers['user-agent'] || null
  };
}

/**
 * Send an already-generated Service Agreement participant_form_instances row for native
 * signature. Deliberately a focused duplicate of the service_agreement branch inside
 * POST /participants/:id/send-form/:formInstanceId, rather than a shared extraction — that
 * route handles several other form types in the same function body, and duplicating this one
 * proven path here was lower-risk than restructuring it. Used by send-onboarding-pack for the
 * "core:service_agreement" pseudo-document; keep both in sync if the signer-resolution logic
 * changes (see deriveSigners in serviceAgreementDocuSealFields.service.js).
 */
async function sendServiceAgreementFormInstanceForSignature({ participantId, formInstanceId, req }) {
  const onboarding = getOnboardingByParticipant(participantId);
  if (!onboarding) throw Object.assign(new Error('Onboarding not found'), { code: 'ONBOARDING_NOT_FOUND' });

  const participant = db
    .prepare('SELECT id, name, email FROM participants WHERE id = ?')
    .get(participantId);
  if (!participant) throw Object.assign(new Error('Participant not found'), { code: 'PARTICIPANT_NOT_FOUND' });

  const form = db
    .prepare(
      `SELECT pfi.*, ft.form_type, ft.display_name
       FROM participant_form_instances pfi
       JOIN form_templates ft ON ft.id = pfi.form_template_id
       WHERE pfi.id = ? AND pfi.participant_onboarding_id = ?`
    )
    .get(formInstanceId, onboarding.id);
  if (!form || !form.draft_document_path || !existsSync(form.draft_document_path)) {
    throw Object.assign(new Error('Service Agreement document not found.'), { code: 'SERVICE_AGREEMENT_BRIDGE_FAILED' });
  }

  const organisationId = onboarding.organisation_id || null;
  const envelopeRecords = createEnvelopeRecords({
    participantId: participant.id,
    participantOnboardingId: onboarding.id,
    packets: [[form]],
    packetMode: 'separate',
    ...actorContext(req)
  });
  const envelope = envelopeRecords[0];

  let snap = {};
  try {
    snap = parseSnapshot(form) || {};
  } catch {
    snap = {};
  }

  const docBuffer = readFileSync(form.draft_document_path);
  const filename = `${form.display_name || 'Service-Agreement'}-${participant.name || 'Participant'}.pdf`.replace(/[^a-zA-Z0-9._-]/g, '_');

  let docuSealFieldOpts = {};
  let twoSignerSigners = null;
  if (isServiceAgreementSnapshot(snap)) {
    docuSealFieldOpts = buildServiceAgreementDocuSealFields(snap);
    const derived = docuSealFieldOpts.signers || {};
    const orgEmail = (derived.org?.email || '').trim();
    const orgName = (derived.org?.name || '').trim();
    const primaryEmail = (derived.participant?.email || participant.email || '').trim();
    const primaryName = (derived.participant?.name || participant.name || '').trim();
    if (!orgEmail) {
      throw Object.assign(new Error('Set the default signatory email in Settings → Business so the organisation admin signs first.'), {
        code: 'ORG_SIGNATORY_MISSING'
      });
    }
    if (!primaryEmail) {
      throw Object.assign(
        new Error(
          snap.signer_type === 'guardian'
            ? 'Add a representative/guardian email before sending for signature.'
            : 'Add a participant email before sending for signature.'
        ),
        { code: 'GUARDIAN_EMAIL_MISSING' }
      );
    }
    twoSignerSigners = [
      { name: orgName || 'Organisation admin', email: orgEmail, order: 0, role: derived.org?.role || 'Organisation admin' },
      { name: primaryName || 'Participant', email: primaryEmail, order: 1, role: derived.participant?.role || 'Participant' }
    ];
  }

  const transientId = await uploadTransientDocument(docBuffer, filename, organisationId, {
    formFieldsPerDocument: docuSealFieldOpts.formFieldsPerDocument,
    signers: twoSignerSigners
  });
  const agreement = await createAgreementWithDocument({
    participantName: participant.name,
    participantEmail: participant.email,
    envelopeId: envelope.envelope_id,
    transientDocumentId: transientId,
    documentName: form.display_name || 'Service Agreement',
    orgId: organisationId
  });

  db.prepare(
    `UPDATE signature_envelopes
     SET external_envelope_id = ?, provider_name = ?, status = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(agreement.external_envelope_id, agreement.provider || 'native', agreement.status || 'sent', envelope.envelope_id);

  try {
    void tryPushParticipantDocument({
      participantId: participant.id,
      category: 'Service agreements',
      buffer: docBuffer,
      originalFilename: filename,
      mimeType: 'application/pdf',
      notes: `Sent for signature: ${form.display_name || 'Service Agreement'}`
    });
  } catch (pushErr) {
    console.warn('[onboarding] OneDrive copy after service agreement send:', pushErr?.message);
  }

  return {
    master_id: CORE_SERVICE_AGREEMENT_MASTER_ID,
    envelope_id: envelope.envelope_id,
    status: 'sent',
    display_name: form.display_name || 'Service Agreement'
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

/**
 * Phase 2: One-click onboarding orchestrator.
 *
 * Composes provider readiness + library clone + initialize + generate-form-pack into a
 * single idempotent endpoint. Returns a per-step status array so the UI can show progress
 * and the user can see exactly which prerequisite (if any) is blocking. Signature handoff
 * happens via the existing per-form send endpoints — this orchestrator does not interact
 * with any signing provider directly.
 */
router.post('/participants/:id/onboarding/run', async (req, res) => {
  try {
    const result = await orchestrateParticipantOnboarding({
      participantId: req.params.id,
      // Prefer the requesting admin's own org over whatever's stored on the participant row —
      // keeps this consistent with how the document picker/preview/send resolve org, so the
      // onboarding pack this run prepares is always selectable/renderable by whoever ran it.
      providerOrganisationId: req.body?.provider_organisation_id || requesterOrgId(req) || null,
      userId: req.session?.user?.id || null,
      ...actorContext(req)
    });
    const code = result.ready ? 200 : 409;
    res.status(code).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Phase 4: Issue a self-service intake token for the participant and email them the link.
 *
 * Body (all optional):
 *   ttl_days       — default 30
 *   skip_email     — true to just generate the token (coordinator copies/shares it manually)
 *
 * Returns the URL only on issue; the token itself is hashed before storage.
 */
router.post('/participants/:id/intake-token', async (req, res) => {
  try {
    const userId = req.session?.user?.id || null;
    const participant = db
      .prepare('SELECT id, name, email, provider_org_id, plan_manager_id FROM participants WHERE id = ?')
      .get(req.params.id);
    if (!participant) return res.status(404).json({ error: 'Participant not found' });

    const orgId = participant.provider_org_id || participant.plan_manager_id || null;
    const issued = issueIntakeToken({
      participantId: req.params.id,
      organisationId: orgId,
      issuedByUserId: userId,
      ttlDays: Number.isFinite(req.body?.ttl_days) ? Number(req.body.ttl_days) : 30
    });

    const baseUrl = (process.env.FRONTEND_BASE_URL || process.env.BASE_URL || 'http://localhost:5174').replace(/\/$/, '');
    const intakeUrl = `${baseUrl}/intake/${issued.token}`;

    // send_to_email overrides the participant's email on file (e.g. send to guardian/coordinator)
    const sendToEmail = (req.body?.send_to_email || '').trim() || participant.email?.trim() || '';
    const sendToNote  = (req.body?.send_to_note || '').trim(); // optional label e.g. "Parent: Jane Smith"

    let emailSent = false;
    let emailError = null;
    if (!req.body?.skip_email && sendToEmail && userId && isEmailConfiguredForUser(userId)) {
      try {
        const org = orgId ? db.prepare('SELECT name FROM organisations WHERE id = ?').get(orgId) : null;
        const orgName = org?.name || process.env.COMPANY_NAME || 'Nexus Core';
        const subject = `${orgName}: complete ${participant.name ? `${participant.name}'s` : 'your'} intake details`;
        let text = `Hi ${sendToNote ? sendToNote.split(':')[0] : (participant.name || 'there')},\n\n`;
        if (sendToNote) {
          text += `This intake form is for ${participant.name || 'a participant'} at ${orgName}.\n\n`;
        } else {
          text += `${orgName} has asked you to complete your intake details using the secure link below. It saves automatically as you go.\n\n`;
        }
        text += `Intake form: ${intakeUrl}\n\n`;
        text += `The link expires on ${new Date(issued.expires_at).toLocaleDateString('en-AU')}. If you have questions reply to this email.\n`;
        await sendEmailViaRelay(userId, sendToEmail, subject, text, null, null, orgName);
        emailSent = true;
      } catch (e) {
        emailError = formatSmtpAuthError(e);
      }
    }

    createAuditEvent({
      participantId: req.params.id,
      actorType: 'user',
      actorId: userId,
      eventType: 'participant_intake_token_issued',
      entityType: 'participant',
      entityId: req.params.id,
      newValue: { expires_at: issued.expires_at, email_sent: emailSent, send_to_email: sendToEmail || null },
      sourceIp: req.headers['x-forwarded-for'] || req.ip || null,
      userAgent: req.headers['user-agent'] || null
    });

    res.status(201).json({
      url: intakeUrl,
      expires_at: issued.expires_at,
      email_sent: emailSent,
      email_error: emailError,
      send_to_email: sendToEmail || null
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/participants/:id/intake-token', (req, res) => {
  try {
    const latest = getLatestIntakeTokenForParticipant(req.params.id);
    res.json({ token_record: latest || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Phase 2: Detailed onboarding status payload (richer than /status — includes which steps
 * are currently blocked by readiness checks). Used by ParticipantProfile to render the
 * "Run onboarding" button + per-form badges.
 */
router.get('/participants/:id/onboarding/status', (req, res) => {
  try {
    const onboarding = getOnboardingByParticipant(req.params.id);
    const participant = db
      .prepare('SELECT id, name, provider_org_id, plan_manager_id FROM participants WHERE id = ?')
      .get(req.params.id);
    const providerOrgId =
      participant?.provider_org_id ||
      participant?.plan_manager_id ||
      onboarding?.organisation_id ||
      null;

    /** @type {{ ready: boolean, reason?: string, code?: string }} */
    let readiness = { ready: false };
    if (providerOrgId) {
      try {
        const result = assertProviderOnboardingReady(providerOrgId);
        readiness = {
          ready: true,
          warning: result.warning || undefined,
          warning_code: result.warning_code || undefined,
          library_document_count: result.libraryCount,
          extra_pdf_count: result.policyCount
        };
      } catch (err) {
        readiness = { ready: false, reason: err.message, code: err.code || 'NOT_READY' };
      }
    } else {
      readiness = { ready: false, reason: 'No provider organisation linked to participant.', code: 'PROVIDER_ORG_MISSING' };
    }

    res.json({
      participant: participant ? { id: participant.id, name: participant.name } : null,
      provider_organisation_id: providerOrgId,
      readiness,
      onboarding
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/participants/:id/send-onboarding-pack', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const masterIds = req.body?.master_ids;
    const hasSelection = Array.isArray(masterIds);
    if (hasSelection && !sessionIsAdminOrDelegate(req.session)) {
      return res.status(403).json({ error: 'Document selection requires admin or delegate access' });
    }

    const participantServiceType = req.body?.participant_service_type || null;
    if (participantServiceType && !VALID_PARTICIPANT_SERVICE_TYPES.has(participantServiceType)) {
      return res.status(400).json({ error: 'invalid participant_service_type' });
    }

    if (!isEmailConfiguredForUser(userId)) {
      return res.status(400).json({
        error: 'Connect your email in Settings to send messages.',
        code: 'EMAIL_NOT_CONNECTED'
      });
    }

    const onboarding = getOnboardingByParticipant(req.params.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });

    const participant = db.prepare(`SELECT id, name, email FROM participants WHERE id = ?`).get(req.params.id);
    if (!participant?.email?.trim()) return res.status(400).json({ error: 'Participant has no email address' });

    // Resolve org/profile from the requesting admin's own session — must match how the document
    // picker (documentLibrary.js) resolves org, since masterIds selected there only exist under
    // that org's clone set. Using the onboarding row's provider_profile_id here previously caused
    // "Document not found"-style mismatches when it pointed at a different org.
    const orgId = requesterOrgId(req);
    const providerProfileId = orgId ? ensureProviderProfile(orgId)?.id || null : null;
    const org = orgId ? db.prepare(`SELECT name FROM organisations WHERE id = ?`).get(orgId) : null;
    const orgName = org?.name || process.env.COMPANY_NAME || 'Nexus Core';
    const fullParticipant = db.prepare('SELECT * FROM participants WHERE id = ?').get(req.params.id);
    const includeExtraPdfs = req.body?.include_extra_pdfs !== false;
    const adminFieldValuesByMasterId = req.body?.admin_field_values || {};

    // The Service Agreement pseudo-document isn't a document_library_masters row — pull it out
    // before the library pipeline sees it (it would 404 looking it up), handle it via the
    // Service Agreement's own generate/gap-check/bridge pipeline below instead.
    const wantsServiceAgreement = hasSelection && masterIds.includes(CORE_SERVICE_AGREEMENT_MASTER_ID);
    const libraryMasterIds = hasSelection ? masterIds.filter((id) => id !== CORE_SERVICE_AGREEMENT_MASTER_ID) : masterIds;

    let attachments = [];
    let signatureRequests = [];
    try {
      const splitSend = await prepareSplitOnboardingSend({
        orgId,
        providerProfileId,
        workflow: 'participant_onboarding',
        masterIds: hasSelection ? libraryMasterIds : undefined,
        participant: fullParticipant,
        includeExtraPdfs,
        orgName,
        adminFieldValuesByMasterId
      });
      attachments = splitSend.policyAttachments;
      signatureRequests = splitSend.signatureRequests;
    } catch (err) {
      if (err.code === 'ESIGNATURE_NOT_ENABLED' || err.code === 'DOCUSEAL_NOT_ENABLED') {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      if (err.code === 'ORG_SIGNATORY_MISSING' || err.code === 'SIGNER_EMAIL_MISSING') {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      throw err;
    }

    if (wantsServiceAgreement) {
      try {
        const signerType = adminFieldValuesByMasterId[CORE_SERVICE_AGREEMENT_MASTER_ID]?.signer_type === 'guardian' ? 'guardian' : 'participant';
        const { formInstanceId } = await generateServiceAgreementForBridge({
          participantId: req.params.id,
          orgId,
          instanceOverrides: { signer_type: signerType }
        });
        const saResult = await sendServiceAgreementFormInstanceForSignature({
          participantId: req.params.id,
          formInstanceId,
          req
        });
        signatureRequests = [...signatureRequests, saResult];
      } catch (err) {
        if (['NO_SERVICE_AGREEMENT_TEMPLATE', 'SERVICE_AGREEMENT_GAPS', 'SERVICE_AGREEMENT_BRIDGE_FAILED', 'GUARDIAN_EMAIL_MISSING'].includes(err.code)) {
          return res.status(400).json({ error: err.message, code: err.code, gaps: err.gaps || undefined });
        }
        throw err;
      }
    }

    if (!attachments.length && !signatureRequests.length) {
      return res.status(400).json({
        error:
          'No documents to send. Add participant onboarding documents to the NDIS library (Forms → Document library) or upload extra organisation PDFs under Forms.',
        code: 'EMPTY_SELECTION'
      });
    }

    db.prepare(
      `UPDATE participant_onboarding SET last_activity_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).run(onboarding.id);

    const subject = `${orgName}: onboarding documents`;
    let text = `Hi ${participant.name || 'there'},\n\n`;
    if (attachments.length) {
      text += `Please find attached documents from ${orgName}. Keep them for your records.\n\n`;
    } else {
      text += `${orgName} has sent you onboarding forms to complete.\n\n`;
    }
    if (signatureRequests.length) {
      text += `${signatureRequests.length} form${signatureRequests.length === 1 ? ' has' : 's have'} been sent to you separately for e-signature via Nexus Core. Check your inbox for signing requests.\n\n`;
    }
    text += `Your coordinator will guide you through the rest of onboarding in Nexus Core.\n\n`;
    text += `If you have questions, reply to this email.\n`;

    const attachmentsForEmail = attachments.map((a) => ({
      ...a,
      content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content
    }));
    await sendEmailViaRelay(userId, participant.email.trim(), subject, text, null, attachmentsForEmail, orgName);

    createAuditEvent({
      participantId: req.params.id,
      participantOnboardingId: onboarding.id,
      actorType: 'user',
      actorId: userId,
      eventType: 'onboarding_document_pack_sent',
      entityType: 'onboarding',
      entityId: onboarding.id,
      newValue: {
        attachment_count: attachments.length,
        signature_request_count: signatureRequests.length,
        ...(hasSelection ? { master_ids: masterIds, participant_service_type: participantServiceType } : {})
      },
      sourceIp: req.headers['x-forwarded-for'] || req.ip || null,
      userAgent: req.headers['user-agent'] || null
    });

    res.json({
      ok: true,
      attachment_count: attachments.length,
      signature_requests: signatureRequests,
      signature_request_count: signatureRequests.length
    });
  } catch (err) {
    console.error('[send-onboarding-pack]', err);
    res.status(400).json({ error: formatSmtpAuthError(err) });
  }
});

// GET /api/onboarding/participants/:id/onboarding-org-fields/:masterId — the org-signer fields
// (signature/date/text boxes) declared on a library master's signing_layout, used by the admin
// fill-and-sign preview to know which admin_fields have a real page position worth overlaying.
router.get('/participants/:id/onboarding-org-fields/:masterId', requireAdminOrDelegate, async (req, res) => {
  try {
    const onboarding = getOnboardingByParticipant(req.params.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });
    const orgId = requesterOrgId(req);
    // The Service Agreement pseudo-document has no positioned org fields — its only admin_field
    // (signer_type) is a plain choice, not something overlaid on the page.
    if (req.params.masterId === CORE_SERVICE_AGREEMENT_MASTER_ID) {
      return res.json({ fields: [] });
    }
    const master = listOnboardingLibraryMasters(orgId, 'participant_onboarding').find((m) => m.id === req.params.masterId);
    if (!master) return res.status(404).json({ error: 'Document not found' });
    const fields = await getLibraryMasterOrgFields({ masterId: master.id, orgId, workflow: 'participant_onboarding' });
    res.json({ fields });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/onboarding/participants/:id/onboarding-preview — render a library master with the
// admin's in-progress field values, for the fill-and-sign preview. Read-only: never touches the
// actual send path.
router.post('/participants/:id/onboarding-preview', requireAdminOrDelegate, async (req, res) => {
  try {
    const onboarding = getOnboardingByParticipant(req.params.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });
    const orgId = requesterOrgId(req);
    const masterId = req.body?.master_id;
    const extra = req.body?.admin_field_values && typeof req.body.admin_field_values === 'object' ? req.body.admin_field_values : {};

    if (masterId === CORE_SERVICE_AGREEMENT_MASTER_ID) {
      const resolved = resolveActiveServiceAgreementTemplate(orgId);
      if (!resolved) return res.status(404).json({ error: 'Document not found' });
      const snapshot = buildServiceAgreementSnapshot({
        participantId: req.params.id,
        orgId,
        masterRow: resolved.master,
        orgTemplateRow: resolved.orgTemplate,
        instanceOverrides: { signer_type: extra.signer_type === 'guardian' ? 'guardian' : 'participant' }
      });
      const pdfBuffer = await generateServiceAgreementPdfBuffer(snapshot);
      res.setHeader('Content-Type', 'application/pdf');
      return res.send(pdfBuffer);
    }

    const master = listOnboardingLibraryMasters(orgId, 'participant_onboarding').find((m) => m.id === masterId);
    if (!master) return res.status(404).json({ error: 'Document not found' });
    const fullParticipant = db.prepare('SELECT * FROM participants WHERE id = ?').get(req.params.id);
    const att = await renderLibraryMasterAttachment(master, orgId, { participant: fullParticipant, extra });
    if (!att?.content) return res.status(500).json({ error: 'Could not render preview' });
    res.setHeader('Content-Type', att.contentType || 'application/pdf');
    res.send(att.content);
  } catch (err) {
    console.error('[onboarding-preview]', err);
    res.status(500).json({ error: err.message || 'Could not render preview' });
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

// POST /api/onboarding/participants/:id/forms/:formInstanceId/privacy-consent-signer — the one
// thing the sender decides before sending a Privacy Consent form: does the participant sign
// Section A themselves, or does a guardian/representative sign Section B on their behalf.
// Re-renders the draft in place with that choice applied; call before send-form.
router.post('/participants/:id/forms/:formInstanceId/privacy-consent-signer', requireAdminOrDelegate, async (req, res) => {
  try {
    const signerType = req.body?.signer_type === 'guardian' ? 'guardian' : 'participant';
    const result = await preparePrivacyConsentForm({
      participantId: req.params.id,
      formInstanceId: req.params.formInstanceId,
      signerType,
      actingUserId: req.session?.user?.id || null
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

router.post('/participants/:id/send-form/:formInstanceId', async (req, res) => {
  try {
    const onboarding = getOnboardingByParticipant(req.params.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });

    const participant = db.prepare('SELECT id, name, email, phone, address, date_of_birth, ndis_number, parent_guardian_phone, parent_guardian_email FROM participants WHERE id = ?').get(req.params.id);
    if (!participant) return res.status(404).json({ error: 'Participant not found' });

    const form = db.prepare(`
      SELECT pfi.*, ft.form_type, ft.display_name, ft.template_filename, ft.workflow, ft.mapping_json AS template_mapping_json
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

    const organisationId = onboarding.organisation_id || null;
    const consentPathOpts = { organisationId, templateFilename: form.template_filename || null };
    if (form.form_type === 'privacy_consent') {
      const intakeRows = db.prepare(`
        SELECT field_key, field_value FROM participant_intake_fields
        WHERE participant_onboarding_id = ?
      `).all(onboarding.id);
      const intake = Object.fromEntries(intakeRows.map((r) => [r.field_key, r.field_value]));
      const actingUserRow = req.session?.user?.id
        ? db.prepare('SELECT name, signature_data FROM users WHERE id = ?').get(req.session.user.id)
        : null;
      const coordinatorSignatureDataUrl = actingUserRow?.signature_data || null;
      const resolved = getConsentFormPath(consentPathOpts);
      // Structured, data-driven PDF is the default (matches generateFormPack) — only the legacy
      // docx flow when an org has explicitly uploaded their own custom .docx consent form.
      const isCustomDocx = resolved && String(resolved).toLowerCase().endsWith('.docx');
      if (!isCustomDocx) {
        const snap = parseSnapshot(form) || {};
        const pcSnap = snap.privacy_consent && isPrivacyConsentSnapshot(snap.privacy_consent)
          ? snap.privacy_consent
          : buildPrivacyConsentSnapshot({
              participantId: participant.id,
              participantOnboardingId: onboarding.id,
              overrides: {},
              coordinatorName: actingUserRow?.name || '',
              coordinatorSignatureDataUrl
            });
        const pdfBuffer = await generatePrivacyConsentPdfBuffer(pcSnap);
        const filename = 'Privacy-Consent-Form.pdf';
        oneDriveCopy = {
          buffer: pdfBuffer,
          originalFilename: filename,
          mimeType: 'application/pdf',
          category: 'Consent and service agreement'
        };
        const docuSealFields = buildPrivacyConsentDocuSealFields(pcSnap);
        const transientId = await uploadTransientDocument(pdfBuffer, filename, organisationId, {
          formFieldsPerDocument: docuSealFields.formFieldsPerDocument,
          signers: docuSealFields.signers?.participant ? [docuSealFields.signers.participant] : null
        });
        agreement = await createAgreementWithDocument({
          participantName: participant.name,
          participantEmail: participant.email,
          envelopeId: envelope.envelope_id,
          transientDocumentId: transientId,
          documentName: 'Privacy Consent Form',
          orgId: organisationId
        });
      } else {
        const docBuffer = fillConsentForm(
          participant,
          intake,
          coordinatorSignatureDataUrl
            ? { coordinatorSignatureDataUrl, ...consentPathOpts }
            : { ...consentPathOpts }
        );
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
        const transientId = await uploadTransientDocument(uploadBuf, consentFilename, organisationId);
        agreement = await createAgreementWithDocument({
          participantName: participant.name,
          participantEmail: participant.email,
          envelopeId: envelope.envelope_id,
          transientDocumentId: transientId,
          documentName: 'Privacy Consent (NDIS)',
          orgId: organisationId
        });
      }
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
      let docuSealFieldOpts = {};
      let twoSignerSigners = null;
      if (form.form_type === 'service_agreement' && ext === 'pdf') {
        let snap = {};
        try {
          snap = parseSnapshot(form);
        } catch {
          snap = {};
        }
        if (isServiceAgreementSnapshot(snap)) {
          docuSealFieldOpts = buildServiceAgreementDocuSealFields(snap);
          const derived = docuSealFieldOpts.signers || {};
          const orgEmail = (derived.org?.email || '').trim();
          const orgName = (derived.org?.name || '').trim();
          // Use the resolved signer (participant or guardian, per snapshot.signer_type — see
          // deriveSigners in serviceAgreementDocuSealFields.service.js), not raw participant.*
          // directly, or a guardian choice would silently never take effect on the actual send.
          const primaryEmail = (derived.participant?.email || participant.email || '').trim();
          const primaryName = (derived.participant?.name || participant.name || '').trim();
          if (!orgEmail) {
            return res
              .status(400)
              .json({ error: 'Set the default signatory email in Settings → Business so the organisation admin signs first.' });
          }
          if (!primaryEmail) {
            return res.status(400).json({
              error:
                snap.signer_type === 'guardian'
                  ? 'Add a representative/guardian email before sending for signature.'
                  : 'Add a participant email before sending for signature.'
            });
          }
          twoSignerSigners = [
            { name: orgName || 'Organisation admin', email: orgEmail, order: 0, role: derived.org?.role || 'Organisation admin' },
            { name: primaryName || 'Participant', email: primaryEmail, order: 1, role: derived.participant?.role || 'Participant' }
          ];
        }
      } else if (form.form_type === 'custom' && ext === 'pdf') {
        let templateMapping = {};
        try {
          templateMapping =
            typeof form.template_mapping_json === 'string'
              ? JSON.parse(form.template_mapping_json)
              : form.template_mapping_json || {};
        } catch {
          templateMapping = {};
        }
        const signingLayout = parseSigningLayout(templateMapping);
        if (signingLayout?.fields?.length) {
          const orgSignatory = resolveOrgSignatoryForDocuSeal(organisationId);
          docuSealFieldOpts = buildCustomFormDocuSealFields(signingLayout, {
            workflow: form.workflow || 'participant_onboarding',
            org: orgSignatory,
            participant: { name: participant.name, email: participant.email },
            staff: { name: participant.name, email: participant.email }
          });
          if (docuSealFieldOpts.signers?.length) {
            const orgEmail = (docuSealFieldOpts.signers[0]?.email || '').trim();
            const primaryEmail = (docuSealFieldOpts.signers[1]?.email || '').trim();
            if (!orgEmail) {
              return res
                .status(400)
                .json({ error: 'Set the default signatory email in Settings → Business for organisation signature fields.' });
            }
            if (!primaryEmail) {
              return res.status(400).json({ error: 'Add a participant email before sending for signature.' });
            }
            twoSignerSigners = docuSealFieldOpts.signers;
          }
        }
      }
      const transientId = await uploadTransientDocument(docBuffer, filename, organisationId, {
        formFieldsPerDocument: docuSealFieldOpts.formFieldsPerDocument,
        signers: twoSignerSigners
      });
      agreement = await createAgreementWithDocument({
        participantName: participant.name,
        participantEmail: participant.email,
        envelopeId: envelope.envelope_id,
        transientDocumentId: transientId,
        documentName: form.display_name || form.form_type,
        orgId: organisationId
      });
    } else {
      agreement = await createAgreementPacket({
        participantName: participant.name,
        participantEmail: participant.email,
        envelopeId: envelope.envelope_id,
        forms: [form],
        orgId: organisationId
      });
    }

    db.prepare(`
      UPDATE signature_envelopes
      SET external_envelope_id = ?, provider_name = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(agreement.external_envelope_id, agreement.provider || 'native', agreement.status || 'sent', envelope.envelope_id);

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

    const organisationId = onboarding.organisation_id || null;

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
        forms: packetForms,
        orgId: organisationId
      });
      db.prepare(`
        UPDATE signature_envelopes
        SET external_envelope_id = ?, provider_name = ?, status = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(agreement.external_envelope_id, agreement.provider || 'native', agreement.status || 'sent', envelope.envelope_id);
      envelopeResponses.push({ ...envelope, ...agreement });
    }

    res.status(201).json({ envelopes: envelopeResponses, count: envelopeResponses.length });
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
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const oid = req.params.organisationId;
    if (!req.session.user.org_id || req.session.user.org_id !== oid) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const dashboard = getProviderComplianceDashboard(oid);
    res.json(dashboard);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/providers/:organisationId/settings', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const oid = req.params.organisationId;
    if (!req.session.user.org_id || req.session.user.org_id !== oid) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const profile = ensureProviderProfile(oid);
    seedCoreTemplates(profile.id);
    const coverage = getTemplateCoverage(profile.id);
    let readiness = { ready: false, reason: null };
    try {
      const result = assertProviderOnboardingReady(oid);
      readiness = {
        ready: true,
        reason: null,
        warning: result.warning || undefined,
        warning_code: result.warning_code || undefined,
        library_document_count: result.libraryCount,
        extra_pdf_count: result.policyCount
      };
    } catch (e) {
      readiness = { ready: false, reason: e.message, code: e.code || 'NOT_READY' };
    }
    let config = {};
    if (profile.config_json) {
      try { config = JSON.parse(profile.config_json); } catch { config = {}; }
    }
    res.json({
      provider_profile: profile,
      config,
      template_coverage: coverage,
      readiness
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/providers/:organisationId/settings', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const oid = req.params.organisationId;
    if (!req.session.user.org_id || req.session.user.org_id !== oid) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const profile = ensureProviderProfile(oid);
    const {
      onboarding_enabled,
      onboarding_pilot,
      default_renewal_days,
      signature_mode,
      config
    } = req.body || {};

    db.prepare(`
      UPDATE provider_profiles
      SET
        onboarding_enabled = COALESCE(?, onboarding_enabled),
        onboarding_pilot = COALESCE(?, onboarding_pilot),
        default_renewal_days = COALESCE(?, default_renewal_days),
        signature_mode = COALESCE(?, signature_mode),
        config_json = COALESCE(?, config_json),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      onboarding_enabled == null ? null : (onboarding_enabled ? 1 : 0),
      onboarding_pilot == null ? null : (onboarding_pilot ? 1 : 0),
      default_renewal_days ?? null,
      signature_mode ?? null,
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
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const oid = req.params.organisationId;
    if (!req.session.user.org_id || req.session.user.org_id !== oid) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const profile = ensureProviderProfile(oid);
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
    const consentPathOpts = { organisationId: onboarding.organisation_id || null, templateFilename: form.template_filename || null };
    const consentTplPath = form.form_type === 'privacy_consent' ? getConsentFormPath(consentPathOpts) : null;
    const isCustomConsentDocx = consentTplPath && String(consentTplPath).toLowerCase().endsWith('.docx');
    if (isCustomConsentDocx) {
      const participant = db.prepare('SELECT * FROM participants WHERE id = ?').get(req.params.id);
      const intakeRows = db.prepare('SELECT field_key, field_value FROM participant_intake_fields WHERE participant_onboarding_id = ?').all(onboarding.id);
      const intake = Object.fromEntries((intakeRows || []).map((r) => [r.field_key, r.field_value]));
      buf = fillConsentForm(participant, intake, consentPathOpts);
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
      SELECT pfi.*, ft.form_type, ft.display_name, ft.template_filename
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
