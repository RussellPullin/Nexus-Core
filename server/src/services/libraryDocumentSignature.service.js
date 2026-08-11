/**
 * Send branded library masters (signature_count > 0) via the native e-signature service.
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import {
  hasNativeSignatureConfigured,
  sendMultiDocumentAgreement
} from './nativeSignature.service.js';
import {
  renderLibraryMasterAttachment,
  splitOnboardingMasters,
  listOnboardingLibraryMasters
} from './onboardingDocumentPacks.service.js';
import { suggestSigningLayoutFromPdf } from './formTemplateSigningLayout.service.js';
import { fillCustomFormFromLayout } from './customFormFillFromLayout.service.js';
import {
  buildCustomFormDocuSealFields,
  resolveOrgSignatoryForDocuSeal
} from './customFormDocuSealFields.service.js';

const ESIGNATURE_SETTINGS_HINT = 'Enable e-signing under Forms → Onboarding settings.';

export function isNativeSignatureEnabledForOrg(orgId) {
  if (!orgId) return hasNativeSignatureConfigured();
  const row = db.prepare(`SELECT config_json FROM provider_profiles WHERE organisation_id = ?`).get(orgId);
  let config = {};
  try {
    config = row?.config_json ? JSON.parse(row.config_json) : {};
  } catch {
    config = {};
  }
  const enabled = config.esignature_enabled ?? config.docuseal_enabled ?? config.dropbox_sign_enabled;
  if (enabled === true) return true;
  if (enabled === false) return false;
  return hasNativeSignatureConfigured();
}

export function assertNativeSignatureReady(orgId) {
  if (!isNativeSignatureEnabledForOrg(orgId)) {
    const err = new Error(`E-signing is not enabled for this organisation. ${ESIGNATURE_SETTINGS_HINT}`);
    err.code = 'ESIGNATURE_NOT_ENABLED';
    throw err;
  }
}

export function getProviderSignatureMode(orgId) {
  const row = db.prepare(`SELECT signature_mode FROM provider_profiles WHERE organisation_id = ?`).get(orgId);
  return row?.signature_mode || 'hybrid';
}

/**
 * Group library form masters into signature packets (hybrid / packet / separate).
 * @param {object[]} formMasters
 * @param {'hybrid'|'packet'|'separate'} signatureMode
 */
export function computeLibrarySignaturePackets(formMasters, signatureMode = 'hybrid') {
  if (!formMasters?.length) return [];
  if (signatureMode === 'separate') return formMasters.map((m) => [m]);
  if (signatureMode === 'packet') return [formMasters];
  const packetForms = [];
  const separatePackets = [];
  for (const master of formMasters) {
    const sigCount = Number(master.manifest?.signature_count) || 0;
    if (sigCount >= 2) separatePackets.push([master]);
    else packetForms.push(master);
  }
  const packets = [];
  if (packetForms.length) packets.push(packetForms);
  packets.push(...separatePackets);
  return packets;
}

function parseManifestSigningLayout(manifest) {
  const raw = manifest?.signing_layout;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.fields)) return null;
  return raw;
}

function ensureMultiSignerLayout(layout, master, workflow) {
  const sigCount = Number(master.manifest?.signature_count) || 0;
  if (sigCount < 2) return layout;
  const hasOrg = layout.fields.some((f) => f.signer === 'org');
  const signatureFields = layout.fields.filter((f) => f.type === 'signature');
  if (hasOrg && signatureFields.length >= 2) return layout;

  const page = layout.page_count || 1;
  const next = { ...layout, fields: [...layout.fields] };
  if (!hasOrg) {
    next.fields.unshift({
      id: uuidv4(),
      page,
      x: 72,
      y: 620,
      width: 180,
      height: 36,
      type: 'signature',
      merge_key: 'org_signature',
      label: 'Organisation signature',
      signer: 'org',
      required: true,
      api_id: 'org_signature'
    });
  }
  const primarySigner = workflow === 'staff_onboarding' ? 'staff' : 'participant';
  if (signatureFields.length === 0) {
    next.fields.push({
      id: uuidv4(),
      page,
      x: 72,
      y: 700,
      width: 180,
      height: 36,
      type: 'signature',
      merge_key: 'signature',
      label: 'Signature',
      signer: primarySigner,
      required: true,
      api_id: 'signature'
    });
  } else if (signatureFields.length === 1) {
    signatureFields[0].signer = primarySigner;
  }
  return next;
}

async function resolveSigningLayout(master, pdfBuffer, workflow) {
  const fromManifest = parseManifestSigningLayout(master.manifest);
  if (fromManifest) return ensureMultiSignerLayout(fromManifest, master, workflow);
  const suggested = await suggestSigningLayoutFromPdf(pdfBuffer, {}, workflow);
  return ensureMultiSignerLayout(suggested, master, workflow);
}

