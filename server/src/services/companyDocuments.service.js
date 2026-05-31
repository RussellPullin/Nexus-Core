/**
 * Per-organisation company document library — bulk upload, OneDrive import, and links to
 * the global master document library.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { join, resolve, dirname, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { ensureProviderProfile } from './onboarding.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');

const VALID_CATEGORIES = new Set(['policy', 'procedure', 'register', 'contract', 'form', 'guide']);
const VALID_ENGINES = new Set(['static-pdf', 'docxtemplater', 'pdf-acroform', 'html']);
const ALLOWED_EXT = new Set(['.pdf', '.docx', '.html']);

export function companyDocsRoot(orgId) {
  return join(projectRoot, 'data', 'forms', 'company-docs', orgId);
}

export function slugifyName(name) {
  const base = String(name || 'document')
    .replace(/\.(pdf|docx|html|doc)$/i, '')
    .trim();
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return slug || 'document';
}

export function inferCategory(filename, override) {
  if (override && VALID_CATEGORIES.has(override)) return override;
  const n = String(filename || '').toLowerCase();
  if (n.includes('register')) return 'register';
  if (n.includes('procedure') || n.includes('sop')) return 'procedure';
  if (n.includes('contract') || n.includes('employment')) return 'contract';
  if (n.includes('intake') || n.includes('form')) return 'form';
  if (n.includes('guide') || n.includes('handbook')) return 'guide';
  if (n.includes('policy')) return 'policy';
  return 'policy';
}

export function inferEngine(filename) {
  const ext = extname(String(filename || '')).toLowerCase();
  if (ext === '.docx') return 'docxtemplater';
  if (ext === '.html') return 'html';
  if (ext === '.pdf') return 'static-pdf';
  return 'static-pdf';
}

function parseProviderConfig(profile) {
  if (!profile?.config_json) return {};
  try {
    return typeof profile.config_json === 'object' ? profile.config_json : JSON.parse(profile.config_json);
  } catch {
    return {};
  }
}

export function getCompanyDocumentSettings(orgId) {
  const profile = ensureProviderProfile(orgId);
  const config = parseProviderConfig(profile);
  const docs = config.company_documents || {};
  return {
    auto_sync_policies_to_onboarding: docs.auto_sync_policies_to_onboarding !== false,
    default_sync_to_onboarding: docs.default_sync_to_onboarding !== false
  };
}

export function setCompanyDocumentSettings(orgId, partial) {
  const profile = ensureProviderProfile(orgId);
  const config = parseProviderConfig(profile);
  config.company_documents = {
    ...(config.company_documents || {}),
    ...partial
  };
  db.prepare(`UPDATE provider_profiles SET config_json = ?, updated_at = datetime('now') WHERE id = ?`).run(
    JSON.stringify(config),
    profile.id
  );
  return getCompanyDocumentSettings(orgId);
}

export function listOrgCompanyDocuments(orgId) {
  return db
    .prepare(
      `
    SELECT d.*,
           m.display_name AS master_display_name,
           m.slug AS master_slug,
           pf.display_name AS policy_display_name
    FROM org_company_documents d
    LEFT JOIN document_library_masters m ON m.id = d.library_master_id
    LEFT JOIN company_policy_files pf ON pf.id = d.company_policy_file_id
    WHERE d.org_id = ?
    ORDER BY d.category ASC, d.display_name COLLATE NOCASE ASC
  `
    )
    .all(orgId);
}

function uniqueSlug(orgId, baseSlug) {
  let slug = baseSlug;
  let n = 2;
  while (db.prepare('SELECT id FROM org_company_documents WHERE org_id = ? AND slug = ?').get(orgId, slug)) {
    slug = `${baseSlug}-${n}`;
    n += 1;
  }
  return slug;
}

function relPathFromAbs(absPath) {
  return absPath.replace(`${projectRoot}/`, '').replace(/\\/g, '/');
}

/**
 * @param {string} orgId
 * @param {{ originalname: string, buffer: Buffer, mimetype?: string }} file
 * @param {{ category?: string, sync_to_onboarding?: boolean, display_name?: string, source?: string, onedrive_item_id?: string, onedrive_path?: string }} opts
 */
