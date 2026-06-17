/**
 * Variable merge, template interpolation, and org profile resolution for structured form templates.
 */
import { VARIABLE_DEFAULTS } from '../data/serviceAgreementSpring2V3/variableSchema.js';

export function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Baseline defaults from code always win over stored `schema.defaults` (avoids stale seeded names in older DB rows). */
export function baselineVariableDefaults(variableSchemaJson) {
  const schema = parseJson(variableSchemaJson, {});
  const merged = { ...VARIABLE_DEFAULTS, ...(schema.defaults || {}) };
  const out = { ...merged };
  for (const key of Object.keys(VARIABLE_DEFAULTS)) {
    out[key] = VARIABLE_DEFAULTS[key];
  }
  return out;
}

export function mergeVariableValues(variableSchemaJson, orgVariableValuesJson) {
  const defaults = baselineVariableDefaults(variableSchemaJson);
  const orgVals = parseJson(orgVariableValuesJson, {}) || {};
  return { ...defaults, ...orgVals };
}

/**
 * Fill complaints/contact-related variables from organisation + business settings when blank.
 */
export function enrichVariablesFromOrgProfile(variableMap, organisationRow, businessSettingsRow, contactPersonName) {
  const out = { ...variableMap };
  const org = organisationRow || {};
  const biz = businessSettingsRow || {};

  // Phase 1: prefer the canonical organisations.* fields populated by the org setup wizard,
  // then business_settings.company_name (the name the org actually trades under),
  // then fall back to organisations.name as last resort.
  // NOTE: business_settings.company_name is preferred over org.name because the primary
  // org row uses a generic placeholder name ("Primary organisation") while business_settings
  // always holds the real trading name (e.g. "Spring 2 Health").
  const trading = String(org.trading_name || biz.company_name || org.name || '').trim();
  const legal = String(org.legal_name || biz.company_name || org.name || '').trim() || trading;

  // Always override from live DB — don't let stale template variable values override
  // the organisation's actual name (e.g. a previously saved "Pristine Lifestyle Solutions"
  // should be replaced when the business has since set "Spring 2 Health" in settings).
  out.org_legal_name = legal || String(out.org_legal_name || '').trim();
  out.org_trading_name = trading || String(out.org_trading_name || '').trim();
  if (!String(out.org_abn || '').trim()) out.org_abn = String(org.abn || biz.company_abn || '').trim();
  if (!String(out.org_acn || '').trim()) out.org_acn = String(org.acn || '').trim();
  if (!String(out.org_ndis_provider_number || '').trim())
    out.org_ndis_provider_number = String(org.ndis_reg_number || '').trim();
  if (!String(out.org_address || '').trim())
    out.org_address = String(org.address || org.street_address || biz.company_address || '').trim();
  if (!String(out.org_postal_address || '').trim())
    out.org_postal_address = String(org.postal_address || org.address || '').trim();
  if (!String(out.org_email || '').trim()) out.org_email = String(org.email || biz.company_email || '').trim();
  if (!String(out.org_phone || '').trim()) out.org_phone = String(org.phone || biz.company_phone || '').trim();
  if (!String(out.org_website || '').trim()) out.org_website = String(org.website || '').trim();
  if (!String(out.org_contact_person || '').trim())
    out.org_contact_person = String(org.primary_contact_name || contactPersonName || '').trim();
  if (!String(out.org_signatory_name || '').trim())
    out.org_signatory_name = String(org.default_signatory_name || org.primary_contact_name || '').trim();
  if (!String(out.org_signatory_role || '').trim())
    out.org_signatory_role = String(org.default_signatory_role || org.primary_contact_role || '').trim();
  if (!String(out.org_bank_name || '').trim()) out.org_bank_name = String(org.bank_name || '').trim();
  if (!String(out.org_bsb || '').trim()) out.org_bsb = String(org.bsb || '').trim();
  if (!String(out.org_account_name || '').trim()) out.org_account_name = String(org.account_name || '').trim();
  if (!String(out.org_account_number || '').trim()) out.org_account_number = String(org.account_number || '').trim();

  if (!String(out.complaints_email || '').trim()) {
    out.complaints_email = out.org_email;
  }
  if (!String(out.complaints_postal_address || '').trim()) {
    out.complaints_postal_address = out.org_address;
  }
  if (!String(out.complaints_phone || '').trim()) {
    out.complaints_phone = out.org_phone;
  }

  return out;
}

export function interpolateTemplate(str, map) {
  if (!str) return '';
  return String(str).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = map[key];
    if (v === undefined || v === null) return '';
    return String(v);
  });
}

export function defaultBrandingPayload() {
  return {
    primary_color: '#1e3a5f',
    accent_color: '#0f766e',
    body_font: 'Helvetica',
    logo_relative_path: null
  };
}

export function mergeBranding(brandingJson) {
  const parsed = parseJson(brandingJson, {}) || {};
  return { ...defaultBrandingPayload(), ...parsed };
}
