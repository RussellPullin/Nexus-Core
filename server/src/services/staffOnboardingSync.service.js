/**
 * Maps staff_intake_fields (flat key/value) onto canonical staff row columns.
 */

import { db } from '../db/index.js';

/** Flat map staff_intake_fields rows → key/value for hydrating forms and profile sync */
export function getStaffIntakeFieldMap(staffOnboardingId) {
  const rows = db.prepare('SELECT field_key, field_value FROM staff_intake_fields WHERE staff_onboarding_id = ?').all(staffOnboardingId);
  const m = {};
  for (const r of rows) m[r.field_key] = r.field_value;
  return m;
}
import { composeStaffDisplayName } from '../../../shared/onboardingFieldRegistry.js';

function cleanStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function parseHourlyRate(raw) {
  if (raw == null || raw === '') return null;
  const n = parseFloat(String(raw).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function composeAddress(intakeMap) {
  const address = cleanStr(intakeMap?.address);
  if (address) return address;
  return [
    cleanStr(intakeMap?.street_address),
    cleanStr(intakeMap?.suburb_city),
    cleanStr(intakeMap?.state),
    cleanStr(intakeMap?.postcode)
  ].filter(Boolean).join(', ');
}

/**
 * Merge normalized personal + intake map (same shape as client onboarding hydration).
 * @param {Record<string, string>} intakeMap
 * @param {string} [staffNameFallback]
 */
export function mergeStaffIntakeForProfile(intakeMap, staffNameFallback = '') {
  const m = { ...(intakeMap || {}) };
  const legacyFull = cleanStr(m.full_name);
  let first = cleanStr(m.first_name);
  let last = cleanStr(m.last_name);
  if (!first && !last && legacyFull) {
    const p = legacyFull.split(/\s+/);
    first = p[0] || '';
    last = p.slice(1).join(' ') || '';
  }
  if (!first && !last && staffNameFallback && !legacyFull) {
    const p = cleanStr(staffNameFallback).split(/\s+/);
    first = p[0] || '';
    last = p.slice(1).join(' ') || '';
  }
  let fullLegal = cleanStr(m.full_legal_name);
  if (!fullLegal && legacyFull && !m.full_legal_name) fullLegal = legacyFull;
  return {
    ...m,
    first_name: first,
    last_name: last,
    full_legal_name: fullLegal,
    date_of_birth: m.date_of_birth || '',
    address: composeAddress(m),
    phone: m.phone || '',
    emergency_contact_name: m.emergency_contact_name || '',
    emergency_contact_phone: m.emergency_contact_phone || ''
  };
}

/**
 * Apply intake values to the staff table (profile register).
 * @param {string} staffId
 * @param {Record<string, string>} intakeMap - raw + merged keys ok
 * @param {{ onlyKeys?: Set<string> }} [options] - if set, only update these logical fields
 */
export function applyStaffIntakeToStaffRow(staffId, intakeMap, options = {}) {
  const merged = mergeStaffIntakeForProfile(intakeMap);
  const only = options.onlyKeys;

  const want = (field) => !only || only.has(field);

  const displayName = composeStaffDisplayName({
    first_name: merged.first_name,
    last_name: merged.last_name,
    full_legal_name: merged.full_legal_name,
    full_name: merged.full_name
  });

  const updates = [];
  const vals = [];

  if (want('name') && displayName) {
    updates.push('name = ?');
    vals.push(displayName);
  }
  if (want('phone')) {
    updates.push('phone = ?');
    vals.push(cleanStr(merged.phone));
  }
  if (want('address')) {
    updates.push('address = ?');
    vals.push(cleanStr(merged.address));
  }
  if (want('date_of_birth')) {
    updates.push('date_of_birth = ?');
    vals.push(cleanStr(merged.date_of_birth).slice(0, 32));
  }
  if (want('emergency_contact_name')) {
    updates.push('emergency_contact_name = ?');
    vals.push(cleanStr(merged.emergency_contact_name));
  }
  if (want('emergency_contact_phone')) {
    updates.push('emergency_contact_phone = ?');
    vals.push(cleanStr(merged.emergency_contact_phone));
  }
  if (want('role')) {
    updates.push('role = ?');
    vals.push(cleanStr(merged.role));
  }
  if (want('employment_type')) {
    const et = cleanStr(merged.employment_type);
    updates.push('employment_type = ?');
    vals.push(et || 'employee');
  }
  if (want('hourly_rate')) {
    const hr = parseHourlyRate(merged.hourly_rate);
    updates.push('hourly_rate = ?');
    vals.push(hr != null ? hr : null);
  }
  if (want('abn')) {
    updates.push('abn = ?');
    vals.push(cleanStr(merged.abn));
  }

  if (!updates.length) return true;

  vals.push(staffId);
  db.prepare(`UPDATE staff SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals);
  return true;
}
