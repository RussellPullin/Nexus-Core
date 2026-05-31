/**
 * Dropbox Sign form_fields_per_document for Privacy Consent PDF.
 * Single signer (participant) with signature + printed name + date.
 */

const SIGNER_PARTICIPANT = 0;
const PLACEHOLDER_MAX = 40;

function clip(s, max) {
  const str = String(s || '');
  return str.length <= max ? str : `${str.slice(0, Math.max(0, max - 1))}…`;
}

function field(apiId, type, box, opts = {}) {
  return {
    api_id: apiId,
    type,
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
    page: box.page,
    required: opts.required === true,
    signer: opts.signer ?? SIGNER_PARTICIPANT,
    name: opts.name || '',
    placeholder: clip(opts.placeholder, PLACEHOLDER_MAX)
  };
}

export function buildPrivacyConsentDropboxFields(snapshot) {
  const layout = snapshot?.signing_layout?.participant;
  if (!layout) {
    return { formFieldsPerDocument: [[]], customFields: [], signers: deriveSigner(snapshot) };
  }

  const fields = [];
  if (layout.signature) {
    fields.push(field('pc_client_signature', 'signature', layout.signature, { required: true, signer: SIGNER_PARTICIPANT }));
  }
  if (layout.printed_name) {
    fields.push(
      field('pc_client_printed_name', 'text', layout.printed_name, {
        required: true,
        signer: SIGNER_PARTICIPANT,
        name: 'privacy_consent_client_name',
        placeholder: 'Type your full name'
      })
    );
  }
  if (layout.date) {
    fields.push(field('pc_client_date', 'date_signed', layout.date, { required: true, signer: SIGNER_PARTICIPANT }));
  }

  return { formFieldsPerDocument: [fields], customFields: [], signers: deriveSigner(snapshot) };
}

function deriveSigner(snapshot) {
  const participantName = snapshot?.participant?.full_legal_name || snapshot?.participant?.name || '';
  const participantEmail = snapshot?.participant?.email || '';
  return {
    participant: { order: SIGNER_PARTICIPANT, name: participantName, email: participantEmail, role: 'Participant' }
  };
}

