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
  return {
    org: {
      id: row.id,
      name: row.name || NOT_PROVIDED,
      legalName: row.legal_name || row.name || NOT_PROVIDED,
      tradingName: row.trading_name || row.name || NOT_PROVIDED,
      abn: row.abn || NOT_PROVIDED,
      acn: row.acn || NOT_PROVIDED,
      ndisProviderNumber: row.ndis_reg_number || NOT_PROVIDED,
      email: row.email || NOT_PROVIDED,
      phone: row.phone || NOT_PROVIDED,
      website: row.website || NOT_PROVIDED,
      address: row.address || row.street_address || row.postal_address || NOT_PROVIDED,
      postalAddress: row.postal_address || row.address || NOT_PROVIDED,
      streetAddress: row.street_address || row.address || NOT_PROVIDED,
      primaryContact: {
        name: row.primary_contact_name || NOT_PROVIDED,
        role: row.primary_contact_role || NOT_PROVIDED,
        email: row.primary_contact_email || row.email || NOT_PROVIDED,
        phone: row.primary_contact_phone || row.phone || NOT_PROVIDED
      }
    },
    branding: {
      logoPath: row.logo_path || null,
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
      bsb: row.bsb || NOT_PROVIDED,
      accountName: row.account_name || NOT_PROVIDED,
      accountNumber: row.account_number || NOT_PROVIDED,
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
