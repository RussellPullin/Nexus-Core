/**
 * Bulk upload PDF form templates → form_templates rows + field mapping + signer-view preview PDF.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join, basename, extname } from 'path';
import AdmZip from 'adm-zip';
import { db } from '../db/index.js';
import { createFormTemplate } from './onboarding.service.js';
import { getCustomTemplateDir, getCustomTemplatePath, getDataRoot } from './formTemplatePath.service.js';
import {
  analyzeContractTemplateBuffer,
  suggestContractFieldMap,
  mergeContractFieldMapSuggestions
} from './contractTemplateAnalyze.service.js';
import { buildSignerPreviewPdfBuffer } from './formTemplateSignerPreview.service.js';
import {
  suggestSigningLayoutFromPdf,
  suggestSigningLayoutFromMap,
  contractFieldMapFromLayout,
  parseSigningLayout
} from './formTemplateSigningLayout.service.js';

export function signerPreviewPath(orgId, templateId) {
  return join(getDataRoot(), 'forms', 'signer-previews', orgId, `${templateId}.pdf`);
}

/** @deprecated Legacy path — checked for backwards compatibility after deploy. */
export function orgPreviewPath(orgId, templateId) {
  return join(getDataRoot(), 'forms', 'org-previews', orgId, `${templateId}.pdf`);
}

function parseMappingJson(val) {
  if (!val) return {};
  try {
    return typeof val === 'object' ? val : JSON.parse(val);
  } catch {
    return {};
  }
}

function displayNameFromFilename(filename) {
  return basename(String(filename || 'Form'), extname(filename)).replace(/[_-]+/g, ' ').trim() || 'Form';
}

function normalizeWorkflow(w) {
  return w === 'staff_onboarding' ? 'staff_onboarding' : 'participant_onboarding';
}

/**
 * Generate signer-view preview: highlighted empty fields with merge labels inside.
 */
export async function generateSignerPreviewPdf(orgId, templateId) {
  const template = db
    .prepare(
      `SELECT id, workflow, template_filename, mapping_json FROM form_templates WHERE id = ? AND form_type = 'custom'`
    )
    .get(templateId);
  if (!template?.template_filename) throw new Error('Template file not uploaded yet.');

  const dir = getCustomTemplateDir();
  const filePath = join(dir, template.template_filename);
  if (!existsSync(filePath)) throw new Error('Template file missing on disk.');

  const mapping = parseMappingJson(template.mapping_json);
  const workflow = template.workflow === 'staff_onboarding' ? 'staff_onboarding' : 'participant_onboarding';
  const pdfBytes = readFileSync(filePath);
  const { pdfBuffer: preview } = await buildSignerPreviewPdfBuffer(
    pdfBytes,
    mapping.contract_field_map || {},
    workflow,
    parseSigningLayout(mapping)
  );

  const outDir = join(getDataRoot(), 'forms', 'signer-previews', orgId);
  mkdirSync(outDir, { recursive: true });
  const outPath = signerPreviewPath(orgId, templateId);
  writeFileSync(outPath, preview);
  return outPath;
}

/** @deprecated Use generateSignerPreviewPdf */
export const generateOrgPreviewPdf = generateSignerPreviewPdf;

export function hasSignerPreview(orgId, templateId) {
  return existsSync(signerPreviewPath(orgId, templateId)) || existsSync(orgPreviewPath(orgId, templateId));
}

export const hasOrgPreview = hasSignerPreview;

/**
 * @param {string} providerProfileId
 * @param {string} orgId
 * @param {{ originalname: string, buffer: Buffer }} file
 * @param {{ display_name?: string, workflow?: string }} opts
 */
