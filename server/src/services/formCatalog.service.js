/**
 * Lists org onboarding forms with sample download URLs and readiness flags.
 */
import { db } from '../db/index.js';
import { getOrgRenderContext } from './orgContext.service.js';
import { ensureProviderProfile, seedCoreTemplates, getTemplateCoverage } from './onboarding.service.js';
import { getCustomTemplatePath } from './formTemplatePath.service.js';
import { assessOrgSampleReadiness, orgHasNexusServiceAgreement } from './formSample.service.js';
import { getConsentFormPath, getSupportPlanTemplatePath, getServiceAgreementTemplatePath } from './formTemplatePath.service.js';

const CORE_SAMPLE_TYPES = new Set(['privacy_consent', 'support_plan', 'service_agreement']);

function coreTemplateHasFile(formType, { organisationId, templateFilename }) {
  const opts = { organisationId, templateFilename: templateFilename || null };
  if (formType === 'privacy_consent') return Boolean(getConsentFormPath(opts));
  if (formType === 'support_plan') return Boolean(getSupportPlanTemplatePath(opts));
  if (formType === 'service_agreement') return Boolean(getServiceAgreementTemplatePath(opts));
  return false;
}

/**
 * @param {{ orgId: string|null, providerProfileId: string|null }} params
 */
export function buildFormCatalog({ orgId, providerProfileId }) {
  const orgCtx = orgId ? getOrgRenderContext(orgId) : null;
  const readiness = orgId
    ? assessOrgSampleReadiness(orgId)
    : { has_name: false, has_logo: false, sample_ready: false, hints: ['Assign your user to an organisation.'] };
  const forms = [];

  if (orgId) {
    const nexusRows = db
      .prepare(
        `
      SELECT i.id, i.label, i.updated_at, m.template_type, m.title AS master_title, m.version_label
      FROM nexus_org_form_templates i
      JOIN nexus_form_template_masters m ON m.id = i.master_id
      WHERE i.org_id = ?
      ORDER BY m.template_type ASC, datetime(i.updated_at) DESC
    `
      )
      .all(orgId);

    for (const row of nexusRows) {
      forms.push({
        id: row.id,
        catalog_key: `nexus:${row.id}`,
        display_name: row.label || row.master_title || 'Form template',
        form_type: row.template_type,
        engine: 'nexus',
        version_label: row.version_label || null,
        has_template_file: true,
        org_branded: true,
        sample_ready: readiness.sample_ready,
        sample_url: `/api/form-templates/instances/${row.id}/preview.pdf`,
        sample_filename: `${(row.label || row.master_title || 'form').replace(/\s+/g, '-')}-sample.pdf`
      });
    }
  }

  if (providerProfileId && orgId) {
    seedCoreTemplates(providerProfileId);
    const { templates } = getTemplateCoverage(providerProfileId, { workflow: 'participant_onboarding' });
    const skipLegacySa = orgHasNexusServiceAgreement(orgId);
    const seenTypes = new Set();

    for (const row of templates) {
      if (!row.is_active) continue;
      if (row.form_type === 'intake_form') continue;
      if (row.form_type === 'service_agreement' && skipLegacySa) continue;

      const dedupeKey = row.form_type === 'custom' ? `custom:${row.id}` : row.form_type;
      if (seenTypes.has(dedupeKey)) continue;
      seenTypes.add(dedupeKey);

      const pathOpts = { organisationId: orgId, templateFilename: row.template_filename || null };
      let has_template_file = false;
      let sample_url = null;
      let org_branded = false;

      if (row.form_type === 'custom') {
        has_template_file = Boolean(getCustomTemplatePath(row.id, row.template_filename));
        if (has_template_file) {
          sample_url = `/api/forms/templates/${row.id}/recipient-preview.pdf`;
        }
      } else if (CORE_SAMPLE_TYPES.has(row.form_type)) {
        has_template_file = coreTemplateHasFile(row.form_type, pathOpts);
        if (has_template_file) {
          sample_url = `/api/forms/core-samples/${row.form_type}.pdf?template_id=${encodeURIComponent(row.id)}`;
          org_branded = row.form_type === 'service_agreement';
        }
      }

      forms.push({
        id: row.id,
        catalog_key: `legacy:${row.id}`,
        display_name: row.display_name || row.form_type,
        form_type: row.form_type,
        engine: row.form_type === 'custom' ? 'custom_upload' : 'legacy',
        version_label: row.version || null,
        has_template_file,
        org_branded,
        sample_ready: readiness.sample_ready && has_template_file,
        sample_url,
        sample_filename: `${(row.display_name || row.form_type).replace(/\s+/g, '-')}-sample.pdf`
      });
    }
  }

  return {
    organisation_id: orgId,
    organisation_name: orgCtx?.org?.tradingName || orgCtx?.org?.name || null,
    org_readiness: readiness,
    forms
  };
}

/**
 * Resolve provider profile + org for the current session user.
 * @param {string} userId
 */
export function formCatalogContextForUser(userId) {
  const user = db.prepare('SELECT org_id FROM users WHERE id = ?').get(userId);
  const orgId = user?.org_id || null;
  if (!orgId) {
    return { orgId: null, providerProfileId: null };
  }
  const profile = ensureProviderProfile(orgId);
  return { orgId, providerProfileId: profile?.id || null };
}
