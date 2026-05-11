/**
 * Allowed merge-data keys for custom PDF/DOCX onboarding documents.
 * Keep aligned with server merge builders and contractTemplateAnalyze heuristics.
 */

export const PARTICIPANT_CONTRACT_MERGE_KEYS = [
  'first_name',
  'last_name',
  'full_legal_name',
  'name',
  'ndis_number',
  'email',
  'phone',
  'address',
  'date_of_birth',
  'plan_start_date',
  'plan_end_date',
  'today',
  'date'
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
