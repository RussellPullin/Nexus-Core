/**
 * Phase 1: File-based master document library.
 *
 * Authors drop a deidentified document into:
 *   server/templates/library/<slug>/
 *     ├─ template.pdf               (tokenised fillable PDF — engine pdf-acroform)
 *     ├─ manifest.json              (metadata + placeholder declarations)
 *     └─ preview.png  (optional)
 *
 * Manifest schema (see /docs/document-library.md once created):
 * {
 *   "slug": "policy-incident-management",       // unique, kebab-case
 *   "display_name": "Incident Management Policy",
 *   "category": "policy",                        // policy | procedure | register | contract | form | guide
 *   "form_type": "policy",                       // matches form_templates.form_type when relevant
 *   "engine": "docxtemplater",                   // docxtemplater | pdf-acroform | html
 *   "version": "1.0.0",
 *   "template_file": "template.pdf",
 *   "placeholders": ["org.legal_name", "org.abn", "org.signatory.name", "today_long"],
 *   "required_signer_role": "participant",       // optional
 *   "renewal_days": 365,                         // optional
 *   "participant_service_types": ["all"],        // optional — sil | sda | support_coordination | core_supports | all
 *   "staff_roles": ["all"]                       // optional — disability_support_worker | support_coordinator | admin | all
 * }
 *
 * On boot (or on demand) we walk the library, validate each manifest, and upsert into
 * `document_library_masters`. From there each org can clone into its own row via
 * `cloneLibraryMasterToOrg(masterId, orgId)`.
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import mammoth from 'mammoth';
import { db } from '../db/index.js';
import { unknownPlaceholders } from '../lib/templateTokens.js';
import {
  VALID_PARTICIPANT_SERVICE_TYPES,
  VALID_STAFF_ONBOARDING_ROLES
} from '../../../shared/onboardingDocumentContext.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const defaultLibraryRoot = process.env.DOCUMENT_LIBRARY_DIR
  || join(projectRoot, 'templates', 'library');

const VALID_ENGINES = new Set(['docxtemplater', 'pdf-acroform', 'html']);
const VALID_CATEGORIES = new Set(['policy', 'procedure', 'register', 'contract', 'form', 'guide']);
export const VALID_LIBRARY_PACKS = new Set([
  'participant_onboarding',
  'staff_onboarding',
  'policy_library',
  'compliance_register'
]);

const ONBOARDING_PACKS = new Set(['participant_onboarding', 'staff_onboarding']);
const EXCLUSIVE_PACKS = new Set(['policy_library', 'compliance_register']);

/**
 * Resolve manifest `packs` from either a `packs` array or legacy single `pack` string.
 * @param {object} manifest
 * @returns {string[]}
 */
export function normalizeManifestPacks(manifest) {
  if (!manifest || typeof manifest !== 'object') return [];
  if (Array.isArray(manifest.packs) && manifest.packs.length) {
    return manifest.packs.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
  }
  if (typeof manifest.pack === 'string' && manifest.pack.trim()) {
    return [manifest.pack.trim()];
  }
  return [];
}

/**
 * @param {string[]} packs
 * @returns {string[]}
 */
export function validateLibraryPacks(packs) {
  if (!Array.isArray(packs)) {
    throw new Error('packs must be an array');
  }
  if (packs.length === 0) return [];
  const unique = [...new Set(packs.map((p) => String(p).trim()).filter(Boolean))];
  if (unique.length !== packs.length) {
    throw new Error('packs must not contain duplicates');
  }
  for (const p of unique) {
    if (!VALID_LIBRARY_PACKS.has(p)) {
      throw new Error(`pack must be one of: ${[...VALID_LIBRARY_PACKS].join(', ')}`);
    }
  }
  if (unique.includes('policy_library') && unique.length > 1) {
    throw new Error('policy_library cannot be combined with other packs');
  }
  if (unique.includes('compliance_register') && unique.length > 1) {
    throw new Error('compliance_register cannot be combined with other packs');
  }
  return unique;
}

