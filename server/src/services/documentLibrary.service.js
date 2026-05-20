/**
 * Phase 1: File-based master document library.
 *
 * Authors drop a deidentified document into:
 *   data/forms/templates/library/<slug>/
 *     ├─ template.docx              (or .pdf, .html – per `engine`)
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
 *   "template_file": "template.docx",
 *   "placeholders": ["org.legal_name", "org.abn", "org.signatory.name", "today_long"],
 *   "required_signer_role": "participant",       // optional
 *   "renewal_days": 365                          // optional
 * }
 *
 * On boot (or on demand) we walk the library, validate each manifest, and upsert into
 * `document_library_masters`. From there each org can clone into its own row via
 * `cloneLibraryMasterToOrg(masterId, orgId)`.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { unknownPlaceholders } from '../lib/templateTokens.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const defaultLibraryRoot = process.env.DOCUMENT_LIBRARY_DIR
  || join(projectRoot, 'data', 'forms', 'templates', 'library');

const VALID_ENGINES = new Set(['docxtemplater', 'pdf-acroform', 'html']);
const VALID_CATEGORIES = new Set(['policy', 'procedure', 'register', 'contract', 'form', 'guide']);

/**
 * @param {string} [rootDir]
 * @returns {{ scanned: number, registered: number, skipped: {slug:string, reason:string}[], warnings: string[] }}
 */
export function syncDocumentLibraryFromDisk(rootDir = defaultLibraryRoot) {
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
      required_signer_role, renewal_days, is_active, last_synced_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'), datetime('now'))
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
      is_active = 1,
      last_synced_at = datetime('now'),
      updated_at = datetime('now')
  `);

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
    const templateFilePath = join(dirPath, manifest.template_file);
    if (!existsSync(templateFilePath)) {
      result.skipped.push({ slug: manifest.slug, reason: `template_file not found: ${manifest.template_file}` });
      continue;
    }

    const unknown = unknownPlaceholders(manifest.placeholders || []);
    if (unknown.length) {
      result.warnings.push(`[${manifest.slug}] unknown placeholders ignored: ${unknown.join(', ')}`);
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
      Number.isFinite(manifest.renewal_days) ? manifest.renewal_days : null
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

/**
 * Return all library masters with their per-org clone (if any) for the supplied orgId.
 * Used by the master library admin page and the per-org documents page.
 *
 * @param {string|null} orgId
 */
export function listLibraryMasters(orgId = null) {
  return db.prepare(`
    SELECT m.*,
           c.id as clone_id,
           c.is_active as clone_active,
           c.variable_overrides_json
    FROM document_library_masters m
    LEFT JOIN document_library_org_clones c ON c.master_id = m.id AND c.org_id = ?
    ORDER BY m.category, m.display_name
  `).all(orgId);
}
