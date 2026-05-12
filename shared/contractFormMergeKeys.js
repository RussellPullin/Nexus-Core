/**
 * Allowed merge-data keys for custom PDF/DOCX onboarding documents.
 * Keep aligned with server merge builders and contractTemplateAnalyze heuristics.
 */

import { PARTICIPANT_INTAKE_FIELD_DEFS, STAFF_ONBOARDING_FIELD_DEFS } from './onboardingFieldRegistry.js';

export const PARTICIPANT_CONTRACT_MERGE_KEYS = [
  'first_name',
  'last_name',
  'full_legal_name',
  'name',
  'ndis_number',
  'email',
  'phone',
  'address',
  'street_address',
  'suburb_city',
  'state',
  'postcode',
  'date_of_birth',
  'plan_start_date',
  'plan_end_date',
  'scheduled_review_date',
  'today',
  'date',
  'organisation_name',
  'abn',
  'organisation_address',
  'organisation_email',
  'organisation_phone',
  'organisation_contact_name'
];

export const STAFF_CONTRACT_MERGE_KEYS = [
  'staff_name',
  'employee_name',
  'name',
  'email',
  'phone',
  'address',
  'date_of_birth',
  'date_of_birth_iso',
  'role',
  'employment_type',
  'hourly_rate',
  'abn',
  'organisation_name',
  'employer_name',
  'today',
  'date',
  'emergency_contact_name',
  'emergency_contact_phone'
];

/** Curated + intake field keys for participant custom document mapping UI. */
export function participantContractMergeKeyOptions() {
  const s = new Set(PARTICIPANT_CONTRACT_MERGE_KEYS);
  for (const d of PARTICIPANT_INTAKE_FIELD_DEFS) {
    if (d.key) s.add(d.key);
  }
  return [...s].sort((a, b) => a.localeCompare(b));
}

/** Curated + intake field keys for staff custom document mapping UI. */
export function staffContractMergeKeyOptions() {
  const s = new Set(STAFF_CONTRACT_MERGE_KEYS);
  for (const d of STAFF_ONBOARDING_FIELD_DEFS) {
    if (d.key) s.add(d.key);
  }
  return [...s].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {string} key
 * @returns {boolean}
 */
export function isValidCustomMergeTargetKey(key) {
  const k = String(key || '').trim();
  return /^[a-z][a-z0-9_]*$/i.test(k) && k.length <= 80;
}
