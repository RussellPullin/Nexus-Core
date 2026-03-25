import bcrypt from 'bcrypt';
import { db } from '../db/index.js';
import { isSuperAdminEmail } from '../lib/superAdmin.js';
import { verifySupabaseAccessToken } from '../lib/supabaseJwt.js';
import { getSupabaseServiceRoleClient } from './supabaseStaffShifter.service.js';

const PLACEHOLDER_PW = '\x00NEXUS_SUPABASE_AUTH\x00';

export function mapProfileRoleToSqliteRole(profileRole) {
  const r = String(profileRole || '').trim();
  if (r === 'Admin' || r === 'Manager') return 'admin';
  return 'support_coordinator';
}

export async function fetchSupabaseProfile(userId) {
  const admin = getSupabaseServiceRoleClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from('profiles')
    .select('id, email, org_id, role, shifter_enabled')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    console.warn('[nexusSupabaseAuth] profile fetch', error.message);
    return null;
  }
  return data;
}

export async function fetchSupabaseProfileByEmail(email) {
  const admin = getSupabaseServiceRoleClient();
  if (!admin) return null;
  const norm = String(email || '').trim().toLowerCase();
  if (!norm) return null;
  const { data, error } = await admin
    .from('profiles')
    .select('id, email, org_id, role, shifter_enabled')
    .eq('email', norm)
    .maybeSingle();
  if (error) {
    console.warn('[nexusSupabaseAuth] profile fetch by email', error.message);
    return null;
  }
  return data;
}

/**
 * Link or create SQLite users row for a Supabase identity.
 */
