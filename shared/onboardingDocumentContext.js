/**
 * Contextual filtering for onboarding document packs.
 * Pack = which pool; service type / staff role = which docs within the pool.
 */

export const PARTICIPANT_SERVICE_TYPES = [
  { value: 'sil', label: 'SIL (Supported Independent Living)' },
  { value: 'sda', label: 'SDA (Specialist Disability Accommodation)' },
  { value: 'support_coordination', label: 'Support Coordination' },
  { value: 'core_supports', label: 'Core supports' },
  { value: 'all', label: 'All / general' }
];

export const STAFF_ONBOARDING_ROLES = [
  { value: 'disability_support_worker', label: 'Disability Support Worker' },
  { value: 'support_coordinator', label: 'Support Coordinator' },
  { value: 'admin', label: 'Admin / office' },
  { value: 'all', label: 'All roles' }
];

export const VALID_PARTICIPANT_SERVICE_TYPES = new Set(
  PARTICIPANT_SERVICE_TYPES.map((o) => o.value)
);
export const VALID_STAFF_ONBOARDING_ROLES = new Set(
  STAFF_ONBOARDING_ROLES.map((o) => o.value)
);

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * @param {string[]|undefined|null} tags
 * @param {string|null|undefined} selected
 */
export function contextTagsMatchSelection(tags, selected) {
  if (!selected || selected === 'all') return true;
  const normalized = Array.isArray(tags) ? tags : [];
  if (normalized.length === 0 || normalized.includes('all')) return true;
  return normalized.includes(selected);
}

/**
 * @param {object} manifest
 * @param {{ participantServiceType?: string|null, staffRole?: string|null }} ctx
 */
export function manifestMatchesOnboardingContext(manifest, { participantServiceType = null, staffRole = null } = {}) {
  if (!manifest || typeof manifest !== 'object') return true;
  if (participantServiceType) {
    return contextTagsMatchSelection(manifest.participant_service_types, participantServiceType);
  }
  if (staffRole) {
    return contextTagsMatchSelection(manifest.staff_roles, staffRole);
  }
  return true;
}

/**
 * Infer default participant service type from NDIS category IDs on intake/participant.
 * @param {{ services_required?: string[]|string|null }} record
 */
export function inferParticipantServiceType(record = {}) {
  const services = parseJsonArray(record?.services_required);
  if (services.includes('07')) return 'support_coordination';
  if (services.includes('06')) return 'sda';
  if (services.includes('01')) return 'sil';
  if (services.length > 0) return 'core_supports';
  return 'all';
}

/**
 * Map free-text staff.role to onboarding role tag.
 * @param {{ role?: string|null, employment_type?: string|null }} staff
 */
export function inferStaffOnboardingRole(staff = {}) {
  const role = String(staff?.role || '').toLowerCase();
  if (/coordinator|coordination/.test(role)) return 'support_coordinator';
  if (/admin|manager|office|business|director/.test(role)) return 'admin';
  if (/support worker|disability|carer|worker|team leader/.test(role)) return 'disability_support_worker';
  return 'all';
}

export function participantServiceTypeLabel(value) {
  return PARTICIPANT_SERVICE_TYPES.find((o) => o.value === value)?.label || value || 'All';
}

export function staffOnboardingRoleLabel(value) {
  return STAFF_ONBOARDING_ROLES.find((o) => o.value === value)?.label || value || 'All';
}

/**
 * Format manifest tag arrays for display (Automation mapping, tooltips).
 * @param {string[]|undefined|null} tags
 * @param {'participant'|'staff'} kind
 */
export function formatContextTagsForDisplay(tags, kind) {
  const normalized = Array.isArray(tags) ? tags : [];
  if (normalized.length === 0 || normalized.includes('all')) {
    return kind === 'participant' ? 'All service types' : 'All roles';
  }
  const lookup = kind === 'participant' ? PARTICIPANT_SERVICE_TYPES : STAFF_ONBOARDING_ROLES;
  return normalized
    .map((t) => lookup.find((o) => o.value === t)?.label || t)
    .join(', ');
}
