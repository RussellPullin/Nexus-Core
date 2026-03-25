import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';

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
    ? db.prepare('SELECT id, name, email FROM organisations WHERE owner_org_id = ?').all(ownerOrgId)
    : db.prepare('SELECT id, name, email FROM organisations').all();
  const orgByName = {};
  const orgByEmail = {};
  for (const o of orgs) {
    if (o.name) orgByName[o.name.toLowerCase().trim()] = o.id;
    if (o.email) orgByEmail[o.email.toLowerCase().trim()] = o.id;
  }
  return { orgByName, orgByEmail };
}