export function upsertSqliteUserFromSupabase({ sub, email, profile }) {
  const emailNorm = String(email || profile?.email || '').trim().toLowerCase();
  if (!emailNorm) {
    const err = new Error('Email missing from token or profile');
    err.code = 'NO_EMAIL';
    throw err;
  }

  const orgFromProfile =
    profile?.org_id != null && String(profile.org_id).trim() !== '' ? String(profile.org_id).trim() : null;
  const sqliteRole = mapProfileRoleToSqliteRole(profile?.role);

  let row = db.prepare('SELECT * FROM users WHERE auth_uid = ?').get(sub);
  if (!row) {
    row = db.prepare('SELECT * FROM users WHERE email = ?').get(emailNorm);
  }

  const hash = bcrypt.hashSync(PLACEHOLDER_PW, 10);
  const displayName =
    (profile?.email && String(profile.email).split('@')[0]) || emailNorm.split('@')[0] || null;

  if (row) {
    const nextOrgId = orgFromProfile ?? row.org_id ?? null;
    // Keep explicit local roles to avoid downgrading established accounts on Supabase profile sync.
    let nextRole = row.role || sqliteRole;
    if (row.role === 'delegate') nextRole = 'delegate';
    else if (!row.role) nextRole = sqliteRole;

    db.prepare(`
      UPDATE users SET
        auth_uid = ?,
        org_id = ?,
        email = ?,
        name = COALESCE(name, ?),
        role = ?,
        password_hash = CASE WHEN password_hash IS NULL OR password_hash = '' THEN ? ELSE password_hash END,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(sub, nextOrgId, emailNorm, displayName, nextRole, hash, row.id);

    return db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
  }

  const id = sub;
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, org_id, auth_uid)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, emailNorm, hash, displayName, sqliteRole, orgFromProfile, sub);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/**
 * After Supabase password/session: sync profile + SQLite and return session fields.
 */
export async function completeSupabaseSignIn(accessToken) {
  const payload = await verifySupabaseAccessToken(accessToken);
  const sub = payload.sub;
  const email = String(payload.email || '').trim().toLowerCase();
  const profile = await fetchSupabaseProfile(sub);
  if (!profile) {
    const err = new Error(
      'No profile row in Supabase. Apply the migration that creates profiles on signup, then try again.'
    );
    err.code = 'NO_PROFILE';
    throw err;
  }
  if (!profile.org_id) {
    return { needs_org_setup: true, sub, email: email || profile.email };
  }
  const user = upsertSqliteUserFromSupabase({
    sub,
    email: email || String(profile.email || '').trim().toLowerCase(),
    profile
  });
  return {
    needs_org_setup: false,
    user,
    sessionUser: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role || 'admin',
      org_id: user.org_id || null,
      auth_uid: user.auth_uid || sub
    }
  };
}

/**
 * First admin: create public.organizations, attach profile + SQLite org row.
 */
export async function registerOrganizationForUser({ accessToken, organizationName }) {
  const payload = await verifySupabaseAccessToken(accessToken);
  const sub = payload.sub;
  const admin = getSupabaseServiceRoleClient();
  if (!admin) {
    const err = new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    err.code = 'SUPABASE_NOT_CONFIGURED';
    throw err;
  }

  const existing = await fetchSupabaseProfile(sub);
  if (existing?.org_id) {
    const err = new Error('This account already belongs to an organisation');
    err.code = 'ORG_ALREADY_SET';
    throw err;
  }

  const name = String(organizationName || '').trim();
  if (!name) {
    const err = new Error('Organisation name is required');
    err.code = 'VALIDATION';
    throw err;
  }

  const { data: orgRow, error: orgErr } = await admin.from('organizations').insert({ name }).select('id').single();
  if (orgErr) {
    const err = new Error(orgErr.message || 'Failed to create organisation');
    err.code = 'SUPABASE_ORG';
    throw err;
  }

  const orgId = orgRow.id;

  const { error: profErr } = await admin.from('profiles').update({ org_id: orgId, role: 'Admin' }).eq('id', sub);
  if (profErr) {
    const err = new Error(profErr.message || 'Failed to update profile');
    err.code = 'SUPABASE_PROFILE';
    throw err;
  }

  const sqliteOrg = db.prepare('SELECT id FROM organisations WHERE id = ?').get(orgId);
  if (!sqliteOrg) {
    db.prepare(`
      INSERT INTO organisations (id, owner_org_id, name, created_at, updated_at)
      VALUES (?, ?, ?, datetime('now'), datetime('now'))
    `).run(orgId, orgId, name);
  } else {
    db.prepare(`UPDATE organisations SET name = ?, owner_org_id = COALESCE(owner_org_id, ?), updated_at = datetime('now') WHERE id = ?`).run(name, orgId, orgId);
  }

  const email = String(payload.email || existing?.email || '').trim().toLowerCase();
  const profile = { ...existing, org_id: orgId, role: 'Admin', email: email || existing?.email };
  upsertSqliteUserFromSupabase({ sub, email, profile });

  return { org_id: orgId, organization_name: name };
}

/**
 * Admin invites a colleague; org_id is stored in auth raw_user_meta_data and copied to profiles by trigger.
 */
export async function inviteStaffToOrg({ orgId, email, fullName }) {
  const admin = getSupabaseServiceRoleClient();
  if (!admin) {
    const err = new Error('Supabase is not configured');
    err.code = 'SUPABASE_NOT_CONFIGURED';
    throw err;
  }
  const toEmail = String(email || '').trim().toLowerCase();
  if (!toEmail || !toEmail.includes('@')) {
    const err = new Error('Valid email is required');
    err.code = 'VALIDATION';
    throw err;
  }

  const base =
    process.env.FRONTEND_ORIGIN?.trim() ||
    process.env.OAUTH_PUBLIC_URL?.trim() ||
    'http://localhost:5174';
  const redirectTo = `${base.replace(/\/$/, '')}/login`;

  const { data, error } = await admin.auth.admin.inviteUserByEmail(toEmail, {
    redirectTo,
    data: {
      org_id: orgId,
      full_name: fullName || null
    }
  });
  if (error) {
    const err = new Error(error.message || 'Invite failed');
    err.code = 'INVITE_FAILED';
    throw err;
  }
  return { user: data?.user || null };
}
