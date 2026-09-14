/**
 * Canonical staff compliance document types and registration-readiness rules.
 * Shared by server and client — keep labels/keys in sync.
 */

export const STAFF_COMPLIANCE_DOCUMENT_TYPES = Object.freeze([
  'drivers_licence_front',
  'drivers_licence_back',
  'blue_card',
  'yellow_card',
  'first_aid',
  'car_insurance',
  'other'
]);

export const STAFF_COMPLIANCE_DOCUMENT_LABELS = Object.freeze({
  drivers_licence_front: "Driver's licence (front)",
  drivers_licence_back: "Driver's licence (back)",
  blue_card: 'Blue Card (Working With Children Check)',
  yellow_card: 'Yellow Card (Disability Worker Screening)',
  first_aid: 'First Aid Certificate',
  car_insurance: 'Car insurance certificate',
  other: 'Other certificate'
});

/** Short labels for emails / compact UI */
export const STAFF_COMPLIANCE_DOCUMENT_SHORT_LABELS = Object.freeze({
  drivers_licence_front: "Driver's licence (front)",
  drivers_licence_back: "Driver's licence (back)",
  blue_card: 'Blue Card',
  yellow_card: 'Yellow Card',
  first_aid: 'First Aid',
  car_insurance: 'Car insurance',
  other: 'Other certificate'
});

export const EMPLOYMENT_TYPE_INDEPENDENT = 'independent_support_worker';

export const EMPLOYMENT_TYPE_OPTIONS = Object.freeze([
  { value: 'employee', label: 'Employee' },
  { value: 'subcontractor', label: 'Subcontractor' },
  { value: EMPLOYMENT_TYPE_INDEPENDENT, label: 'Independent support worker' }
]);

/**
 * Documents required before an independent support worker is "registration ready".
 * Yellow Card + Blue Card are core screening; first aid and licence complete field readiness.
 */
export const INDEPENDENT_WORKER_REQUIRED_DOC_TYPES = Object.freeze([
  'yellow_card',
  'blue_card',
  'first_aid',
  'drivers_licence_front'
]);

export function isIndependentSupportWorker(employmentType) {
  const t = String(employmentType || '')
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, '_');
  return (
    t === EMPLOYMENT_TYPE_INDEPENDENT ||
    t === 'independent' ||
    t === 'independent_worker' ||
    t === 'sole_trader'
  );
}

export function employmentTypeLabel(employmentType) {
  if (isIndependentSupportWorker(employmentType)) return 'Independent support worker';
  if (employmentType === 'subcontractor') return 'Subcontractor';
  if (employmentType === 'employee') return 'Employee';
  return employmentType || '—';
}

export function documentTypeLabel(documentType, displayName) {
  const key = String(documentType || '').trim();
  if (key === 'other' && displayName) return String(displayName).trim();
  return (
    STAFF_COMPLIANCE_DOCUMENT_SHORT_LABELS[key] ||
    STAFF_COMPLIANCE_DOCUMENT_LABELS[key] ||
    (displayName ? String(displayName).trim() : key.replace(/_/g, ' '))
  );
}

/**
 * @param {string|null|undefined} expiryDate YYYY-MM-DD
 * @param {string} [todayYmd]
 * @returns {'valid'|'expiring_soon'|'expired'|'missing_expiry'}
 */
export function computeComplianceDocStatus(expiryDate, todayYmd) {
  if (!expiryDate) return 'missing_expiry';
  const today = todayYmd || new Date().toISOString().slice(0, 10);
  if (expiryDate < today) return 'expired';
  const soon = new Date(`${today}T12:00:00`);
  soon.setDate(soon.getDate() + 60);
  const soonYmd = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
  if (expiryDate <= soonYmd) return 'expiring_soon';
  return 'valid';
}
