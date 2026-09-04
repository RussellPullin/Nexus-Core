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
  { key: 'staff.address', type: 'string' },
  { key: 'staff.supervisor_name', type: 'string' },
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

/**
 * Flat AcroForm field names used by the tokenised NDIS PDF masters, mapped to registry keys.
 * Import adds widgets named PROVIDER_SHORT / ABN / c_name / a_sig etc. over de-identified chips.
 */
export const ACROFORM_TOKEN_ALIASES = Object.freeze({
  PROVIDER_NAME: 'org.legal_name',
  PROVIDER_SHORT: 'org.name',
  ABN: 'org.abn',
  NDIS_REG_NO: 'org.ndis_provider_number',
  PHONE: 'org.phone',
  EMAIL: 'org.email',
  COMPLAINTS_EMAIL: 'org.email',
  WEBSITE: 'org.website',
  STREET_ADDRESS: 'org.street_address',
  POSTAL_ADDRESS: 'org.postal_address',
  GOVERNING_BODY: 'org.legal_name',
  KMP: 'org.signatory.name',
  PRINCIPAL: 'org.signatory.name',
  DOC_OWNER: 'org.signatory.role',
  APPROVED_BY: 'org.signatory.name',
  EFFECTIVE_DATE: 'today_long',
  REVIEW_DATE: 'today_long',
  provider: 'org.name',
  trading: 'org.trading_name',
  legal: 'org.legal_name',
  abn: 'org.abn',
  company: 'org.legal_name',
  org_logo: 'org.branding.logo_path',
  LOGO: 'org.branding.logo_path',
  logo: 'org.branding.logo_path',
  c_name: 'participant.full_name',
  c_first: 'participant.first_name',
  c_last: 'participant.last_name',
  c_dob: 'participant.date_of_birth',
  c_phone: 'participant.phone',
  c_email: 'participant.email',
  c_address: 'participant.address',
  c_ndis: 'participant.ndis_number',
  ndis: 'participant.ndis_number',
  worker_name: 'staff.full_name',
  first_name: 'staff.full_name',
  surname: 'staff.full_name'
});

/**
 * True when an AcroForm field is a signature box (native signing must leave these empty).
 * Masters name these `a_sig`, `p_sig`, `sig_prov_sig`, not "signature".
 */
export function isSignatureAcroFieldName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  if (/(^|_)sig($|_)/.test(n)) return true;
  if (/signature/.test(n)) return true;
  return false;
}

/**
 * Expand dotted render tokens into the flat AcroForm names the tokenised PDFs use.
 * @param {Record<string, string>} tokens
 * @returns {Record<string, string>}
 */
export function buildAcroFormFillMap(tokens = {}) {
  const out = { ...tokens };
  for (const [fieldName, registryKey] of Object.entries(ACROFORM_TOKEN_ALIASES)) {
    const value = tokens[registryKey];
    if (value != null && value !== '' && (out[fieldName] == null || out[fieldName] === '')) {
      out[fieldName] = value;
    }
  }
  return out;
}

/**
 * True when an AcroForm field is a provider / document-control slot the CRM fills
 * from the organisation's business details (name, ABN, logo, effective/review
 * dates, …). These are pre-filled before a document is sent for signature and
 * must never be surfaced as signer-fillable fields.
 * @param {string} fieldName
 */
export function isProviderAutofillAcroFieldName(fieldName) {
  const base = String(fieldName || '').replace(/_\d+$/, '');
  const key = ACROFORM_TOKEN_ALIASES[fieldName] || ACROFORM_TOKEN_ALIASES[base];
  if (!key) return false;
  return key.startsWith('org.') || key === 'today' || key === 'today_long';
}

/**
 * Resolve a PDF field name against a fill map, including PROVIDER_SHORT_2 style suffixes.
 * @param {string} fieldName
 * @param {Record<string, string>} fillMap
 * @returns {string|null}
 */
export function lookupAcroFormValue(fieldName, fillMap) {
  if (!fieldName || !fillMap) return null;
  const direct = fillMap[fieldName];
  if (direct != null && direct !== '') return String(direct);
  const base = String(fieldName).replace(/_\d+$/, '');
  if (base !== fieldName) {
    const aliased = fillMap[base];
    if (aliased != null && aliased !== '') return String(aliased);
  }
  const registryKey = ACROFORM_TOKEN_ALIASES[fieldName] || ACROFORM_TOKEN_ALIASES[base];
  if (registryKey && fillMap[registryKey] != null && fillMap[registryKey] !== '') {
    return String(fillMap[registryKey]);
  }
  return null;
}