export function ingestCompanyDocumentFile(orgId, file, opts = {}) {
  const original = String(file.originalname || 'document').replace(/[/\\]/g, '_');
  const ext = extname(original).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`Unsupported file type "${ext}". Use .pdf, .docx, or .html.`);
  }
  if (!file.buffer?.length) throw new Error('Empty file.');

  const settings = getCompanyDocumentSettings(orgId);
  const displayName = (opts.display_name || original.replace(/\.(pdf|docx|html)$/i, '') || 'Document').trim();
  const category = inferCategory(original, opts.category);
  const engine = inferEngine(original);
  const slug = uniqueSlug(orgId, slugifyName(displayName));
  const sync =
    opts.sync_to_onboarding != null
      ? Boolean(opts.sync_to_onboarding)
      : settings.default_sync_to_onboarding && (category === 'policy' || category === 'procedure');

  const dir = join(companyDocsRoot(orgId), slug);
  mkdirSync(dir, { recursive: true });
  const templateFilename = `template${ext}`;
  const absPath = join(dir, templateFilename);
  writeFileSync(absPath, file.buffer);

  const id = uuidv4();
  const rel = relPathFromAbs(absPath);
  db.prepare(
    `
    INSERT INTO org_company_documents (
      id, org_id, slug, display_name, category, engine, template_filename, file_path,
      source, library_master_id, onedrive_item_id, onedrive_path, sync_to_onboarding,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, datetime('now'), datetime('now'))
  `
  ).run(
    id,
    orgId,
    slug,
    displayName,
    category,
    engine,
    templateFilename,
    rel,
    opts.source || 'upload',
    opts.onedrive_item_id || null,
    opts.onedrive_path || null,
    sync ? 1 : 0
  );

  return db.prepare('SELECT * FROM org_company_documents WHERE id = ?').get(id);
}

/**
 * Bulk ingest from multer files or zip buffer.
 */
export function ingestCompanyDocumentBatch(orgId, files, options = {}) {
  const results = { imported: [], skipped: [], errors: [] };
  const defaultCategory = options.category || null;
  const defaultSync = options.sync_to_onboarding;

  for (const file of files || []) {
    try {
      const row = ingestCompanyDocumentFile(orgId, file, {
        category: defaultCategory || undefined,
        sync_to_onboarding: defaultSync,
        source: options.source || 'upload'
      });
      results.imported.push({ id: row.id, slug: row.slug, display_name: row.display_name });
    } catch (e) {
      results.errors.push({ file: file.originalname, error: e.message });
    }
  }
  return results;
}

export function ingestCompanyDocumentZip(orgId, zipBuffer, options = {}) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter((e) => !e.isDirectory && !e.entryName.startsWith('__MACOSX'));
  const files = [];
  for (const entry of entries) {
    const name = basename(entry.entryName);
    const ext = extname(name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) continue;
    files.push({ originalname: name, buffer: entry.getData() });
  }
  if (!files.length) throw new Error('ZIP contains no .pdf, .docx, or .html files.');
  return ingestCompanyDocumentBatch(orgId, files, { ...options, source: options.source || 'upload' });
}

export function updateOrgCompanyDocument(orgId, docId, patch) {
  const row = db.prepare('SELECT * FROM org_company_documents WHERE id = ? AND org_id = ?').get(docId, orgId);
  if (!row) return null;

  const displayName = patch.display_name != null ? String(patch.display_name).trim() : row.display_name;
  const category = patch.category != null ? String(patch.category) : row.category;
  if (!displayName) throw new Error('display_name cannot be empty');
  if (!VALID_CATEGORIES.has(category)) throw new Error('Invalid category');

  const sync =
    patch.sync_to_onboarding != null ? (patch.sync_to_onboarding ? 1 : 0) : row.sync_to_onboarding;

  db.prepare(
    `
    UPDATE org_company_documents
    SET display_name = ?, category = ?, sync_to_onboarding = ?, updated_at = datetime('now')
    WHERE id = ? AND org_id = ?
  `
  ).run(displayName, category, sync, docId, orgId);

  return db.prepare('SELECT * FROM org_company_documents WHERE id = ?').get(docId);
}

