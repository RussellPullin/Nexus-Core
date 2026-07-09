/**
 * Send branded library masters (signature_count > 0) via Dropbox Sign.
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import {
  hasConfiguredDropboxForOrg,
  sendMultiDocumentSignatureRequest
} from './dropboxSign.service.js';
import {
  renderLibraryMasterAttachment,
  splitOnboardingMasters
} from './onboardingDocumentPacks.service.js';
import { suggestSigningLayoutFromPdf } from './formTemplateSigningLayout.service.js';
import {
  buildCustomFormDropboxFields,
  resolveOrgSignatoryForDropbox
} from './customFormDropboxFields.service.js';

const DROPBOX_SIGN_SETTINGS_HINT =
  'Connect Dropbox Sign under Settings → Integrations and enable it under Forms → Onboarding settings.';

export function isDropboxSignEnabledForOrg(orgId) {
  if (!orgId) return Boolean(process.env.DROPBOX_SIGN_API_KEY?.trim());
  const row = db.prepare(`SELECT config_json FROM provider_profiles WHERE organisation_id = ?`).get(orgId);
  let config = {};
  try {
    config = row?.config_json ? JSON.parse(row.config_json) : {};
  } catch {
    config = {};
  }
  if (config.dropbox_sign_enabled === true) return true;
  if (config.dropbox_sign_enabled === false) return false;
  return Boolean(process.env.DROPBOX_SIGN_API_KEY?.trim());
}

export function assertDropboxSignReady(orgId) {
  if (!hasConfiguredDropboxForOrg(orgId)) {
    const err = new Error(`Dropbox Sign is not connected. ${DROPBOX_SIGN_SETTINGS_HINT}`);
    err.code = 'DROPBOX_SIGN_NOT_CONNECTED';
    throw err;
  }
  if (!isDropboxSignEnabledForOrg(orgId)) {
    const err = new Error(`Dropbox Sign is not enabled for this organisation. ${DROPBOX_SIGN_SETTINGS_HINT}`);
    err.code = 'DROPBOX_SIGN_NOT_ENABLED';
    throw err;
  }
}

export function getProviderSignatureMode(orgId) {
  const row = db.prepare(`SELECT signature_mode FROM provider_profiles WHERE organisation_id = ?`).get(orgId);
  return row?.signature_mode || 'hybrid';
}

/**
 * Group library form masters into Dropbox Sign packets (hybrid / packet / separate).
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

function resolvePrimaryRecipient({ workflow, staff, participant }) {
  if (workflow === 'staff_onboarding') {
    return {
      name: staff?.name || 'Staff member',
      email: (staff?.email || '').trim(),
      role: 'worker'
    };
  }
  const guardianEmail = (participant?.guardian_email || participant?.parent_guardian_email || '').trim();
  const guardianName = participant?.guardian_name || participant?.parent_guardian_name || '';
  if (guardianEmail) {
    return { name: guardianName || 'Guardian', email: guardianEmail, role: 'guardian' };
  }
  return {
    name: participant?.name || 'Participant',
    email: (participant?.email || '').trim(),
    role: 'participant'
  };
}

async function prepareMasterDocument(master, orgId, workflow, { staff, participant }) {
  const att = await renderLibraryMasterAttachment(master, orgId, { staff, participant });
  if (!att?.content || att.contentType !== 'application/pdf') {
    throw new Error(`Could not render ${master.display_name || master.slug} as PDF for signature.`);
  }
  const layout = await resolveSigningLayout(master, att.content, workflow);
  const orgSignatory = resolveOrgSignatoryForDropbox(orgId);
  const dropboxFields = buildCustomFormDropboxFields(layout, {
    workflow,
    org: orgSignatory,
    participant: participant || {},
    staff: staff || {}
  });
  return {
    master,
    buffer: att.content,
    filename: att.filename,
    formFields: dropboxFields.formFieldsPerDocument?.[0] || [],
    signers: dropboxFields.signers
  };
}

async function sendSignaturePacket(orgId, workflow, packetMasters, { staff, participant, orgName }) {
  const recipient = resolvePrimaryRecipient({ workflow, staff, participant });
  const prepared = [];
  for (const master of packetMasters) {
    prepared.push(await prepareMasterDocument(master, orgId, workflow, { staff, participant }));
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

  const externalEnvelopeId = await sendMultiDocumentSignatureRequest(orgId, {
    signers,
    title,
    subject: `Please sign: ${docNames}`,
    message: `Please review and sign the required onboarding form${prepared.length === 1 ? '' : 's'} from ${orgName || 'your organisation'}.`,
    documents: prepared.map((p) => ({
      buffer: p.buffer,
      filename: p.filename,
      formFields: p.formFields
    }))
  });

  return prepared.map((p) => ({
    master_id: p.master.id,
    envelope_id: envelopeId,
    external_envelope_id: externalEnvelopeId,
    status: 'sent',
    display_name: p.master.display_name || p.master.slug
  }));
}

/**
 * Send library form masters via Dropbox Sign.
 * @returns {Promise<Array<{ master_id: string, envelope_id: string, external_envelope_id: string, status: string, display_name: string }>>}
 */
export async function sendLibraryMastersForSignature({
  orgId,
  workflow,
  formMasters,
  staff = null,
  participant = null,
  signatureMode = 'hybrid',
  orgName = null
}) {
  if (!formMasters?.length) return [];
  assertDropboxSignReady(orgId);

  const packets = computeLibrarySignaturePackets(formMasters, signatureMode);
  const signatureRequests = [];
  for (const packet of packets) {
    const results = await sendSignaturePacket(orgId, workflow, packet, { staff, participant, orgName });
    signatureRequests.push(...results);
  }
  return signatureRequests;
}

export { splitOnboardingMasters };
