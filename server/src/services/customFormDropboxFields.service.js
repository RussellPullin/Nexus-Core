/**
 * Dropbox Sign form_fields_per_document for custom uploaded form templates (signing_layout).
 */

import { db } from '../db/index.js';

const PLACEHOLDER_MAX = 40;

const A4_W = 595;
const A4_H = 842;
const LETTER_W = 612;
const LETTER_H = 792;
const X_SCALE = LETTER_W / A4_W;
const Y_SCALE = LETTER_H / A4_H;

function clip(s, max) {
  const str = String(s || '');
  return str.length <= max ? str : `${str.slice(0, Math.max(0, max - 1))}…`;
}

function scaleBox(box, layout) {
  const pageW = layout?.page_width || A4_W;
  const pageH = layout?.page_height || A4_H;
  const sx = pageW === A4_W ? X_SCALE : LETTER_W / pageW;
  const sy = pageH === A4_H ? Y_SCALE : LETTER_H / pageH;
  return {
    x: Math.round(box.x * sx),
    y: Math.round(box.y * sy),
    width: Math.round(box.width * sx),
    height: Math.round(box.height * sy),
    page: box.page || 1
  };
}

function dropboxField(apiId, type, box, layout, opts = {}) {
  const scaled = scaleBox(box, layout);
  return {
    api_id: String(apiId || 'field').slice(0, 40),
    type,
    x: scaled.x,
    y: scaled.y,
    width: scaled.width,
    height: scaled.height,
    page: scaled.page,
    required: opts.required === true,
    signer: opts.signer ?? 0,
    name: opts.name || '',
    placeholder: clip(opts.placeholder, PLACEHOLDER_MAX)
  };
}

function dropboxTypeForLayoutField(f) {
  if (f.type === 'signature') return 'signature';
  if (f.type === 'date') return 'date_signed';
  if (f.type === 'checkbox') return 'checkbox';
  return 'text';
}

/**
 * @param {import('./formTemplateSigningLayout.service.js').SigningLayout} signingLayout
 * @param {{ workflow?: string, org?: { name?: string, email?: string }, participant?: { name?: string, email?: string }, staff?: { name?: string, email?: string } }} [ctx]
 */
export function buildCustomFormDropboxFields(signingLayout, ctx = {}) {
  const layout = signingLayout;
  if (!layout?.fields?.length) {
    return { formFieldsPerDocument: [[]], signers: null, customFields: [] };
  }

  const wf = ctx.workflow === 'staff_onboarding' ? 'staff_onboarding' : 'participant_onboarding';
  const hasOrg = layout.fields.some((f) => f.signer === 'org');
  const primarySigner = wf === 'staff_onboarding' ? 'staff' : 'participant';

  function signerIndex(f) {
    if (f.signer === 'org') return 0;
    if (hasOrg) return 1;
    return 0;
  }

  const fields = [];
  for (const f of layout.fields) {
    const dbType = dropboxTypeForLayoutField(f);
    // Text fields are pre-filled on the PDF; only interactive types go to Dropbox.
    if (dbType === 'text') continue;

    fields.push(
      dropboxField(
        f.api_id || f.id,
        dbType,
        { x: f.x, y: f.y, width: f.width, height: f.height, page: f.page },
        layout,
        {
          required: f.required === true || dbType === 'signature',
          signer: signerIndex(f),
          placeholder: f.label || f.merge_key || '',
          name: f.merge_key || f.api_id || ''
        }
      )
    );
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
        role: 'Organisation admin'
      },
      {
        name: primary.name || (wf === 'staff_onboarding' ? 'Staff member' : 'Participant'),
        email: primary.email || '',
        order: 1,
        role: wf === 'staff_onboarding' ? 'Staff' : 'Participant'
      }
    ];
  }

  return {
    formFieldsPerDocument: [fields],
    signers,
    customFields: []
  };
}

/**
 * Resolve default org signatory from organisation settings (same pattern as service agreement).
 */
export function resolveOrgSignatoryForDropbox(organisationId) {
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
