/**
 * Phase 1: Universal placeholder registry.
 *
 * Every supported `{{...}}` token a document author can use in a deidentified Word/PDF/structured
 * template MUST be declared here. The list keeps documentLibrary manifests honest — when a manifest
 * declares a placeholder, it's validated against this list at seed time.
 *
 * Group prefixes:
 *   org.*               — from orgContext.service.js
 *   org.branding.*      — branding sub-tree
 *   org.signatory.*     — default signing officer
 *   org.bank.*          — banking details for invoices
 *   org.primary_contact.* — primary org contact
 *   participant.*       — populated per generated form
 *   staff.*             — populated per staff record (contracts, compliance)
 *   today               — render date
 */

export const ORG_TOKEN_REGISTRY = Object.freeze([
  { key: 'org.name', type: 'string', description: 'Trading name (legacy organisations.name)' },
  { key: 'org.legal_name', type: 'string', description: 'Legal entity name as registered with ASIC' },
  { key: 'org.trading_name', type: 'string', description: 'Trading-as name if different from legal name' },
  { key: 'org.abn', type: 'string', description: 'Australian Business Number' },
  { key: 'org.acn', type: 'string', description: 'Australian Company Number' },
  { key: 'org.ndis_provider_number', type: 'string', description: 'NDIS Quality & Safeguards registration ID' },
  { key: 'org.email', type: 'string' },
  { key: 'org.phone', type: 'string' },
  { key: 'org.website', type: 'string' },
  { key: 'org.address', type: 'string', description: 'Generic address (back-compat)' },
  { key: 'org.postal_address', type: 'string' },
  { key: 'org.street_address', type: 'string' },
  { key: 'org.primary_contact.name', type: 'string' },
  { key: 'org.primary_contact.role', type: 'string' },
  { key: 'org.primary_contact.email', type: 'string' },
  { key: 'org.primary_contact.phone', type: 'string' },
  { key: 'org.branding.logo_path', type: 'image', description: 'Absolute path to logo image' },
  { key: 'org.branding.primary_color', type: 'string' },
  { key: 'org.branding.accent_color', type: 'string' },
  { key: 'org.branding.letterhead_footer_text', type: 'string' },
  { key: 'org.signatory.name', type: 'string' },
  { key: 'org.signatory.role', type: 'string' },
  { key: 'org.signatory.email', type: 'string' },
  { key: 'org.bank.name', type: 'string' },
  { key: 'org.bank.bsb', type: 'string' },
  { key: 'org.bank.account_name', type: 'string' },
  { key: 'org.bank.account_number', type: 'string' },
  { key: 'org.bank.xero_short_code', type: 'string' }
]);

export const PARTICIPANT_TOKEN_REGISTRY = Object.freeze([
  { key: 'participant.full_name', type: 'string' },
  { key: 'participant.first_name', type: 'string' },
  { key: 'participant.last_name', type: 'string' },
  { key: 'participant.date_of_birth', type: 'string' },
  { key: 'participant.ndis_number', type: 'string' },
  { key: 'participant.email', type: 'string' },
  { key: 'participant.phone', type: 'string' },
  { key: 'participant.address', type: 'string' },
  { key: 'participant.guardian_name', type: 'string' },
  { key: 'participant.guardian_email', type: 'string' },
  { key: 'participant.guardian_phone', type: 'string' },
  { key: 'participant.plan_start_date', type: 'string' },
  { key: 'participant.plan_end_date', type: 'string' }
]);

export const STAFF_TOKEN_REGISTRY = Object.freeze([
  { key: 'staff.full_name', type: 'string' },
  { key: 'staff.email', type: 'string' },
  { key: 'staff.phone', type: 'string' },
  { key: 'staff.role', type: 'string' },
  { key: 'staff.employment_type', type: 'string' },
  { key: 'staff.hourly_rate', type: 'string' },
  { key: 'staff.start_date', type: 'string' },
  { key: 'staff.abn', type: 'string' }
]);

export const GLOBAL_TOKEN_REGISTRY = Object.freeze([
  { key: 'today', type: 'string', description: 'Render date (YYYY-MM-DD)' },
  { key: 'today_long', type: 'string', description: 'Render date (long form e.g. 20 May 2026)' }
]);

const ALL_KEYS = new Set([
  ...ORG_TOKEN_REGISTRY,
  ...PARTICIPANT_TOKEN_REGISTRY,
  ...STAFF_TOKEN_REGISTRY,
  ...GLOBAL_TOKEN_REGISTRY
].map((t) => t.key));

/**
 * @param {string} key
 * @returns {boolean}
 */
export function isKnownToken(key) {
  return ALL_KEYS.has(String(key || '').trim());
}

/**
 * Return any placeholders in `placeholders` that aren't declared in the registries.
 * Used by the documentLibrary seed to warn authors about typos.
 *
 * @param {string[]} placeholders
 */
export function unknownPlaceholders(placeholders) {
  return (placeholders || []).filter((p) => !isKnownToken(p));
}

/**
 * Build the `today` / `today_long` token values.
 * @returns {{ today: string, today_long: string }}
 */
export function buildGlobalTokenMap() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const long = now.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  return {
    today: `${yyyy}-${mm}-${dd}`,
    today_long: long
  };
}
