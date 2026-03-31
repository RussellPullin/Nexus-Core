/**
 * Form Template Path Service - resolves empty template files per form type.
 * Core types (privacy_consent, service_agreement, support_plan) resolve under:
 *   data/forms/templates/by-org/<organisationId>/<subdir>/  (when organisationId is set)
 * then fall back to legacy:
 *   data/forms/templates/<subdir>/
 * Custom templates stay under templates/custom/ (unique template id per row).
 */

import { existsSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const TEMPLATES_DIR = join(projectRoot, 'data', 'forms', 'templates');

/** form_type (DB) -> directory name under templates/ */
const FORM_TYPE_DIR = {
  privacy_consent: 'privacy-consent',
  service_agreement: 'service-agreement',
  support_plan: 'support-plan'
};

function safeOrgSegment(orgId) {
  if (orgId == null || typeof orgId !== 'string') return null;
  const t = orgId.trim();
  if (!t || /[./\\]/.test(t)) return null;
  return t;
}

/**
 * Get the template directory path for a form type (may not exist).
 * @param {string} formType
 * @param {string|null} [organisationId] - when set, org-specific folder under by-org/
 */
export function getTemplateDir(formType, organisationId = null) {
  const dirName = FORM_TYPE_DIR[formType];
  if (!dirName) return null;
  const seg = safeOrgSegment(organisationId);
  if (seg) return join(TEMPLATES_DIR, 'by-org', seg, dirName);
  return join(TEMPLATES_DIR, dirName);
}

/**
 * Discover the template file for a form type.
 * Tries org-specific dir first (if organisationId), then legacy global dir.
 * @param {string} formType - privacy_consent | service_agreement | support_plan
 * @param {{ organisationId?: string|null, templateFilename?: string|null }} [options]
 * @returns {{ path: string, type: 'pdf'|'docx' } | null}
 */
export function getTemplatePath(formType, options = {}) {
  const templateFilename = options.templateFilename != null ? String(options.templateFilename).trim() : '';
  const dirName = FORM_TYPE_DIR[formType];
  if (!dirName) return null;

  const dirsToTry = [];
  const seg = safeOrgSegment(options.organisationId);
  if (seg) dirsToTry.push(join(TEMPLATES_DIR, 'by-org', seg, dirName));
  const legacy = join(TEMPLATES_DIR, dirName);
  if (!dirsToTry.length || dirsToTry[0] !== legacy) dirsToTry.push(legacy);

  const extensions = formType === 'privacy_consent'
    ? ['.docx']
    : ['.pdf', '.docx'];

  for (const dir of dirsToTry) {
    if (!dir || !existsSync(dir)) continue;

    if (templateFilename) {
      const safeName = templateFilename.replace(/[/\\]/g, '');
      const candidate = join(dir, safeName);
      if (existsSync(candidate)) {
        const lower = safeName.toLowerCase();
        const ok = extensions.some((ext) => lower.endsWith(ext));
        if (ok) {
          const type = lower.endsWith('.docx') ? 'docx' : 'pdf';
          return { path: candidate, type };
        }
      }
    }

    const files = readdirSync(dir)
      .filter((f) => !f.startsWith('.') && extensions.some((ext) => f.toLowerCase().endsWith(ext)))
      .sort((a, b) => a.localeCompare(b, 'en'));

    if (files.length > 0) {
      const chosen = files[0];
      const type = chosen.toLowerCase().endsWith('.docx') ? 'docx' : 'pdf';
      return { path: join(dir, chosen), type };
    }
  }
  return null;
}

/**
 * @returns {string|null}
 */
export function getConsentFormPath(options = {}) {
  const result = getTemplatePath('privacy_consent', options);
  return result ? result.path : null;
}

/**
 * @returns {{ path: string, type: 'pdf'|'docx' } | null}
 */
export function getServiceAgreementTemplatePath(options = {}) {
  return getTemplatePath('service_agreement', options);
}

/**
 * @returns {{ path: string, type: 'pdf'|'docx' } | null}
 */
export function getSupportPlanTemplatePath(options = {}) {
  return getTemplatePath('support_plan', options);
}

/** Directory for custom form templates (by template id or filename). */
export function getCustomTemplateDir() {
  return join(TEMPLATES_DIR, 'custom');
}

/**
 * @param {string} templateId - form_templates.id
 * @param {string} [templateFilename]
 * @returns {{ path: string, type: 'pdf'|'docx' } | null}
 */
export function getCustomTemplatePath(templateId, templateFilename) {
  const dir = getCustomTemplateDir();
  if (!existsSync(dir)) return null;
  const filename = templateFilename || `${templateId}.docx`;
  const pathPdf = join(dir, `${templateId}.pdf`);
  const pathDocx = join(dir, `${templateId}.docx`);
  const pathNamed = templateFilename ? join(dir, templateFilename) : null;
  if (pathNamed && existsSync(pathNamed)) {
    const type = pathNamed.toLowerCase().endsWith('.docx') ? 'docx' : 'pdf';
    return { path: pathNamed, type };
  }
  if (existsSync(pathDocx)) return { path: pathDocx, type: 'docx' };
  if (existsSync(pathPdf)) return { path: pathPdf, type: 'pdf' };
  return null;
}