/** Write normalized `packs` onto manifest; keep legacy `pack` as first entry for backward compat. */
function applyPacksToManifest(manifest, packs) {
  if (!packs.length) {
    delete manifest.packs;
    delete manifest.pack;
  } else {
    manifest.packs = packs;
    manifest.pack = packs[0];
  }
  return manifest;
}

function slugifyHeading(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

function stripHtmlTags(html) {
  return String(html || '').replace(/<[^>]*>/g, '').trim();
}

/**
 * Find [start, end) character ranges covering every `<table>...</table>` block, so headings
 * nested inside table cells (e.g. a Procedure table's row headers) aren't mistaken for
 * top-level document sections. Handles nested tables via a depth counter.
 */
function findTableRanges(html) {
  const ranges = [];
  const tagRegex = /<(table)\b[^>]*>|<\/(table)>/gi;
  let depth = 0;
  let start = -1;
  let match;
  while ((match = tagRegex.exec(html))) {
    if (match[1]) {
      if (depth === 0) start = match.index;
      depth += 1;
    } else {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start !== -1) {
        ranges.push([start, match.index + match[0].length]);
        start = -1;
      }
    }
  }
  return ranges;
}

function isWithinRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * Split a docx into top-level-heading sections for policy-category masters, so an org can later
 * override individual named blocks (Policy Statement, Definitions, etc.) while still inheriting
 * everything else — including future master edits — from the shared template.
 *
 * These NDIS policy templates are inconsistent about which heading level marks a named block
 * (e.g. "Policy Statement" is H1 with H3 children directly, while "Introduction" is H1 wrapping
 * H2 sub-clauses like "Purpose"/"Policy Aims") — so both H1 and H2 are treated as section
 * boundaries; H3+ stays embedded within whichever section it falls under. Headings nested inside
 * a table (e.g. Procedure table row headers) are NOT treated as boundaries — the whole table
 * stays part of its enclosing section, since row-level override granularity is out of scope for
 * v1.
 *
 * Section keys are matched against `previousSections` by heading text first so an org's stored
 * overrides don't orphan when the master is re-synced with only minor wording changes elsewhere.
 *
 * @param {string} templateFilePath
 * @param {Array<{key:string, heading:string}>} [previousSections]
 * @returns {Promise<Array<{key:string, heading:string, level:number, content_html:string}>>}
 */
export async function extractPolicySections(templateFilePath, previousSections = []) {
  const { value: html } = await mammoth.convertToHtml({ path: templateFilePath });

  const tableRanges = findTableRanges(html);
  const headingRegex = /<h([12])[^>]*>(.*?)<\/h\1>/gis;
  const matches = [...html.matchAll(headingRegex)].filter((m) => !isWithinRanges(m.index, tableRanges));

  const previousKeyByHeading = new Map(
    (previousSections || []).map((s) => [s.heading, s.key])
  );

  const sections = [];
  const usedKeys = new Set();

  const mintKey = (headingText) => {
    const reused = previousKeyByHeading.get(headingText);
    if (reused && !usedKeys.has(reused)) {
      usedKeys.add(reused);
      return reused;
    }
    let base = slugifyHeading(headingText);
    let key = base;
    let n = 2;
    while (usedKeys.has(key)) {
      key = `${base}-${n}`;
      n += 1;
    }
    usedKeys.add(key);
    return key;
  };

  if (matches.length === 0) {
    // No top-level headings found at all — treat the whole document as one section.
    return [{ key: mintKey('document'), heading: null, level: 0, content_html: html }];
  }

  // Content before the first top-level heading (e.g. a title with no body).
  const preambleHtml = html.slice(0, matches[0].index).trim();
  if (preambleHtml && stripHtmlTags(preambleHtml)) {
    sections.push({ key: mintKey('preamble'), heading: null, level: 0, content_html: preambleHtml });
  }

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const level = Number(match[1]);
    const headingText = stripHtmlTags(match[2]);
    const start = match.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : html.length;
    sections.push({
      key: mintKey(headingText),
      heading: headingText,
      level,
      content_html: html.slice(start, end).trim()
    });
  }

  return sections;
}

