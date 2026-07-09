/**
 * DocuSeal fields[] for Privacy Consent PDF.
 * Single signer (participant) with signature + printed name + date.
 */

const ROLE_PARTICIPANT = 'Participant';

function field(name, type, box, opts = {}) {
  return {
    name,
    type,
    role: ROLE_PARTICIPANT,
    required: opts.required === true,
    areas: [{ x: box.x, y: box.y, w: box.width, h: box.height, page: box.page || 1 }]
  };
}

export function buildPrivacyConsentDocuSealFields(snapshot) {
  const layout = snapshot?.signing_layout?.participant;
  if (!layout) {
    return { formFieldsPerDocument: [[]], signers: deriveSigner(snapshot) };
  }

  const fields = [];
  if (layout.signature) {
    fields.push(field('pc_client_signature', 'signature', layout.signature, { required: true }));
  }
  if (layout.printed_name) {
    fields.push(field('privacy_consent_client_name', 'text', layout.printed_name, { required: true }));
  }
  if (layout.date) {
    fields.push(field('pc_client_date', 'date', layout.date, { required: true }));
  }

  return { formFieldsPerDocument: [fields], signers: deriveSigner(snapshot) };
}

function deriveSigner(snapshot) {
  const participantName = snapshot?.participant?.full_legal_name || snapshot?.participant?.name || '';
  const participantEmail = snapshot?.participant?.email || '';
  return {
    participant: { order: 0, name: participantName, email: participantEmail, role: ROLE_PARTICIPANT }
  };
}
