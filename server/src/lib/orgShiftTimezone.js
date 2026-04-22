/**
 * Resolves the org "schedule" timezone spec used to interpret naive shift datetimes
 * (same rules as Shifter mirror + shift display). Extracted for reuse by shifts routes,
 * learning/anomalies, and availability checks.
 */
import { db } from '../db/index.js';
import { getShifterOrgTimezoneSpecForNexusOrg } from '../services/supabaseStaffShifter.service.js';
import { normalizeOrgTimezoneRaw } from './shiftTimezone.js';

/**
 * @param {string|undefined} userId
 * @returns {Promise<{ kind: 'iana', zone: string } | { kind: 'fixed', offsetMinutes: number }>}
 */
export async function getEffectiveOrgTzSpecForUser(userId) {
  const u = userId ? db.prepare('SELECT org_id FROM users WHERE id = ?').get(userId) : null;
  const orgId = u?.org_id || null;
  let spec = orgId ? await getShifterOrgTimezoneSpecForNexusOrg(orgId) : null;
  if (!spec) spec = normalizeOrgTimezoneRaw(process.env.NEXUS_SHIFT_TIMEZONE_FALLBACK);
  if (!spec) spec = { kind: 'iana', zone: 'Australia/Sydney' };
  return spec;
}
