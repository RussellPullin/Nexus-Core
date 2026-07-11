/**
 * Send an org-uploaded custom staff_onboarding form_templates row via the native e-signature
 * service, reusing the same signing_layout / DocuSeal-field-building / envelope machinery the
 * participant custom-template flow and the library-master staff flow already use.
 */

import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import { db } from '../db/index.js';
import { getCustomTemplatePath } from './formTemplatePath.service.js';
import {
  parseSigningLayout,
  suggestSigningLayoutForTemplateFile
} from './formTemplateSigningLayout.service.js';
import { fillCustomFormFromLayout } from './customFormFillFromLayout.service.js';
import {
  buildStaffContractMergeData,
  applyContractPlaceholderMap,
  fillStaffContractPdfBuffer
} from './staffContractFill.service.js';
import { getStaffIntakeFieldMap } from './staffOnboardingSync.service.js';
import {
  buildCustomFormDocuSealFields,
  resolveOrgSignatoryForDocuSeal
} from './customFormDocuSealFields.service.js';
import { assertNativeSignatureReady } from './libraryDocumentSignature.service.js';
import { sendMultiDocumentAgreement } from './nativeSignature.service.js';

function parseMappingJson(val) {
  if (!val) return {};
  try {
    return typeof val === 'object' ? val : JSON.parse(val);
  } catch {
    return {};
  }
}

/**
 * @param {{ orgId: string, providerProfileId: string, staff: object, templateId: string }} params
 * @returns {Promise<{ envelope_id: string, display_name: string, status: string }>}
 */
export async function sendStaffCustomTemplateForSignature({ orgId, providerProfileId, staff, templateId }) {
  assertNativeSignatureReady(orgId);

  const row = db
    .prepare(
      `SELECT * FROM form_templates
       WHERE id = ? AND provider_profile_id = ? AND workflow = 'staff_onboarding' AND form_type = 'custom' AND is_active = 1`
    )
    .get(templateId, providerProfileId);
  if (!row) {
    const err = new Error('Custom staff form template not found.');
    err.code = 'TEMPLATE_NOT_FOUND';
    throw err;
  }

  const resolved = getCustomTemplatePath(row.id, row.template_filename);
  if (!resolved || resolved.type !== 'pdf') {
    const err = new Error('This template needs an uploaded PDF before it can be sent for signature.');
    err.code = 'TEMPLATE_FILE_MISSING';
    throw err;
  }

  const mapping = parseMappingJson(row.mapping_json);
  let signingLayout = parseSigningLayout(mapping);
  if (!signingLayout?.fields?.length) {
    signingLayout = await suggestSigningLayoutForTemplateFile(resolved.path, mapping.contract_field_map || {}, 'staff_onboarding');
  }

  const org = db.prepare('SELECT name FROM organisations WHERE id = ?').get(orgId);
  const onboarding = db.prepare('SELECT id FROM staff_onboarding WHERE staff_id = ?').get(staff.id);
  const rawIntake = onboarding?.id ? getStaffIntakeFieldMap(onboarding.id) : {};
  const baseData = buildStaffContractMergeData(staff, rawIntake, { organisationName: org?.name || '' });
  const mergeData = applyContractPlaceholderMap(baseData, mapping.contract_field_map || {});

  const pdfBytes = readFileSync(resolved.path);
  const filledPdf = signingLayout?.fields?.length
    ? await fillCustomFormFromLayout(pdfBytes, signingLayout, mergeData, { workflow: 'staff_onboarding' })
    : await fillStaffContractPdfBuffer(pdfBytes, mergeData, { workflow: 'staff_onboarding' });

  const orgSignatory = resolveOrgSignatoryForDocuSeal(orgId);
  const docuSealFieldOpts = buildCustomFormDocuSealFields(signingLayout, {
    workflow: 'staff_onboarding',
    org: orgSignatory,
    staff: { name: staff.name, email: staff.email }
  });

  let signers = docuSealFieldOpts.signers;
  if (signers?.length) {
    const orgEmail = (signers[0]?.email || '').trim();
    const staffEmail = (signers[1]?.email || staff.email || '').trim();
    if (!orgEmail) {
      const err = new Error('Set the default signatory email in Settings → Business before sending this form.');
      err.code = 'ORG_SIGNATORY_MISSING';
      throw err;
    }
    if (!staffEmail) {
      const err = new Error('Staff member has no email address for signature.');
      err.code = 'SIGNER_EMAIL_MISSING';
      throw err;
    }
    signers = [
      { ...signers[0], email: orgEmail },
      { ...signers[1], email: staffEmail }
    ];
  } else {
    if (!staff.email?.trim()) {
      const err = new Error('Staff member has no email address for signature.');
      err.code = 'SIGNER_EMAIL_MISSING';
      throw err;
    }
    signers = [{ name: staff.name || 'Staff member', email: staff.email }];
  }

  const envelopeId = uuidv4();
  const filename = `${(row.display_name || 'form').replace(/[^a-zA-Z0-9-_]+/g, '_')}.pdf`;
  await sendMultiDocumentAgreement(orgId, {
    signers,
    title: `${row.display_name || 'Form'} – ${staff.name || 'Staff member'}`,
    documents: [
      {
        buffer: filledPdf,
        filename,
        formFields: docuSealFieldOpts.formFieldsPerDocument?.[0] || []
      }
    ],
    envelopeId
  });

  db.prepare(
    `INSERT INTO staff_signature_envelopes (id, envelope_id, staff_id, org_id, form_template_id, display_name, status, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, 'sent', datetime('now'))`
  ).run(uuidv4(), envelopeId, staff.id, orgId, row.id, row.display_name || 'Form');

  return { envelope_id: envelopeId, display_name: row.display_name || 'Form', status: 'sent' };
}