/**
 * @param {string} [rootDir]
 * @returns {Promise<{ scanned: number, registered: number, skipped: {slug:string, reason:string}[], warnings: string[] }>}
 */
export async function syncDocumentLibraryFromDisk(rootDir = defaultLibraryRoot) {
  const result = { scanned: 0, registered: 0, skipped: [], warnings: [] };
  if (!existsSync(rootDir)) {
    result.warnings.push(`Library directory does not exist: ${rootDir}`);
    return result;
  }

  const entries = readdirSync(rootDir).filter((name) => {
    try {
      return statSync(join(rootDir, name)).isDirectory();
    } catch {
      return false;
    }
  });

  const upsertStmt = db.prepare(`
    INSERT INTO document_library_masters (
      id, slug, display_name, category, form_type, engine, version,
      template_file_path, placeholders_json, manifest_json,
      required_signer_role, renewal_days, sections_json, is_active, last_synced_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      display_name = excluded.display_name,
      category = excluded.category,
      form_type = excluded.form_type,
      engine = excluded.engine,
      version = excluded.version,
      template_file_path = excluded.template_file_path,
      placeholders_json = excluded.placeholders_json,
      manifest_json = excluded.manifest_json,
      required_signer_role = excluded.required_signer_role,
      renewal_days = excluded.renewal_days,
      sections_json = excluded.sections_json,
      is_active = excluded.is_active,
      last_synced_at = datetime('now'),
      updated_at = datetime('now')
  `);
  const previousSectionsStmt = db.prepare('SELECT sections_json FROM document_library_masters WHERE slug = ?');

  for (const dirName of entries) {
    result.scanned += 1;
    const dirPath = join(rootDir, dirName);
    const manifestPath = join(dirPath, 'manifest.json');
    if (!existsSync(manifestPath)) {
      result.skipped.push({ slug: dirName, reason: 'manifest.json missing' });
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      result.skipped.push({ slug: dirName, reason: `manifest.json invalid JSON: ${err.message}` });
      continue;
    }
    const validation = validateManifest(manifest, dirName);
    if (validation.error) {
      result.skipped.push({ slug: manifest.slug || dirName, reason: validation.error });
      continue;
    }
    const packs = normalizeManifestPacks(manifest);
    if (packs.length) {
      try {
        applyPacksToManifest(manifest, validateLibraryPacks(packs));
      } catch (err) {
        result.skipped.push({ slug: manifest.slug, reason: err.message });
        continue;
      }
    }
    const templateFilePath = join(dirPath, manifest.template_file);
    if (!existsSync(templateFilePath)) {
      result.skipped.push({ slug: manifest.slug, reason: `template_file not found: ${manifest.template_file}` });
      continue;
    }

    const unknown = unknownPlaceholders(manifest.placeholders || []);
    if (unknown.length) {
      result.warnings.push(`[${manifest.slug}] unknown placeholders ignored: ${unknown.join(', ')}`);
    }

    let sectionsJson = null;
    if (manifest.category === 'policy' && manifest.engine === 'docxtemplater') {
      try {
        const previousRow = previousSectionsStmt.get(manifest.slug);
        let previousSections = [];
        if (previousRow?.sections_json) {
          try {
            previousSections = JSON.parse(previousRow.sections_json);
          } catch {
            previousSections = [];
          }
        }
        const sections = await extractPolicySections(templateFilePath, previousSections);
        sectionsJson = JSON.stringify(sections);
      } catch (err) {
        result.warnings.push(`[${manifest.slug}] section extraction failed: ${err.message}`);
      }
    }

    upsertStmt.run(
      uuidv4(),
      manifest.slug,
      manifest.display_name,
      manifest.category,
      manifest.form_type,
      manifest.engine,
      manifest.version,
      templateFilePath,
      JSON.stringify(manifest.placeholders || []),
      JSON.stringify(manifest),
      manifest.required_signer_role || null,
      Number.isFinite(manifest.renewal_days) ? manifest.renewal_days : null,
      sectionsJson,
      manifest.is_active === false ? 0 : 1
    );
    result.registered += 1;
  }

  // Deactivate masters whose folder was removed since last sync.
  const knownSlugs = new Set();
  for (const dirName of entries) {
    try {
      const m = JSON.parse(readFileSync(join(rootDir, dirName, 'manifest.json'), 'utf8'));
      if (m?.slug) knownSlugs.add(m.slug);
    } catch {
      /* ignore — already accounted for above */
    }
  }
  const existingMasters = db.prepare('SELECT slug FROM document_library_masters WHERE is_active = 1').all();
  for (const row of existingMasters) {
    if (!knownSlugs.has(row.slug)) {
      db.prepare("UPDATE document_library_masters SET is_active = 0, updated_at = datetime('now') WHERE slug = ?").run(row.slug);
      result.warnings.push(`Deactivated master no longer on disk: ${row.slug}`);
    }
  }

  try {
    const orgs = db.prepare('SELECT id FROM organisations').all();
    for (const org of orgs) {
      if (org?.id) cloneAllLibraryMastersForOrg(org.id);
    }
  } catch (err) {
    result.warnings.push(`org clone refresh failed: ${err.message}`);
  }

  return result;
}