/**
 * `signerTypeOverride` ('participant' | 'guardian') lets a document that declares a `signer_type`
 * admin_field (e.g. service-schedule) have the sender explicitly pick who signs, instead of this
 * silently preferring whichever email happens to be on file. Falls back to the original
 * auto-detect (prefer guardian if present) when no document in the send declares that field, so
 * every other library master keeps its current behaviour unchanged.
 */
function resolvePrimaryRecipient({ workflow, staff, participant, signerTypeOverride = null }) {
  if (workflow === 'staff_onboarding') {
    return {
      name: staff?.name || 'Staff member',
      email: (staff?.email || '').trim(),
      role: 'worker'
    };
  }
  const guardianEmail = (participant?.guardian_email || participant?.parent_guardian_email || '').trim();
  const guardianName = participant?.guardian_name || participant?.parent_guardian_name || '';

  if (signerTypeOverride === 'guardian') {
    if (!guardianEmail) {
      const err = new Error(
        'This participant has no guardian/representative email on file. Add one before choosing "guardian" as the signer.'
      );
      err.code = 'GUARDIAN_EMAIL_MISSING';
      throw err;
    }
    return { name: guardianName || 'Guardian', email: guardianEmail, role: 'guardian' };
  }
  if (signerTypeOverride === 'participant') {
    return {
      name: participant?.name || 'Participant',
      email: (participant?.email || '').trim(),
      role: 'participant'
    };
  }

  if (guardianEmail) {
    return { name: guardianName || 'Guardian', email: guardianEmail, role: 'guardian' };
  }
  return {
    name: participant?.name || 'Participant',
    email: (participant?.email || '').trim(),
    role: 'participant'
  };
}

/**
 * Fields the organisation/supervisor must fill in (including an inline typed-name signature)
 * before this library master can be sent to a staff member — mirrors
 * staffCustomFormSignature.service.js's getStaffCustomTemplateOrgFields for the custom
 * form_templates pipeline, so the client can render the same "fill your part" wizard step.
 * @param {{ masterId: string, orgId: string, workflow: string }} params
 */
export async function getLibraryMasterOrgFields({ masterId, orgId, workflow }) {
  const master = listOnboardingLibraryMasters(orgId, workflow).find((m) => m.id === masterId);
  if (!master) return [];
  const fromManifest = parseManifestSigningLayout(master.manifest);
  if (!fromManifest) return [];
  const layout = ensureMultiSignerLayout(fromManifest, master, workflow);
  return layout.fields.filter((f) => f.signer === 'org');
}

async function prepareMasterDocument(master, orgId, workflow, { staff, participant, adminFieldValuesByMasterId = {}, recipientRole = null }) {
  const extra = adminFieldValuesByMasterId[master.id] || {};
  const att = await renderLibraryMasterAttachment(master, orgId, { staff, participant, extra });
  if (!att?.content || att.contentType !== 'application/pdf') {
    throw new Error(`Could not render ${master.display_name || master.slug} as PDF for signature.`);
  }
  let layout = await resolveSigningLayout(master, att.content, workflow);
  // A field tagged `applies_when` only belongs to one signer path (e.g. service-schedule's
  // separate Client vs Representative signature blocks) — drop whichever doesn't match who's
  // actually signing this send. Fields without the tag always apply, so this is a no-op for
  // every other library master.
  if (recipientRole) {
    layout = { ...layout, fields: layout.fields.filter((f) => !f.applies_when || f.applies_when === recipientRole) };
  }
  let buffer = att.content;

  const orgFields = layout.fields.filter((f) => f.signer === 'org');
  if (orgFields.length) {
    const missingRequired = orgFields.filter((f) => f.required && !String(extra[f.merge_key] || '').trim());
    if (missingRequired.length) {
      const err = new Error(
        `Fill in the organisation's required field(s) first: ${missingRequired.map((f) => f.label || f.merge_key).join(', ')}.`
      );
      err.code = 'ORG_FIELDS_REQUIRED';
      throw err;
    }
    buffer = await fillCustomFormFromLayout(buffer, layout, extra, { workflow });
    layout = { ...layout, fields: layout.fields.filter((f) => f.signer !== 'org') };
  }

  const orgSignatory = resolveOrgSignatoryForDocuSeal(orgId);
  const docuSealFields = buildCustomFormDocuSealFields(layout, {
    workflow,
    org: orgSignatory,
    participant: participant || {},
    staff: staff || {}
  });
  return {
    master,
    buffer,
    filename: att.filename,
    formFields: docuSealFields.formFieldsPerDocument?.[0] || [],
    signers: docuSealFields.signers
  };
}

