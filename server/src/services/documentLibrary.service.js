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

function enrichLibraryMasterRow(row) {
  let manifest = {};
  try {
    manifest = row.manifest_json ? JSON.parse(row.manifest_json) : {};
  } catch {
    /* ignore malformed manifest */
  }
  const packs = normalizeManifestPacks(manifest);
  return {
    ...row,
    packs,
    pack: packs[0] || manifest.pack || null,
    signature_count: Number(manifest.signature_count) || 0,
    category: row.category || manifest.category || null,
    required_signer_role: row.required_signer_role ?? manifest.required_signer_role ?? null,
    participant_service_types: manifest.participant_service_types || ['all'],
    staff_roles: manifest.staff_roles || ['all']
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
           c.variable_overrides_json
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