function validateManifest(manifest, dirName) {
  if (!manifest || typeof manifest !== 'object') return { error: 'manifest is not an object' };
  if (!manifest.slug) return { error: 'manifest.slug missing' };
  if (!/^[a-z0-9-]+$/.test(manifest.slug)) return { error: `slug must be kebab-case (got: ${manifest.slug})` };
  if (manifest.slug !== dirName) {
    return { error: `slug "${manifest.slug}" must match folder name "${dirName}"` };
  }
  if (!manifest.display_name) return { error: 'display_name missing' };
  if (!VALID_CATEGORIES.has(manifest.category)) {
    return { error: `category must be one of ${[...VALID_CATEGORIES].join('|')}` };
  }
  if (!manifest.form_type) return { error: 'form_type missing' };
  if (!VALID_ENGINES.has(manifest.engine)) {
    return { error: `engine must be one of ${[...VALID_ENGINES].join('|')}` };
  }
  if (!manifest.version) return { error: 'version missing' };
  if (!manifest.template_file) return { error: 'template_file missing' };
  const serviceTypes = manifest.participant_service_types;
  if (serviceTypes != null) {
    if (!Array.isArray(serviceTypes)) return { error: 'participant_service_types must be an array' };
    const bad = serviceTypes.filter((t) => !VALID_PARTICIPANT_SERVICE_TYPES.has(t));
    if (bad.length) return { error: `invalid participant_service_types: ${bad.join(', ')}` };
  }
  const staffRoles = manifest.staff_roles;
  if (staffRoles != null) {
    if (!Array.isArray(staffRoles)) return { error: 'staff_roles must be an array' };
    const bad = staffRoles.filter((t) => !VALID_STAFF_ONBOARDING_ROLES.has(t));
    if (bad.length) return { error: `invalid staff_roles: ${bad.join(', ')}` };
  }
  return { error: null };
}

/**
 * Clone a master into a specific org so it becomes part of that org's available templates.
 * @param {string} masterId
 * @param {string} orgId
 * @returns {string} clone row id
 */
export function cloneLibraryMasterToOrg(masterId, orgId) {
  if (!masterId || !orgId) throw new Error('masterId and orgId required');
  const existing = db
    .prepare('SELECT id FROM document_library_org_clones WHERE master_id = ? AND org_id = ?')
    .get(masterId, orgId);
  if (existing?.id) return existing.id;
  const id = uuidv4();
  db.prepare(`
    INSERT INTO document_library_org_clones (id, master_id, org_id, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
  `).run(id, masterId, orgId);
  return id;
}

