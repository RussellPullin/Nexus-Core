/**
 * Use or send one library document for a chosen participant, from the forms library.
 * Signature forms go out through e-signature. Policies and other documents are emailed as PDFs.
 * This is not limited to the onboarding pack, so policy-library documents can be sent too.
 */

import { db } from '../db/index.js';
import { renderLibraryMasterAttachment } from './onboardingDocumentPacks.service.js';
import {
  getProviderSignatureMode,
  sendLibraryMastersForSignature
} from './libraryDocumentSignature.service.js';
import { resolveOrgSignatoryForDocuSeal } from './customFormDocuSealFields.service.js';
import { isEmailConfiguredForUser, sendEmailViaRelay } from './notification.service.js';

/**
 * @param {{ signature_count?: number, category?: string|null, manifest?: object }} doc
 * @returns {'use_signature'|'use_form'|'send'}
 */
export function libraryDocumentAction(doc) {
  const signatureCount = Number(doc?.signature_count ?? doc?.manifest?.signature_count) || 0;
  const category = doc?.category || doc?.manifest?.category || '';
  if (signatureCount > 0) return 'use_signature';
  if (category === 'form') return 'use_form';
  return 'send';
}

/** Typed-name values for the organisation sign-off block, taken from business settings. */
function orgSignatoryPrefill(orgId) {
  const signatory = resolveOrgSignatoryForDocuSeal(orgId);
  const name = signatory.name || '';
  if (!name) return {};
  const today = new Date().toLocaleDateString('en-AU');
  const values = {};
  for (const key of [
    'org_signature', 'org_printed_name', 'org_name',
    'p_sig', 'p_name', 'p_print', 'p_role',
    's_sig', 's_name', 'iss_sig', 'iss_name', 'iss_position'
  ]) {
    values[key] = name;
  }
  for (const key of ['org_date', 'p_date', 's_date', 'iss_date']) {
    values[key] = today;
  }
  return values;
}

export function loadActiveLibraryMaster(masterId) {
  const row = db
    .prepare('SELECT id, slug, display_name, category, manifest_json FROM document_library_masters WHERE id = ? AND is_active = 1')
    .get(masterId);
  if (!row) return null;
  let manifest = {};
  try {
    manifest = row.manifest_json ? JSON.parse(row.manifest_json) : {};
  } catch {
    manifest = {};
  }
  return {
    id: row.id,
    slug: row.slug,
    display_name: row.display_name,
    category: row.category || manifest.category || null,
    manifest
  };
}

export async function sendLibraryDocumentToParticipant({ orgId, userId, master, participant, orgName }) {
  if (!master?.id) throw new Error('Document not found');
  if (!participant?.id) throw new Error('Choose a participant.');
  const email = String(participant.email || '').trim();
  if (!email) {
    const err = new Error('This participant has no email address.');
    err.code = 'SIGNER_EMAIL_MISSING';
    throw err;
  }

  const action = libraryDocumentAction(master);
  const label = master.display_name || 'Document';
  const senderName = orgName || 'Nexus Core';

  if (action === 'use_signature') {
    const sent = await sendLibraryMastersForSignature({
      orgId,
      workflow: 'participant_onboarding',
      formMasters: [master],
      participant,
      signatureMode: getProviderSignatureMode(orgId),
      orgName: senderName,
      adminFieldValuesByMasterId: { [master.id]: orgSignatoryPrefill(orgId) },
      notify: true
    });
    return {
      action,
      display_name: label,
      signature_request_count: sent.signatureRequests?.length || 0,
      attachment_count: 0
    };
  }

  if (!isEmailConfiguredForUser(userId)) {
    const err = new Error('Connect your email in Settings to send messages.');
    err.code = 'EMAIL_NOT_CONNECTED';
    throw err;
  }

  const attachment = await renderLibraryMasterAttachment(master, orgId, { participant });
  if (!attachment?.content) throw new Error(`Could not prepare "${label}" to send.`);

  const who = participant.name || 'there';
  const isPolicy = (master.category || '') === 'policy';
  const subject = `${senderName}: ${label}`;
  const text = isPolicy
    ? `Hi ${who},\n\nPlease find attached ${label} from ${senderName}. Keep it for your records.\n\nIf you have questions, reply to this email.\n`
    : `Hi ${who},\n\nPlease find attached ${label}, prepared for you by ${senderName}.\n\nIf you have questions, reply to this email.\n`;

  await sendEmailViaRelay(
    userId,
    email,
    subject,
    text,
    null,
    [{
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: Buffer.isBuffer(attachment.content) ? attachment.content.toString('base64') : attachment.content
    }],
    senderName
  );

  return {
    action,
    display_name: label,
    signature_request_count: 0,
    attachment_count: 1
  };
}
