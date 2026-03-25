/**
 * Form Template Path Service - single place to resolve which empty template file
 * to use for each form type. Templates live under data/forms/templates/<form-type>/.
 * User can update forms by adding or replacing files in those folders.
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

/**
 * Get the template directory path for a form type (may not exist).
 */
export function getTemplateDir(formType) {
  const dirName = FORM_TYPE_DIR[formType];
  return dirName ? join(TEMPLATES_DIR, dirName) : null;
}

/**
 * Discover the single template file to use for a form type.
 * If options.templateFilename is set (from form_templates after a Forms UI upload), use that file when it exists.
 * Otherwise: list allowed extensions, sort by filename (deterministic), use first file.
 * @param {string} formType - one of privacy_consent, service_agreement, support_plan
 * @param {{ templateFilename?: string|null }} [options]
 * @returns {{ path: string, type: 'pdf'|'docx' } | null} path and type, or null if none found
 */
export function getTemplatePath(formType, options = {}) {
  const dir = getTemplateDir(formType);
  if (!dir || !existsSync(dir)) return null;

  const extensions = formType === 'privacy_consent'
    ? ['.docx']
    : ['.pdf', '.docx'];

  const templateFilename = options.templateFilename != null ? String(options.templateFilename).trim() : '';
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

  if (files.length === 0) return null;
  const chosen = files[0];
  const type = chosen.toLowerCase().endsWith('.docx') ? 'docx' : 'pdf';
  return { path: join(dir, chosen), type };
}

/**
 * Convenience: path only for privacy consent (for callers that only need path).
 * @returns {string|null}
 */
export function getConsentFormPath(options = {}) {
  const result = getTemplatePath('privacy_consent', options);
  return result ? result.path : null;
}

/**
 * Convenience: same as getTemplatePath('service_agreement') for drop-in replacement.
 * @returns {{ path: string, type: 'pdf'|'docx' } | null}
 */
export function getServiceAgreementTemplatePath(options = {}) {
  return getTemplatePath('service_agreement', options);
}

/**
 * Convenience: same as getTemplatePath('support_plan') for drop-in replacement.
 * @returns {{ path: string, type: 'pdf'|'docx' } | null}
 */
export function getSupportPlanTemplatePath(options = {}) {
  return getTemplatePath('support_plan', options);
}

/** Directory for custom form templates (by template id or filename). */
export function getCustomTemplateDir() {
  const dir = join(TEMPLATES_DIR, 'custom');
  return dir;
}

/**
 * Get path for a custom form template by id (reads template_filename from DB if needed).
 * @param {string} templateId - form_templates.id
 * @param {string} [templateFilename] - optional filename (e.g. from form_templates.template_filename)
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