export async function ingestFormTemplatePdf(providerProfileId, orgId, file, opts = {}) {
  const original = String(file.originalname || 'form.pdf').replace(/[/\\]/g, '_');
  const lower = original.toLowerCase();
  if (!lower.endsWith('.pdf')) {
    throw new Error('Form templates must be PDF files with fillable fields.');
  }
  if (!file.buffer?.length) throw new Error('Empty file.');

  const workflow = normalizeWorkflow(opts.workflow);
  const displayName = (opts.display_name || displayNameFromFilename(original)).trim();
  const workflowKind = workflow === 'staff_onboarding' ? 'staff' : 'participant';

  const template = createFormTemplate(providerProfileId, { display_name: displayName, workflow });

  const dir = getCustomTemplateDir();
  mkdirSync(dir, { recursive: true });
  const saveName = `${template.id}.pdf`;
  writeFileSync(join(dir, saveName), file.buffer);

  const analysis = await analyzeContractTemplateBuffer(file.buffer, original);
  const acroNames = analysis.pdf_form_fields || [];
  const placeholders = acroNames.length > 0 ? acroNames : analysis.all_placeholders || [];
  const suggested = suggestContractFieldMap(placeholders, workflowKind);
  const contract_field_map = mergeContractFieldMapSuggestions(suggested, {});
  let signing_layout;
  try {
    signing_layout = await suggestSigningLayoutFromPdf(file.buffer, contract_field_map, workflow);
  } catch (layoutErr) {
    console.warn('[formTemplateBulkUpload] signing layout suggest failed:', layoutErr?.message);
    signing_layout = suggestSigningLayoutFromMap(contract_field_map, workflow);
  }
  const layoutMap = contractFieldMapFromLayout(signing_layout);
  const mergedFieldMap = mergeContractFieldMapSuggestions(contract_field_map, layoutMap);
  const mapping_json = {
    contract_field_map: mergedFieldMap,
    signing_layout,
    contract_analysis: {
      ...analysis,
      analyzed_at: new Date().toISOString(),
      template_file_updated: true
    }
  };

  db.prepare(
    `UPDATE form_templates SET template_filename = ?, mapping_json = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(saveName, JSON.stringify(mapping_json), template.id);

  let preview_ready = false;
  try {
    await generateSignerPreviewPdf(orgId, template.id);
    preview_ready = true;
  } catch (e) {
    console.warn('[formTemplateBulkUpload] signer preview failed:', e?.message);
  }

  return {
    template_id: template.id,
    display_name: displayName,
    workflow,
    filename: saveName,
    placeholders_found: analysis.all_placeholders?.length ?? 0,
    acro_field_count: acroNames.length,
    mapped_field_count:
      signing_layout?.fields?.length ||
      (acroNames.length > 0
        ? acroNames.filter((n) => mergedFieldMap[n]).length
        : Object.keys(mergedFieldMap).length),
    signing_layout_field_count: signing_layout?.fields?.length || 0,
    preview_ready,
    preview_url: preview_ready ? `/api/forms/templates/${template.id}/signer-preview.pdf` : null
  };
}

export async function ingestFormTemplateBatch(providerProfileId, orgId, files, options = {}) {
  const results = { imported: [], errors: [] };
  const defaultWorkflow = options.workflow ? normalizeWorkflow(options.workflow) : 'participant_onboarding';
  const itemsMeta = options.items || [];

  for (let i = 0; i < (files || []).length; i += 1) {
    const file = files[i];
    const meta = itemsMeta[i] || {};
    try {
      const row = await ingestFormTemplatePdf(providerProfileId, orgId, file, {
        display_name: meta.display_name,
        workflow: meta.workflow || defaultWorkflow
      });
      results.imported.push(row);
    } catch (e) {
      results.errors.push({ file: file.originalname, error: e.message });
    }
  }
  return results;
}

export async function ingestFormTemplateZip(providerProfileId, orgId, zipBuffer, options = {}) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter((e) => !e.isDirectory && !e.entryName.startsWith('__MACOSX'));
  const files = [];
  for (const entry of entries) {
    const name = basename(entry.entryName);
    if (!name.toLowerCase().endsWith('.pdf')) continue;
    files.push({ originalname: name, buffer: entry.getData() });
  }
  if (!files.length) throw new Error('ZIP contains no PDF files.');
  return ingestFormTemplateBatch(providerProfileId, orgId, files, options);
}

/**
 * Enrich GET /forms/templates list rows with file + preview metadata.
 */
export function enrichCustomTemplateRow(row, orgId) {
  if (!row || row.form_type !== 'custom') return row;
  const resolved = row.id ? getCustomTemplatePath(row.id, row.template_filename) : null;
  const hasFile = Boolean(resolved);
  const file_missing_on_disk = Boolean(row.template_filename) && !hasFile;
  let mapped_field_count = 0;
  let acro_field_count = 0;
  let signing_layout_field_count = 0;
  try {
    const mapping = parseMappingJson(row.mapping_json);
    const acroNames = mapping.contract_analysis?.pdf_form_fields || [];
    acro_field_count = Array.isArray(acroNames) ? acroNames.length : 0;
    signing_layout_field_count = mapping.signing_layout?.fields?.length || 0;
    const map = mapping.contract_field_map || {};
    if (signing_layout_field_count > 0) {
      mapped_field_count = signing_layout_field_count;
    } else if (acro_field_count > 0) {
      mapped_field_count = acroNames.filter((n) => map[n]).length;
    } else {
      mapped_field_count = Object.keys(map).length;
    }
  } catch {
    mapped_field_count = 0;
    acro_field_count = 0;
    signing_layout_field_count = 0;
  }
  const preview_ready = orgId && row.id ? hasSignerPreview(orgId, row.id) : false;
  return {
    ...row,
    has_template_file: hasFile,
    file_missing_on_disk,
    mapped_field_count,
    acro_field_count,
    signing_layout_field_count,
    preview_ready
  };
}

/**
 * Resolve cached signer preview path (new or legacy org-previews folder).
 */
export function resolveSignerPreviewPath(orgId, templateId) {
  const primary = signerPreviewPath(orgId, templateId);
  if (existsSync(primary)) return primary;
  const legacy = orgPreviewPath(orgId, templateId);
  if (existsSync(legacy)) return legacy;
  return null;
}
