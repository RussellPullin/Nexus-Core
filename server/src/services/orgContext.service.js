/**
 * Phase 1: Universal org render context.
 *
 * Every document, register, contract, invoice or email rendered for an organisation should
 * pull its branding, legal identity, banking and signatory information from this one place.
 * The shape returned by `getOrgRenderContext` is the canonical contract for every renderer.
 *
 * The matching list of supported `{{org.*}}` / `{{org.branding.*}}` / `{{org.signatory.*}}` /
 * `{{org.bank.*}}` placeholders lives in `templateTokens.js`. Both files must stay in sync.
 */
import { db } from '../db/index.js';

const NOT_PROVIDED = ''; // Render-friendly default for missing string values.

/**
 * @param {string | null | undefined} orgId
 * @returns {{
 *   org: {
 *     id: string | null,
 *     name: string,
 *     legalName: string,
 *     tradingName: string,
 *     abn: string,
 *     acn: string,
 *     ndisProviderNumber: string,
 *     email: string,
 *     phone: string,
 *     website: string,
 *     address: string,
 *     postalAddress: string,
 *     streetAddress: string,
 *     primaryContact: { name: string, role: string, email: string, phone: string }
 *   },
 *   branding: {
 *     logoPath: string | null,
 *     primaryColor: string,
 *     accentColor: string,
 *     letterheadFooterText: string
 *   },
 *   signatory: { name: string, role: string, email: string },
 *   bank: { name: string, bsb: string, accountName: string, accountNumber: string, xeroShortCode: string }
 * }}
 */
export function getOrgRenderContext(orgId) {
  const empty = buildEmptyContext(orgId || null);
  if (!orgId) return empty;
  const row = db.prepare('SELECT * FROM organisations WHERE id = ?').get(orgId);
  if (!row) return empty;
  // business_settings holds the org's actual trading identity (set via Settings) and is the
  // source of truth over `organisations` — that row's own name/legal_name/logo often still hold
  // whatever placeholder was seeded during initial org setup (e.g. literally "Primary organisation",
  // or an old default logo) and are never updated afterwards. Every document/register/contract
  // rendered through this context must prefer business_settings so branding stays current when an
  // admin updates it in Settings. Mirrors the same precedence already used by the structured
  // form-template system (nexusFormTemplateRuntime.service.js: enrichVariablesFromOrgProfile).
  const biz = db.prepare('SELECT * FROM business_settings WHERE org_id = ?').get(orgId) || {};
  const tradingName = biz.company_name || row.trading_name || row.name || NOT_PROVIDED;
  const legalName = biz.company_name || row.legal_name || row.name || NOT_PROVIDED;
  return {
    org: {
      id: row.id,
      name: tradingName,
      legalName,
      tradingName,
      abn: biz.company_abn || row.abn || NOT_PROVIDED,
      acn: row.acn || NOT_PROVIDED,
      ndisProviderNumber: biz.ndis_provider_number || row.ndis_reg_number || NOT_PROVIDED,
      email: biz.company_email || row.email || NOT_PROVIDED,
      phone: biz.company_phone || row.phone || NOT_PROVIDED,
      website: row.website || NOT_PROVIDED,
      address: biz.company_address || row.address || row.street_address || row.postal_address || NOT_PROVIDED,
      postalAddress: row.postal_address || biz.company_address || row.address || NOT_PROVIDED,
      streetAddress: row.street_address || biz.company_address || row.address || NOT_PROVIDED,
      primaryContact: {
        name: row.primary_contact_name || NOT_PROVIDED,
        role: row.primary_contact_role || NOT_PROVIDED,
        email: row.primary_contact_email || row.email || NOT_PROVIDED,
        phone: row.primary_contact_phone || row.phone || NOT_PROVIDED
      }
    },
    branding: {
      logoPath: biz.logo_path || row.logo_path || null,
      primaryColor: row.brand_primary_color || '#1d4ed8',
      accentColor: row.brand_accent_color || '#0ea5e9',
      letterheadFooterText: row.letterhead_footer_text || NOT_PROVIDED
    },
    signatory: {
      name: row.default_signatory_name || row.primary_contact_name || NOT_PROVIDED,
      role: row.default_signatory_role || row.primary_contact_role || NOT_PROVIDED,
      email: row.default_signatory_email || row.primary_contact_email || row.email || NOT_PROVIDED
    },
    bank: {
      name: row.bank_name || NOT_PROVIDED,
      bsb: biz.bsb || row.bsb || NOT_PROVIDED,
      accountName: biz.account_name || row.account_name || NOT_PROVIDED,
      accountNumber: biz.account_number || row.account_number || NOT_PROVIDED,
      xeroShortCode: row.xero_short_code || NOT_PROVIDED
    }
  };
}

function buildEmptyContext(orgId) {
  return {
    org: {
      id: orgId,
      name: NOT_PROVIDED,
      legalName: NOT_PROVIDED,
      tradingName: NOT_PROVIDED,
      abn: NOT_PROVIDED,
      acn: NOT_PROVIDED,
      ndisProviderNumber: NOT_PROVIDED,
      email: NOT_PROVIDED,
      phone: NOT_PROVIDED,
      website: NOT_PROVIDED,
      address: NOT_PROVIDED,
      postalAddress: NOT_PROVIDED,
      streetAddress: NOT_PROVIDED,
      primaryContact: { name: '', role: '', email: '', phone: '' }
    },
    branding: { logoPath: null, primaryColor: '#1d4ed8', accentColor: '#0ea5e9', letterheadFooterText: '' },
    signatory: { name: '', role: '', email: '' },
    bank: { name: '', bsb: '', accountName: '', accountNumber: '', xeroShortCode: '' }
  };
}

/**
 * Flatten the render context into a docxtemplater-friendly flat key map.
 * Every key in `ORG_TOKEN_REGISTRY` resolves here. Use this in `setData` for docx renders.
 */
export function buildOrgTokenMap(orgId) {
  const ctx = getOrgRenderContext(orgId);
  return {
    'org.name': ctx.org.name,
    'org.legal_name': ctx.org.legalName,
    'org.trading_name': ctx.org.tradingName,
    'org.abn': ctx.org.abn,
    'org.acn': ctx.org.acn,
    'org.ndis_provider_number': ctx.org.ndisProviderNumber,
    'org.email': ctx.org.email,
    'org.phone': ctx.org.phone,
    'org.website': ctx.org.website,
    'org.address': ctx.org.address,
    'org.postal_address': ctx.org.postalAddress,
    'org.street_address': ctx.org.streetAddress,
    'org.primary_contact.name': ctx.org.primaryContact.name,
    'org.primary_contact.role': ctx.org.primaryContact.role,
    'org.primary_contact.email': ctx.org.primaryContact.email,
    'org.primary_contact.phone': ctx.org.primaryContact.phone,
    'org.branding.logo_path': ctx.branding.logoPath || '',
    'org.branding.primary_color': ctx.branding.primaryColor,
    'org.branding.accent_color': ctx.branding.accentColor,
    'org.branding.letterhead_footer_text': ctx.branding.letterheadFooterText,
    'org.signatory.name': ctx.signatory.name,
    'org.signatory.role': ctx.signatory.role,
    'org.signatory.email': ctx.signatory.email,
    'org.bank.name': ctx.bank.name,
    'org.bank.bsb': ctx.bank.bsb,
    'org.bank.account_name': ctx.bank.accountName,
    'org.bank.account_number': ctx.bank.accountNumber,
    'org.bank.xero_short_code': ctx.bank.xeroShortCode
  };
}