async function sendSignaturePacket(orgId, workflow, packetMasters, { staff, participant, orgName, adminFieldValuesByMasterId = {} }) {
  // Any master in this packet can declare a `signer_type` admin_field — if the sender set one,
  // it decides who the whole packet is sent to (a guardian signing on your behalf signs
  // everything in that send, not a mix).
  const signerTypeOverride =
    packetMasters
      .map((m) => adminFieldValuesByMasterId[m.id]?.signer_type)
      .find((v) => v === 'participant' || v === 'guardian') || null;
  const recipient = resolvePrimaryRecipient({ workflow, staff, participant, signerTypeOverride });
  const prepared = [];
  for (const master of packetMasters) {
    prepared.push(
      await prepareMasterDocument(master, orgId, workflow, {
        staff,
        participant,
        adminFieldValuesByMasterId,
        recipientRole: recipient.role
      })
    );
  }

  let signers = prepared.find((p) => p.signers?.length)?.signers || null;
  if (!signers) {
    signers = [{ name: recipient.name, email: recipient.email }];
  } else {
    const orgEmail = (signers[0]?.email || '').trim();
    const primaryEmail = (signers[1]?.email || recipient.email || '').trim();
    if (!orgEmail) {
      const err = new Error('Set the default signatory email in Settings → Business before sending multi-signer forms.');
      err.code = 'ORG_SIGNATORY_MISSING';
      throw err;
    }
    if (!primaryEmail) {
      const err = new Error(
        workflow === 'staff_onboarding'
          ? 'Staff member has no email address for signature.'
          : 'Add a participant (or guardian) email before sending for signature.'
      );
      err.code = 'SIGNER_EMAIL_MISSING';
      throw err;
    }
    signers = [
      { ...signers[0], email: orgEmail },
      { ...signers[1], email: primaryEmail, name: signers[1]?.name || recipient.name }
    ];
  }

  if (!signers[0]?.email?.trim()) {
    const err = new Error(
      workflow === 'staff_onboarding'
        ? 'Staff member has no email address for signature.'
        : 'Add a participant email before sending for signature.'
    );
    err.code = 'SIGNER_EMAIL_MISSING';
    throw err;
  }

  const envelopeId = uuidv4();
  const docNames = prepared.map((p) => p.master.display_name || p.master.slug).join(', ');
  const title =
    prepared.length === 1
      ? `${prepared[0].master.display_name || 'Form'} – ${recipient.name}`
      : `${orgName || 'Onboarding'} forms – ${recipient.name}`;

  const sendResult = await sendMultiDocumentAgreement(orgId, {
    signers,
    title,
    subject: `Please sign: ${docNames}`,
    message: `Please review and sign the required onboarding form${prepared.length === 1 ? '' : 's'} from ${orgName || 'your organisation'}.`,
    documents: prepared.map((p) => ({
      buffer: p.buffer,
      filename: p.filename,
      formFields: p.formFields
    })),
    envelopeId
  });
  const externalEnvelopeId = sendResult?.envelopeId || envelopeId;

  // Staff onboarding envelopes never get a signature_envelopes row (see nativeSignature.service.js's
  // comment), so track it here instead — this is what makes it visible on Staff Profile.
  if (workflow === 'staff_onboarding' && staff?.id) {
    db.prepare(
      `INSERT INTO staff_signature_envelopes (id, envelope_id, staff_id, org_id, display_name, status, sent_at)
       VALUES (?, ?, ?, ?, ?, 'sent', datetime('now'))`
    ).run(uuidv4(), envelopeId, staff.id, orgId, docNames);
  }

  return prepared.map((p) => ({
    master_id: p.master.id,
    envelope_id: envelopeId,
    external_envelope_id: externalEnvelopeId,
    status: 'sent',
    display_name: p.master.display_name || p.master.slug
  }));
}

/**
 * Send library form masters via native Nexus Core e-signature.
 * @returns {Promise<Array<{ master_id: string, envelope_id: string, external_envelope_id: string, status: string, display_name: string }>>}
 */
export async function sendLibraryMastersForSignature({
  orgId,
  workflow,
  formMasters,
  staff = null,
  participant = null,
  signatureMode = 'hybrid',
  orgName = null,
  adminFieldValuesByMasterId = {}
}) {
  if (!formMasters?.length) return [];
  assertNativeSignatureReady(orgId);

  const packets = computeLibrarySignaturePackets(formMasters, signatureMode);
  const signatureRequests = [];
  for (const packet of packets) {
    const results = await sendSignaturePacket(orgId, workflow, packet, { staff, participant, orgName, adminFieldValuesByMasterId });
    signatureRequests.push(...results);
  }
  return signatureRequests;
}

export { splitOnboardingMasters };
