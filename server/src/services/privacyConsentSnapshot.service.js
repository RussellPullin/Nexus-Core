import { db } from '../db/index.js';
import { getOrgRenderContext } from './orgContext.service.js';

function formatAusDate(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const s = iso.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return iso;
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

function splitDisplayName(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return { first_name: '', last_name: '' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

function getLatestOnboardingId(participantId) {
  const row = db
    .prepare(
      `SELECT id FROM participant_onboarding
       WHERE participant_id = ?
       ORDER BY datetime(updated_at) DESC LIMIT 1`
    )
    .get(participantId);
  return row?.id || null;
}

function getIntakeFields(participantOnboardingId) {
  if (!participantOnboardingId) return {};
  const rows = db
    .prepare(
      `SELECT field_key, field_value
       FROM participant_intake_fields
       WHERE participant_onboarding_id = ?`
    )
    .all(participantOnboardingId);
  return Object.fromEntries((rows || []).map((r) => [r.field_key, r.field_value]));
}

/**
 * Snapshot used for rendering + signing a Privacy Consent Form.
 *
 * `overrides.signer_type` ('participant' | 'guardian') is the one thing the sender decides
 * before generating/sending — it picks which of Section A (Client) / Section B (Guardian) is
 * printed and who the native signing request goes to. Everything else (liaison/withdrawal
 * checkboxes, the two free-text preference fields, the copy-request email) is filled
 * interactively by whoever signs, not pre-set here — see privacyConsentDocuSealFields.service.js.
 *
 * `coordinatorName`/`coordinatorSignatureDataUrl` populate the staff declaration block, stamped
 * directly onto the document at generation time using the sending admin's saved signature
 * (Settings), the same way the legacy fillConsentForm flow already does — no separate signing
 * turn needed for the org side.
 */
export function buildPrivacyConsentSnapshot({
  participantId,
  participantOnboardingId = null,
  overrides = {},
  coordinatorName = '',
  coordinatorSignatureDataUrl = null
}) {
  const participant = db.prepare('SELECT * FROM participants WHERE id = ?').get(participantId);
  if (!participant) throw new Error('Participant not found');

  const onboardingId = participantOnboardingId || getLatestOnboardingId(participantId);
  const intake = getIntakeFields(onboardingId);

  const nameParts = splitDisplayName(participant.name);
  const fullLegalName = String(intake.full_legal_name || participant.name || '').trim();
  const preferredName = String(intake.preferred_name || '').trim();

  const addressStreet = String(intake.street_address || '').trim();
  const addressCity = String(intake.suburb_city || intake.suburb || '').trim();
  const addressState = String(intake.state || '').trim();
  const addressPostcode = String(intake.postcode || '').trim();

  const guardianName = String(intake.primary_contact_name || intake.representative_name || '').trim();
  const guardianRel = String(intake.primary_contact_relationship || intake.representative_relationship || '').trim();
  const guardianPhone = String(intake.primary_contact_phone || participant.parent_guardian_phone || '').trim();
  const guardianEmail = String(intake.primary_contact_email || participant.parent_guardian_email || '').trim();

  const signerType = overrides?.signer_type === 'guardian' ? 'guardian' : 'participant';
  if (signerType === 'guardian' && !guardianEmail) {
    const err = new Error(
      'This participant has no guardian/representative email on file. Add one via the intake form before sending Section B to a guardian.'
    );
    err.code = 'GUARDIAN_EMAIL_MISSING';
    throw err;
  }

  const orgCtx = participant.provider_org_id ? getOrgRenderContext(participant.provider_org_id) : null;

  const snapshot = {
    kind: 'privacy_consent_form_v1',
    generated_at_iso: new Date().toISOString(),
    signer_type: signerType,
    org: orgCtx?.org
      ? {
          trading_name: orgCtx.org.tradingName,
          legal_name: orgCtx.org.legalName,
          abn: orgCtx.org.abn
        }
      : null,
    participant: {
      id: participant.id,
      full_legal_name: fullLegalName,
      preferred_name: preferredName,
      first_name: String(intake.first_name || nameParts.first_name || '').trim(),
      last_name: String(intake.last_name || nameParts.last_name || '').trim(),
      date_of_birth_display: formatAusDate(participant.date_of_birth || intake.date_of_birth),
      ndis_number: String(participant.ndis_number || intake.ndis_number || '').trim(),
      email: String(participant.email || intake.email || '').trim(),
      phone: String(participant.phone || intake.phone || '').trim(),
      address: {
        street_address: addressStreet,
        suburb_city: addressCity,
        state: addressState,
        postcode: addressPostcode
      }
    },
    primary_contact: {
      name: guardianName,
      relationship: guardianRel,
      phone: guardianPhone,
      email: guardianEmail
    },
    // Liaison/withdrawal checkboxes and the two free-text preference fields are filled
    // interactively by whoever signs (see privacyConsentDocuSealFields.service.js) — this
    // snapshot no longer pre-sets them, so the PDF always renders them blank/unchecked.
    staff: {
      name_print: String(coordinatorName || '').trim(),
      signature_data_url: coordinatorSignatureDataUrl || null
    }
  };

  return snapshot;
}

export function isPrivacyConsentSnapshot(snapshot) {
  return Boolean(snapshot && typeof snapshot === 'object' && snapshot.kind === 'privacy_consent_form_v1');
}