/**
 * Walk every active master and ensure the given org has a clone row. Called when a new org
 * finishes setup so it inherits the entire NDIS document register.
 *
 * @param {string} orgId
 * @returns {{ cloned: number }}
 */
export function cloneAllLibraryMastersForOrg(orgId) {
  const masters = db.prepare('SELECT id FROM document_library_masters WHERE is_active = 1').all();
  let cloned = 0;
  for (const m of masters) {
    cloneLibraryMasterToOrg(m.id, orgId);
    cloned += 1;
  }
  return { cloned };
}

const VALID_OVERRIDE_MODES = new Set(['inherit', 'sections', 'full_upload']);

/**
 * A policy master's section list (from `sections_json`), or `[]` if the master hasn't been
 * through section extraction (non-policy category, non-docxtemplater engine, or not yet synced).
 * @param {string} masterId
 * @returns {Array<{key:string, heading:string|null, level:number, content_html:string}>}
 */
export function getMasterSections(masterId) {
  const master = db.prepare('SELECT sections_json FROM document_library_masters WHERE id = ?').get(masterId);
  if (!master?.sections_json) return [];
  try {
    return JSON.parse(master.sections_json);
  } catch {
    return [];
  }
}

/**
 * @param {string} orgId
 * @param {string} masterId
 * @returns {Array<{section_key:string, content_html:string, updated_at:string, updated_by:string|null}>}
 */
export function listOrgSectionOverrides(orgId, masterId) {
  return db
    .prepare(
      'SELECT section_key, content_html, updated_at, updated_by FROM document_library_org_section_overrides WHERE org_id = ? AND master_id = ?'
    )
    .all(orgId, masterId);
}

/**
 * Save (or update) one org's override for a single section. The section key must exist on the
 * master's current section list — this is what stops a stale/typo'd key from silently never
 * being applied at render time.
 * @param {string} orgId
 * @param {string} masterId
 * @param {string} sectionKey
 * @param {string} contentHtml
 * @param {string|null} [updatedBy]
 */
export function upsertOrgSectionOverride(orgId, masterId, sectionKey, contentHtml, updatedBy = null) {
  const sections = getMasterSections(masterId);
  if (!sections.some((s) => s.key === sectionKey)) {
    throw new Error(`Unknown section_key "${sectionKey}" for master ${masterId}`);
  }
  if (typeof contentHtml !== 'string' || !contentHtml.trim()) {
    throw new Error('content_html is required');
  }
  db.prepare(`
    INSERT INTO document_library_org_section_overrides (id, org_id, master_id, section_key, content_html, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(org_id, master_id, section_key) DO UPDATE SET
      content_html = excluded.content_html,
      updated_at = datetime('now'),
      updated_by = excluded.updated_by
  `).run(uuidv4(), orgId, masterId, sectionKey, contentHtml, updatedBy);
}

/**
 * Revert one section back to the master's own content.
 * @param {string} orgId
 * @param {string} masterId
 * @param {string} sectionKey
 */
export function deleteOrgSectionOverride(orgId, masterId, sectionKey) {
  db.prepare(
    'DELETE FROM document_library_org_section_overrides WHERE org_id = ? AND master_id = ? AND section_key = ?'
  ).run(orgId, masterId, sectionKey);
}

/**
 * Switch an org's clone between inheriting the master as-is, overriding individual sections, or
 * fully replacing the document with their own upload. Creates the clone row if it doesn't exist
 * yet (mirrors `cloneLibraryMasterToOrg`).
 * @param {string} orgId
 * @param {string} masterId
 * @param {'inherit'|'sections'|'full_upload'} mode
 */
export function setOrgCloneOverrideMode(orgId, masterId, mode) {
  if (!VALID_OVERRIDE_MODES.has(mode)) {
    throw new Error(`mode must be one of: ${[...VALID_OVERRIDE_MODES].join(', ')}`);
  }
  cloneLibraryMasterToOrg(masterId, orgId);
  db.prepare(`
    UPDATE document_library_org_clones
    SET override_mode = ?, updated_at = datetime('now')
    WHERE master_id = ? AND org_id = ?
  `).run(mode, masterId, orgId);
}

