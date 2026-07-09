/**
 * DocuSeal fields[] + submitters for Nexus Service Agreements.
 *
 * Two-signer sequential flow:
 *   Signer 0 = ORG ADMIN (default signatory) — reviews "Confirm participant details" and signs Provider box.
 *   Signer 1 = PARTICIPANT — receives the request after admin signs, signs Client box.
 *
 * Returns:
 *   formFieldsPerDocument : object[][]   - DocuSeal payload of all interactive fields (one array per document).
 *   signers               : { org, participant } - default signer info derived from snapshot (caller can override).
 *
 * Coordinates use top-left origin in the source PDF's native point space (same convention as the
 * signing_layout system) and are passed to DocuSeal unscaled — unlike Dropbox Sign, DocuSeal does not
 * force a fixed Letter canvas, so no A4→Letter rescale is needed here.
 */

const ROLE_ORG = 'Organisation admin';
const ROLE_PARTICIPANT = 'Participant';

function field(name, type, box, opts = {}) {
  return {
    name: name || type,
    type,
    role: opts.role || ROLE_PARTICIPANT,
    required: opts.required === true,
    areas: [{ x: box.x, y: box.y, w: box.width, h: box.height, page: box.page || 1 }]
  };
}

export function buildServiceAgreementDocuSealFields(snapshot) {
  const layout = snapshot?.signing_layout;
  if (!layout) {
    return { formFieldsPerDocument: [[]], signers: deriveSigners(snapshot) };
  }

  const fields = [];

  for (const box of layout.confirm_fields || []) {
    if (!box || box.x == null || box.y == null) continue;
    fields.push(
      field(box.field_name || box.api_id, 'text', box, {
        required: false,
        role: ROLE_ORG
      })
    );
  }

  const provider = layout.provider || {};
  if (provider.signature) {
    fields.push(field('provider_signature', 'signature', provider.signature, { required: true, role: ROLE_ORG }));
  }
  if (provider.printed_name) {
    fields.push(field('sa_provider_name', 'text', provider.printed_name, { required: true, role: ROLE_ORG }));
  }
  if (provider.date) {
    fields.push(field('provider_date', 'date', provider.date, { required: true, role: ROLE_ORG }));
  }

  const client = layout.client || {};
  if (client.signature) {
    fields.push(field('client_signature', 'signature', client.signature, { required: true, role: ROLE_PARTICIPANT }));
  }
  if (client.printed_name) {
    fields.push(field('sa_participant_name', 'text', client.printed_name, { required: true, role: ROLE_PARTICIPANT }));
  }
  if (client.date) {
    fields.push(field('client_date', 'date', client.date, { required: true, role: ROLE_PARTICIPANT }));
  }

  return {
    formFieldsPerDocument: [fields],
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

  const participantName = snapshot?.participant?.name || '';
  const participantEmail = snapshot?.participant?.email || '';

  // `role` must match the field-builder's ROLE_ORG/ROLE_PARTICIPANT exactly — DocuSeal
  // matches submitters to fields by this string, not by position.
  return {
    org: { order: 0, name: orgName, email: orgEmail, role: ROLE_ORG },
    participant: { order: 1, name: participantName, email: participantEmail, role: ROLE_PARTICIPANT }
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
