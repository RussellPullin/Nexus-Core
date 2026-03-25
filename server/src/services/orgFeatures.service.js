import { db } from '../db/index.js';
import { FEATURE_FLAG_KEYS, isKnownFeatureKey, listFeatureFlagKeys } from '../config/featureFlags.js';
import { getSupabaseServiceRoleClient } from './supabaseStaffShifter.service.js';

function emptyFlagsMap() {
  const flags = {};
  for (const k of listFeatureFlagKeys()) flags[k] = false;
  return flags;
}

/**
 * @param {string | null | undefined} orgId
 * @returns {Promise<{ configured: boolean, flags: Record<string, boolean> }>}
 */
export async function fetchFlagsForOrg(orgId) {
  const admin = getSupabaseServiceRoleClient();
  if (!admin) {
    return { configured: false, flags: emptyFlagsMap() };
  }
  if (!orgId) {
    return { configured: true, flags: emptyFlagsMap() };
  }

  const keys = listFeatureFlagKeys();
  const { data, error } = await admin
    .from('org_features')
    .select('feature_key, enabled')
    .eq('org_id', orgId)
    .in('feature_key', keys);

  if (error) {
    const err = new Error(error.message || 'org_features query failed');
    err.code = 'SUPABASE_ORG_FEATURES';
    throw err;
  }

  const flags = emptyFlagsMap();
  for (const row of data || []) {
    if (row?.feature_key && keys.includes(row.feature_key)) {
      flags[row.feature_key] = Boolean(row.enabled);
    }
  }
  return { configured: true, flags };
}

/**
 * @returns {Promise<{ orgs: { id: string, name: string }[], feature_defs: { key: string, label: string }[], matrix: Record<string, Record<string, boolean>> }>}
 */
export async function fetchOrgFeatureMatrix() {
  const admin = getSupabaseServiceRoleClient();
  const orgs = db.prepare('SELECT id, name FROM organisations ORDER BY name COLLATE NOCASE').all();

  const feature_defs = FEATURE_FLAG_KEYS.map(({ key, label }) => ({ key, label: label || key }));
  const matrix = {};

  for (const o of orgs) {
    matrix[o.id] = emptyFlagsMap();
  }

  if (!admin || orgs.length === 0) {
    return { orgs, feature_defs, matrix };
  }

  const orgIds = orgs.map((o) => o.id);
  const { data, error } = await admin
    .from('org_features')
    .select('org_id, feature_key, enabled')
    .in('org_id', orgIds)
    .in('feature_key', listFeatureFlagKeys());

  if (error) {
    const err = new Error(error.message || 'org_features matrix query failed');
    err.code = 'SUPABASE_ORG_FEATURES';
    throw err;
  }

  for (const row of data || []) {
    const oid = row.org_id;
    const fk = row.feature_key;
    if (matrix[oid] && fk in matrix[oid]) {
      matrix[oid][fk] = Boolean(row.enabled);
    }
  }

  return { orgs, feature_defs, matrix };
}

/**
 * @param {string} orgId
 * @param {string} featureKey
 * @param {boolean} enabled
 */
export async function upsertOrgFeature(orgId, featureKey, enabled) {
  if (!isKnownFeatureKey(featureKey)) {
    const err = new Error('Unknown feature_key');
    err.code = 'UNKNOWN_FEATURE_KEY';
    throw err;
  }

  const org = db.prepare('SELECT id FROM organisations WHERE id = ?').get(orgId);
  if (!org) {
    const err = new Error('Organisation not found');
    err.code = 'ORG_NOT_FOUND';
    throw err;
  }

  const admin = getSupabaseServiceRoleClient();
  if (!admin) {
    const err = new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    err.code = 'SUPABASE_NOT_CONFIGURED';
    throw err;
  }

  const { error } = await admin.from('org_features').upsert(
    { org_id: orgId, feature_key: featureKey, enabled: Boolean(enabled) },
    { onConflict: 'org_id,feature_key' }
  );

  if (error) {
    const err = new Error(error.message || 'org_features upsert failed');
    err.code = 'SUPABASE_ORG_FEATURES';
    throw err;
  }

  return { org_id: orgId, feature_key: featureKey, enabled: Boolean(enabled) };
}
