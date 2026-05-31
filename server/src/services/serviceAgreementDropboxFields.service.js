/**
 * Dropbox Sign form_fields_per_document + signers for Nexus Service Agreements.
 *
 * Two-signer sequential flow:
 *   Signer 0 = ORG ADMIN (default signatory) — reviews "Confirm participant details" and signs Provider box.
 *   Signer 1 = PARTICIPANT — receives the request after admin signs, signs Client box.
 *
 * Returns:
 *   formFieldsPerDocument : object[][]   - Dropbox payload of all interactive fields, with per-field `signer` index.
 *   customFields         : object[]      - unused (kept for API parity).
 *   signers              : { org, participant } - default signer info derived from snapshot (caller can override).
 */

const SIGNER_ORG = 0;
const SIGNER_PARTICIPANT = 1;

// Dropbox Sign limit (see API error `bad_request: This value cannot be longer than 40 characters`).
const PLACEHOLDER_MAX = 40;

// Dropbox Sign's `form_fields_per_document` is anchored to a fixed 612 x 792 (US Letter)
// canvas in 72 DPI, regardless of the source PDF's actual page size. Our service-agreement
// PDF is rendered at A4 (595 x 842), so we need to scale coordinates from A4 PDF points
// into Dropbox's Letter canvas points or the overlays drift down/right of the drawn marks.
// Source: Dropbox Sign API "form_fields_per_document" reference; symptoms also match
// observed alignment (~38 pt vertical drift at the signature box).
const A4_W = 595;
const A4_H = 842;
const LETTER_W = 612;
const LETTER_H = 792;
const X_SCALE = LETTER_W / A4_W; // ≈ 1.0286
const Y_SCALE = LETTER_H / A4_H; // ≈ 0.9406

function clip(s, max) {
  const str = String(s || '');
  return str.length <= max ? str : `${str.slice(0, Math.max(0, max - 1))}…`;
}

function field(apiId, type, box, opts = {}) {
  return {
    api_id: apiId,
    type,
    x: Math.round(box.x * X_SCALE),
    y: Math.round(box.y * Y_SCALE),
    width: Math.round(box.width * X_SCALE),
    height: Math.round(box.height * Y_SCALE),
    page: box.page,
    required: opts.required === true,
    signer: opts.signer ?? 0,
    name: opts.name || '',
    placeholder: clip(opts.placeholder, PLACEHOLDER_MAX)
  };
}

export function buildServiceAgreementDropboxFields(snapshot) {
  const layout = snapshot?.signing_layout;
  if (!layout) {
    return {
      formFieldsPerDocument: [[]],
      customFields: [],
      signers: deriveSigners(snapshot)
    };
  }

  const fields = [];

  for (const box of layout.confirm_fields || []) {
    if (!box || box.x == null || box.y == null) continue;
    fields.push(
      field(
        box.api_id || box.field_name,
        'text',
        { x: box.x, y: box.y, width: box.width, height: box.height, page: box.page },
        {
          name: box.field_name,
          placeholder: box.placeholder || box.label || '',
          required: false,
          signer: SIGNER_ORG
        }
      )
    );
  }

  const provider = layout.provider || {};
  if (provider.signature) {
    fields.push(field('provider_signature', 'signature', provider.signature, { required: true, signer: SIGNER_ORG }));
  }
  if (provider.printed_name) {
    fields.push(
      field('provider_printed_name', 'text', provider.printed_name, {
        name: 'sa_provider_name',
        required: true,
        placeholder: 'Org admin name',
        signer: SIGNER_ORG
      })
    );
  }
  if (provider.date) {
    fields.push(field('provider_date', 'date_signed', provider.date, { required: true, signer: SIGNER_ORG }));
  }

  const client = layout.client || {};
  if (client.signature) {
    fields.push(field('client_signature', 'signature', client.signature, { required: true, signer: SIGNER_PARTICIPANT }));
  }
  if (client.printed_name) {
    fields.push(
      field('client_printed_name', 'text', client.printed_name, {
        name: 'sa_participant_name',
        required: true,
        placeholder: 'Type your full name',
        signer: SIGNER_PARTICIPANT
      })
    );
  }
  if (client.date) {
    fields.push(field('client_date', 'date_signed', client.date, { required: true, signer: SIGNER_PARTICIPANT }));
  }

  return {
    formFieldsPerDocument: [fields],
    customFields: [],
    signers: deriveSigners(snapshot)
  };
}

function deriveSigners(snapshot) {
  const orgName =
    snapshot?.signatory?.name ||
    snapshot?.org?.contact_person ||
    snapshot?.org?.trading_name ||
    snapshot?.org?.legal_name ||
    '';
  const orgEmail = snapshot?.signatory?.email || snapshot?.org?.email || '';
  const orgRole = snapshot?.signatory?.role || 'Organisation admin';

  const participantName = snapshot?.participant?.name || '';
  const participantEmail = snapshot?.participant?.email || '';

  return {
    org: { order: SIGNER_ORG, name: orgName, email: orgEmail, role: orgRole },
    participant: { order: SIGNER_PARTICIPANT, name: participantName, email: participantEmail, role: 'Participant' }
  };
}

export function isServiceAgreementSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  return Boolean(
    snapshot.signing_layout ||
      snapshot.template_key === 'service_agreement_standard_v3' ||
      snapshot.org_template_id
  );
}
