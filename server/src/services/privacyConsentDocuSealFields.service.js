/**
 * Signing fields[] for Privacy Consent PDF.
 * Single signer — the participant, or their guardian/representative when
 * `snapshot.signer_type === 'guardian'` (chosen by the sender before generating the document,
 * see privacyConsentSnapshot.service.js). Every checkbox/text/signature/date field is built
 * from `snapshot.signing_layout.fields`, which privacyConsentPdf.service.js populates as it
 * draws each one, so positions always match the actual rendered PDF.
 * Consumed by nativeSignature.service.js (legacy filename kept for stable imports).
 */

const ROLE_PARTICIPANT = 'Participant';

function field(entry) {
  return {
    name: entry.key,
    type: entry.type,
    role: ROLE_PARTICIPANT,
    required: entry.required === true,
    areas: [{ x: entry.x, y: entry.y, w: entry.width, h: entry.height, page: entry.page || 1 }]
  };
}

export function buildPrivacyConsentDocuSealFields(snapshot) {
  const entries = Array.isArray(snapshot?.signing_layout?.fields) ? snapshot.signing_layout.fields : [];
  const fields = entries.map(field);
  return { formFieldsPerDocument: [fields], signers: deriveSigner(snapshot) };
}

function deriveSigner(snapshot) {
  const isGuardian = snapshot?.signer_type === 'guardian';
  const name = isGuardian
    ? snapshot?.primary_contact?.name || ''
    : snapshot?.participant?.full_legal_name || snapshot?.participant?.name || '';
  const email = isGuardian ? snapshot?.primary_contact?.email || '' : snapshot?.participant?.email || '';
  return {
    participant: { order: 0, name, email, role: ROLE_PARTICIPANT }
  };
}
