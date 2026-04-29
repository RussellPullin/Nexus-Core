/**
 * Variable merge, template interpolation, and org profile resolution for Nexus form templates.
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

export function mergeVariableValues(variableSchemaJson, orgVariableValuesJson) {
  const schema = parseJson(variableSchemaJson, {});
  const defaults = { ...VARIABLE_DEFAULTS, ...(schema.defaults || {}) };
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

  const trading = String(biz.company_name || '').trim() || String(org.name || '').trim();
  const legal = String(org.name || '').trim() || trading;

  out.org_legal_name = legal;
  out.org_trading_name = trading;
  out.org_abn = String(biz.company_abn || org.abn || '').trim();
  out.org_address = String(biz.company_address || org.address || '').trim();
  out.org_email = String(biz.company_email || org.email || '').trim();
  out.org_phone = String(biz.company_phone || org.phone || '').trim();
  out.org_contact_person = String(contactPersonName || '').trim();

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