/**
 * The org's fully-uploaded replacement document for a master, if `override_mode` is
 * `full_upload`. Repurposes the (previously unused) `org_company_documents` table.
 * @param {string} orgId
 * @param {string} masterId
 * @returns {object|null}
 */
export function getOrgFullUploadDocument(orgId, masterId) {
  return db
    .prepare('SELECT * FROM org_company_documents WHERE org_id = ? AND library_master_id = ?')
    .get(orgId, masterId) || null;
}

/**
 * Store an org's fully-uploaded replacement document for a master.
 * @param {object} params
 * @param {string} params.orgId
 * @param {string} params.masterId
 * @param {string} params.filePath - relative path, same convention as `company_policy_files.file_path`
 * @param {string} params.originalFilename
 * @param {string} params.mime
 */
export function upsertOrgFullUploadDocument({ orgId, masterId, filePath, originalFilename, mime }) {
  const master = db.prepare('SELECT slug, display_name, category FROM document_library_masters WHERE id = ?').get(masterId);
  if (!master) throw new Error('Master not found');
  const engine = mime === 'application/pdf' ? 'static-pdf' : 'docxtemplater';
  const existing = db.prepare('SELECT id FROM org_company_documents WHERE org_id = ? AND slug = ?').get(orgId, master.slug);
  if (existing) {
    db.prepare(`
      UPDATE org_company_documents
      SET engine = ?, template_filename = ?, file_path = ?, source = 'upload', library_master_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(engine, originalFilename, filePath, masterId, existing.id);
    return existing.id;
  }
  const id = uuidv4();
  db.prepare(`
    INSERT INTO org_company_documents (id, org_id, slug, display_name, category, engine, template_filename, file_path, source, library_master_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'upload', ?, datetime('now'), datetime('now'))
  `).run(id, orgId, master.slug, master.display_name, master.category || 'policy', engine, originalFilename, filePath, masterId);
  return id;
}

function enrichLibraryMasterRow(row) {
  let manifest = {};
  try {
    manifest = row.manifest_json ? JSON.parse(row.manifest_json) : {};
  } catch {
    /* ignore malformed manifest */
  }
  const packs = normalizeManifestPacks(manifest);
  let sectionCount = 0;
  if (row.sections_json) {
    try {
      sectionCount = JSON.parse(row.sections_json).length;
    } catch {
      sectionCount = 0;
    }
  }
  const { sections_json, ...rest } = row;
  return {
    ...rest,
    packs,
    pack: packs[0] || manifest.pack || null,
    signature_count: Number(manifest.signature_count) || 0,
    category: row.category || manifest.category || null,
    required_signer_role: row.required_signer_role ?? manifest.required_signer_role ?? null,
    participant_service_types: manifest.participant_service_types || ['all'],
    staff_roles: manifest.staff_roles || ['all'],
    section_count: sectionCount,
    override_mode: row.override_mode || 'inherit'
  };
}

/**
 * Return all library masters with their per-org clone (if any) for the supplied orgId.
 * Used by the master library admin page and the per-org documents page.
 *
 * @param {string|null} orgId
 */
export function listLibraryMasters(orgId = null) {
  const rows = db.prepare(`
    SELECT m.*,
           c.id as clone_id,
           c.is_active as clone_active,
           c.variable_overrides_json,
           c.override_mode
    FROM document_library_masters m
    LEFT JOIN document_library_org_clones c ON c.master_id = m.id AND c.org_id = ?
    WHERE m.is_active = 1
    ORDER BY m.category, m.display_name
  `).all(orgId);
  return rows.map(enrichLibraryMasterRow);
}

function updateCataloguePacks(slug, packs) {
  const cataloguePath = join(defaultLibraryRoot, '_catalogue.json');
  if (!existsSync(cataloguePath)) return;
  let catalogue;
  try {
    catalogue = JSON.parse(readFileSync(cataloguePath, 'utf8'));
  } catch (err) {
    throw new Error(`_catalogue.json invalid JSON: ${err.message}`);
  }
  if (!Array.isArray(catalogue)) return;
  const idx = catalogue.findIndex((entry) => entry?.slug === slug);
  if (idx < 0) return;
  applyPacksToManifest(catalogue[idx], packs);
  writeFileSync(cataloguePath, `${JSON.stringify(catalogue, null, 2)}\n`);
}

/**
 * Change a master's automation packs. Updates manifest.json on disk, the catalogue index,
 * and the DB manifest_json row. Affects all organisations (global master change).
 *
 * @param {string} masterId
 * @param {string[]} packs
 */
export function updateLibraryMasterPacks(masterId, packs) {
  const validated = validateLibraryPacks(packs);
  const master = db.prepare('SELECT * FROM document_library_masters WHERE id = ? AND is_active = 1').get(masterId);
  if (!master) throw new Error('Master not found');

  const slug = master.slug;
  const manifestPath = join(defaultLibraryRoot, slug, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json not found on disk for ${slug}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`manifest.json invalid JSON: ${err.message}`);
  }
  applyPacksToManifest(manifest, validated);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  updateCataloguePacks(slug, validated);

  db.prepare(`
    UPDATE document_library_masters
    SET manifest_json = ?, updated_at = datetime('now'), last_synced_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(manifest), masterId);

  const updated = db.prepare('SELECT * FROM document_library_masters WHERE id = ?').get(masterId);
  return enrichLibraryMasterRow(updated);
}

/**
 * @deprecated Use updateLibraryMasterPacks — kept for backward-compatible single-pack updates.
 * @param {string} masterId
 * @param {string} pack
 */
export function updateLibraryMasterPack(masterId, pack) {
  return updateLibraryMasterPacks(masterId, [pack]);
}

export { ONBOARDING_PACKS, EXCLUSIVE_PACKS };

function writeManifestToDisk(slug, manifest) {
  const manifestPath = join(defaultLibraryRoot, slug, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json not found on disk for ${slug}`);
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Update contextual tags on a master (service types / staff roles).
 * @param {string} masterId
 * @param {{ participant_service_types?: string[], staff_roles?: string[] }} tags
 */
export function updateLibraryMasterContextTags(masterId, tags = {}) {
  const master = db.prepare('SELECT * FROM document_library_masters WHERE id = ? AND is_active = 1').get(masterId);
  if (!master) throw new Error('Master not found');

  const slug = master.slug;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(defaultLibraryRoot, slug, 'manifest.json'), 'utf8'));
  } catch (err) {
    throw new Error(`manifest.json invalid JSON: ${err.message}`);
  }

  if (tags.participant_service_types != null) {
    if (!Array.isArray(tags.participant_service_types)) {
      throw new Error('participant_service_types must be an array');
    }
    const bad = tags.participant_service_types.filter((t) => !VALID_PARTICIPANT_SERVICE_TYPES.has(t));
    if (bad.length) throw new Error(`invalid participant_service_types: ${bad.join(', ')}`);
    manifest.participant_service_types = tags.participant_service_types;
  }
  if (tags.staff_roles != null) {
    if (!Array.isArray(tags.staff_roles)) {
      throw new Error('staff_roles must be an array');
    }
    const bad = tags.staff_roles.filter((t) => !VALID_STAFF_ONBOARDING_ROLES.has(t));
    if (bad.length) throw new Error(`invalid staff_roles: ${bad.join(', ')}`);
    manifest.staff_roles = tags.staff_roles;
  }

  const validation = validateManifest(manifest, slug);
  if (validation.error) throw new Error(validation.error);

  writeManifestToDisk(slug, manifest);
  db.prepare(`
    UPDATE document_library_masters
    SET manifest_json = ?, updated_at = datetime('now'), last_synced_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(manifest), masterId);

  const updated = db.prepare('SELECT * FROM document_library_masters WHERE id = ?').get(masterId);
  return enrichLibraryMasterRow(updated);
}
