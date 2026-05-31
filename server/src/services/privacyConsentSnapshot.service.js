import { db } from '../db/index.js';

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

function normalizeBool(v) {
  if (v === true || v === false) return v;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  return false;
}

/**
 * Snapshot used for rendering + signing a Privacy Consent Form.
 * Coordinator can toggle checkboxes via `overrides.checkboxes` before sending.
 */
export function buildPrivacyConsentSnapshot({ participantId, participantOnboardingId = null, overrides = {} }) {
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

  const checkboxes = overrides?.checkboxes && typeof overrides.checkboxes === 'object' ? overrides.checkboxes : {};
  const text = overrides?.text && typeof overrides.text === 'object' ? overrides.text : {};

  const liaison = {
    ndis_coordinator: normalizeBool(checkboxes.ndis_coordinator),
    occupational_therapist: normalizeBool(checkboxes.occupational_therapist),
    school_guidance_officer: normalizeBool(checkboxes.school_guidance_officer),
    general_practitioner: normalizeBool(checkboxes.general_practitioner),
    psychologist: normalizeBool(checkboxes.psychologist),
    psychiatrist: normalizeBool(checkboxes.psychiatrist),
    physiotherapist: normalizeBool(checkboxes.physiotherapist),
    other_1: normalizeBool(checkboxes.other_1),
    other_2: normalizeBool(checkboxes.other_2),
    other_3: normalizeBool(checkboxes.other_3)
  };

  const withdrawal = {
    ndis_audit_quality: normalizeBool(checkboxes.ndis_audit_quality),
    internal_training: normalizeBool(checkboxes.internal_training),
    marketing_communications: normalizeBool(checkboxes.marketing_communications),
    photos_website_social: normalizeBool(checkboxes.photos_website_social),
    audio_visual_recordings: normalizeBool(checkboxes.audio_visual_recordings)
  };

  const snapshot = {
    kind: 'privacy_consent_form_v1',
    generated_at_iso: new Date().toISOString(),
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
    consent: {
      liaison,
      liaison_other_details_1: String(text.liaison_other_details_1 || '').trim(),
      liaison_other_details_2: String(text.liaison_other_details_2 || '').trim(),
      liaison_other_details_3: String(text.liaison_other_details_3 || '').trim(),
      contact_by_email_sms: normalizeBool(checkboxes.contact_by_email_sms),
      not_provide_info_to_names: String(text.not_provide_info_to_names || '').trim(),
      disclose_to_additional_names: String(text.disclose_to_additional_names || '').trim(),
      withdrawal,
      wants_copy_and_policy: normalizeBool(checkboxes.wants_copy_and_policy),
      copy_delivery_details: String(text.copy_delivery_details || '').trim()
    },
    staff: {
      name_print: String(text.staff_name_print || '').trim()
    }
  };

  return snapshot;
}

export function isPrivacyConsentSnapshot(snapshot) {
  return Boolean(snapshot && typeof snapshot === 'object' && snapshot.kind === 'privacy_consent_form_v1');
}

