/**
 * DocuSeal fields[] for custom uploaded form templates (signing_layout).
 */

import { db } from '../db/index.js';

const ROLE_ORG = 'Organisation admin';

function docuSealTypeForLayoutField(f) {
  if (f.type === 'signature') return 'signature';
  if (f.type === 'date') return 'date';
  if (f.type === 'checkbox') return 'checkbox';
  return 'text';
}

/**
 * @param {import('./formTemplateSigningLayout.service.js').SigningLayout} signingLayout
 * @param {{ workflow?: string, org?: { name?: string, email?: string }, participant?: { name?: string, email?: string }, staff?: { name?: string, email?: string } }} [ctx]
 */
export function buildCustomFormDocuSealFields(signingLayout, ctx = {}) {
  const layout = signingLayout;
  if (!layout?.fields?.length) {
    return { formFieldsPerDocument: [[]], signers: null };
  }

  const wf = ctx.workflow === 'staff_onboarding' ? 'staff_onboarding' : 'participant_onboarding';
  const hasOrg = layout.fields.some((f) => f.signer === 'org');
  const primaryRole = wf === 'staff_onboarding' ? 'Staff' : 'Participant';

  function roleFor(f) {
    return f.signer === 'org' ? ROLE_ORG : primaryRole;
  }

  const fields = [];
  for (const f of layout.fields) {
    const dbType = docuSealTypeForLayoutField(f);
    // Text fields are pre-filled on the PDF and excluded, unless explicitly marked `fillable` —
    // those are real interactive text boxes the signer types into (e.g. a collection form).
    if (dbType === 'text' && !f.fillable) continue;

    fields.push({
      name: f.merge_key || f.api_id || f.id || dbType,
      type: dbType,
      role: roleFor(f),
      required: f.required === true || dbType === 'signature',
      label: f.label || null,
      fillable: dbType === 'text' && f.fillable === true,
      areas: [{ x: f.x, y: f.y, w: f.width, h: f.height, page: f.page || 1 }]
    });
  }

  let signers = null;
  if (hasOrg) {
    const org = ctx.org || {};
    const primary = wf === 'staff_onboarding' ? ctx.staff || {} : ctx.participant || {};
    signers = [
      {
        name: org.name || 'Organisation admin',
        email: org.email || '',
        order: 0,
        role: ROLE_ORG
      },
      {
        name: primary.name || (wf === 'staff_onboarding' ? 'Staff member' : 'Participant'),
        email: primary.email || '',
        order: 1,
        role: primaryRole
      }
    ];
  }

  return {
    formFieldsPerDocument: [fields],
    signers
  };
}

/**
 * Resolve default org signatory from organisation settings (same pattern as service agreement).
 */
export function resolveOrgSignatoryForDocuSeal(organisationId) {
  if (!organisationId) return { name: '', email: '' };
  const row = db.prepare(
    `SELECT o.name,
            COALESCE(o.default_signatory_name, '') AS default_signatory_name,
            COALESCE(o.default_signatory_email, '') AS default_signatory_email
     FROM organisations o WHERE o.id = ?`
  ).get(organisationId);
  if (!row) return { name: '', email: '' };
  return {
    name: String(row.default_signatory_name || row.name || '').trim(),
    email: String(row.default_signatory_email || '').trim()
  };
}
