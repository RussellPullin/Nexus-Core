import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';

/** True for the Nexus tenant anchor row (same id as owner_org_id), not a directory / external org. */
export function isTenantAnchorRow(row) {
  return Boolean(row?.owner_org_id && row.id === row.owner_org_id);
}

/**
 * participants.provider_org_id FK → organisations(id). Auth may set users.org_id to a Supabase
 * org UUID before that id exists locally — inserts/updates on participants then fail.
 */
export function ensureOrganisationExistsById(orgId, opts = {}) {
  if (!orgId || String(orgId).trim() === '') return;
  const id = String(orgId).trim();
  if (db.prepare('SELECT 1 FROM organisations WHERE id = ?').get(id)) return;
  const name = (opts.name && String(opts.name).trim()) || 'Provider organisation';
  const type = (opts.type && String(opts.type).trim()) || 'provider';
  db.prepare(`
    INSERT INTO organisations (id, owner_org_id, name, type, email, created_at, updated_at)
    VALUES (?, NULL, ?, ?, NULL, datetime('now'), datetime('now'))
  `).run(id, name, type);
}

/**
 * Find or create a plan manager organisation by name/email.
 * Returns org id or null. Mutates orgByName and orgByEmail with new entries.
 */
export function ensurePlanManagerOrg(orgByName, orgByEmail, name, email, ownerOrgId = null) {
  if (!name && !email) return null;
  const emailKey = email ? email.toLowerCase().trim() : null;
  const nameKey = name ? name.toLowerCase().trim() : null;
  if (emailKey && orgByEmail[emailKey]) return orgByEmail[emailKey];
  if (nameKey && orgByName[nameKey]) return orgByName[nameKey];
  const newId = uuidv4();
  db.prepare(`
    INSERT INTO organisations (id, owner_org_id, name, type, email)
    VALUES (?, ?, ?, 'plan_manager', ?)
  `).run(newId, ownerOrgId || null, name || email || 'Unknown', email || null);
  if (nameKey) orgByName[nameKey] = newId;
  if (emailKey) orgByEmail[emailKey] = newId;
  return newId;
}

/** Build org lookup maps from organisations table. */
export function buildOrgLookupMaps(ownerOrgId = null) {
  const orgs = ownerOrgId
    ? db
        .prepare(
          'SELECT id, name, email FROM organisations WHERE owner_org_id = ? AND id != owner_org_id'
        )
        .all(ownerOrgId)
    : db
        .prepare('SELECT id, name, email FROM organisations WHERE owner_org_id IS NULL OR id != owner_org_id')
        .all();
  const orgByName = {};
  const orgByEmail = {};
  for (const o of orgs) {
    if (o.name) orgByName[o.name.toLowerCase().trim()] = o.id;
    if (o.email) orgByEmail[o.email.toLowerCase().trim()] = o.id;
  }
  return { orgByName, orgByEmail };
}
