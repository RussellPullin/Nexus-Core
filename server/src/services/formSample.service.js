/**
 * Sample PDF generation for onboarding forms (org-branded where supported).
 */
import { db } from '../db/index.js';
import { getOrgRenderContext } from './orgContext.service.js';
import {
  getConsentFormPath,
  getSupportPlanTemplatePath,
  getServiceAgreementTemplatePath
} from './formTemplatePath.service.js';
import { fillConsentForm, convertDocxToPdf } from './consentForm.service.js';
import { fillServiceAgreement, fillSupportPlan } from './formFill.service.js';
import { buildSampleParticipantContext } from './formTemplateRecipientPreview.service.js';

export function assessOrgSampleReadiness(orgId) {
  const ctx = getOrgRenderContext(orgId);
  const legalOrTrading = String(ctx.org.legalName || ctx.org.tradingName || ctx.org.name || '').trim();
  const hasName = Boolean(legalOrTrading);
  const hasLogo = Boolean(ctx.branding.logoPath);
  const hints = [];
  if (!hasName) hints.push('Add your organisation name in Settings or the setup wizard.');
  if (!hasLogo) hints.push('Upload your logo to see it on Nexus-generated forms.');
  return {
    has_name: hasName,
    has_logo: hasLogo,
    sample_ready: hasName,
    hints
  };
}

function resolveCoreTemplate(formType, { organisationId, templateFilename }) {
  const opts = { organisationId, templateFilename: templateFilename || null };
  if (formType === 'privacy_consent') {
    const path = getConsentFormPath(opts);
    return path ? { kind: 'privacy_consent', path } : null;
  }
  if (formType === 'support_plan') {
    return getSupportPlanTemplatePath(opts);
  }
  if (formType === 'service_agreement') {
    return getServiceAgreementTemplatePath(opts);
  }
  return null;
}

/**
 * @param {'privacy_consent'|'support_plan'|'service_agreement'} formType
 * @param {{ organisationId: string, templateFilename?: string|null }} opts
 */
export async function buildCoreFormSamplePdfBuffer(formType, opts) {
  const resolved = resolveCoreTemplate(formType, opts);
  if (!resolved) {
    throw new Error('No template file uploaded for this form yet.');
  }

  const { participant, plan, intake } = buildSampleParticipantContext();
  const pathOpts = {
    organisationId: opts.organisationId,
    templateFilename: opts.templateFilename || null
  };

  if (formType === 'privacy_consent') {
    const filledDocx = fillConsentForm(participant, intake, pathOpts);
    const pdfBuffer = convertDocxToPdf(filledDocx);
    if (pdfBuffer) return pdfBuffer;
    throw new Error('Could not convert consent form to PDF on this server.');
  }

  if (formType === 'support_plan') {
    const filled = await fillSupportPlan(participant, plan, intake, pathOpts);
    return filled;
  }

  if (formType === 'service_agreement') {
    return fillServiceAgreement(participant, plan, intake, { db, ...pathOpts });
  }

  throw new Error('Unsupported form type for sample generation.');
}

export function orgHasNexusServiceAgreement(orgId) {
  if (!orgId) return false;
  const row = db
    .prepare(
      `
    SELECT i.id FROM nexus_org_form_templates i
    JOIN nexus_form_template_masters m ON m.id = i.master_id
    WHERE i.org_id = ? AND m.template_type = 'service_agreement'
    LIMIT 1
  `
    )
    .get(orgId);
  return Boolean(row);
}