export function deleteOrgCompanyDocument(orgId, docId) {
  const row = db.prepare('SELECT * FROM org_company_documents WHERE id = ? AND org_id = ?').get(docId, orgId);
  if (!row) return false;

  if (row.company_policy_file_id) {
    const pf = db
      .prepare('SELECT id, file_path FROM company_policy_files WHERE id = ?')
      .get(row.company_policy_file_id);
    if (pf) {
      db.prepare('DELETE FROM onboarding_document_pack_items WHERE policy_file_id = ?').run(pf.id);
      db.prepare('DELETE FROM company_policy_files WHERE id = ?').run(pf.id);
      const full = join(projectRoot, pf.file_path);
      if (existsSync(full)) {
        try {
          unlinkSync(full);
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (row.source !== 'library_master' && row.file_path) {
    const dir = dirname(join(projectRoot, row.file_path));
    if (existsSync(dir)) {
      try {
        for (const name of readdirSync(dir)) {
          unlinkSync(join(dir, name));
        }
        unlinkSync(dir);
      } catch {
        /* ignore */
      }
    }
  }

  db.prepare('DELETE FROM org_company_documents WHERE id = ?').run(docId);
  return true;
}

export function getOrgCompanyDocumentFile(orgId, docId) {
  const row = db.prepare('SELECT * FROM org_company_documents WHERE id = ? AND org_id = ?').get(docId, orgId);
  if (!row) return null;
  if (row.library_master_id) {
    const master = db.prepare('SELECT template_file_path FROM document_library_masters WHERE id = ?').get(row.library_master_id);
    if (master?.template_file_path && existsSync(master.template_file_path)) {
      return { row, absPath: master.template_file_path };
    }
  }
  const absPath = join(projectRoot, row.file_path);
  if (!existsSync(absPath)) return { row, absPath: null };
  return { row, absPath };
}

/**
 * Ensure org_company_documents rows exist for every library master cloned to this org.
 */
export function mirrorLibraryMastersToOrgDocuments(orgId) {
  const settings = getCompanyDocumentSettings(orgId);
  const masters = db
    .prepare(
      `
    SELECT m.*
    FROM document_library_masters m
    INNER JOIN document_library_org_clones c ON c.master_id = m.id AND c.org_id = ?
    WHERE m.is_active = 1
  `
    )
    .all(orgId);

  let created = 0;
  let updated = 0;

  for (const master of masters) {
    const existing = db
      .prepare('SELECT id FROM org_company_documents WHERE org_id = ? AND library_master_id = ?')
      .get(orgId, master.id);

    const syncDefault =
      settings.default_sync_to_onboarding && (master.category === 'policy' || master.category === 'procedure');

    if (existing?.id) {
      db.prepare(
        `UPDATE org_company_documents SET display_name = ?, category = ?, engine = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(master.display_name, master.category || 'policy', master.engine, existing.id);
      updated += 1;
      continue;
    }

    const slug = uniqueSlug(orgId, master.slug);
    const id = uuidv4();
    db.prepare(
      `
      INSERT INTO org_company_documents (
        id, org_id, slug, display_name, category, engine, template_filename, file_path,
        source, library_master_id, sync_to_onboarding, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'library_master', ?, ?, datetime('now'), datetime('now'))
    `
    ).run(
      id,
      orgId,
      slug,
      master.display_name,
      master.category || 'policy',
      master.engine,
      basename(master.template_file_path),
      relPathFromAbs(master.template_file_path),
      master.id,
      syncDefault ? 1 : 0
    );
    created += 1;
  }

  return { created, updated, total: masters.length };
}

export { projectRoot, VALID_CATEGORIES, relPathFromAbs };
