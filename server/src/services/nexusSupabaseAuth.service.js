import bcrypt from 'bcrypt';
import { db } from '../db/index.js';
import { isSuperAdminEmail } from '../lib/superAdmin.js';
import { verifySupabaseAccessToken } from '../lib/supabaseJwt.js';
import { findShifterOrganizationByName, getSupabaseServiceRoleClient } from './supabaseStaffShifter.service.js';

const PLACEHOLDER_PW = '\x00NEXUS_SUPABASE_AUTH\x00';

const PROFILE_SELECT = 'id, email, org_id, role, shifter_enabled';

/** Escape `%`, `_`, `\` so `ilike` treats the string as a literal (case-insensitive equality). */
function escapeIlikeLiteral(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

const UUID_STRING_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * JWT `sub` for Supabase is usually a UUID; some clients emit uppercase. PostgREST string filters
 * can miss when `profiles.id` is stored lowercase — normalize for all lookups and SQLite keys.
 */
export function normalizeSupabaseUserId(sub) {
  const s = String(sub || '').trim();
  if (!s) return s;
  return UUID_STRING_RE.test(s) ? s.toLowerCase() : s;
}

export function mapProfileRoleToSqliteRole(profileRole) {
  const r = String(profileRole || '').trim();
  if (r === 'Admin' || r === 'Manager') return 'admin';
  return 'support_coordinator';
}

export async function fetchSupabaseProfile(userId) {
  const admin = getSupabaseServiceRoleClient();
  if (!admin) return null;
  const id = normalizeSupabaseUserId(userId);
  const { data, error } = await admin
    .from('profiles')
    .select(PROFILE_SELECT)
    .eq('id', id)
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
    .select(PROFILE_SELECT)
    .ilike('email', escapeIlikeLiteral(norm))
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
 * Looks up by auth user id first; if missing, by email (handles legacy rows where profiles.id ≠ auth.users.id).
 */
export async function completeSupabaseSignIn(accessToken) {
  const payload = await verifySupabaseAccessToken(accessToken);
  const sub = normalizeSupabaseUserId(payload.sub);
  let email = String(payload.email || '').trim().toLowerCase();
  const admin = getSupabaseServiceRoleClient();
  if (!admin) {
    const err = new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    err.code = 'SUPABASE_NOT_CONFIGURED';
    throw err;
  }

  if (!email && sub) {
    const { data: authRow, error: authErr } = await admin.auth.admin.getUserById(sub);
    if (!authErr && authRow?.user?.email) {
      email = String(authRow.user.email).trim().toLowerCase();
    }
  }

  const { data: byId, error: errById } = await admin
    .from('profiles')
    .select(PROFILE_SELECT)
    .eq('id', sub)
    .maybeSingle();
  if (errById) {
    console.error('[nexusSupabaseAuth] profile by id', sub, errById.message);
    const err = new Error(`Supabase profiles query failed: ${errById.message}`);
    err.code = 'PROFILE_QUERY_ERROR';
    throw err;
  }

  let profile = byId;
  if (!profile && email) {
    const { data: byEmail, error: errByEmail } = await admin
      .from('profiles')
      .select(PROFILE_SELECT)
      .ilike('email', escapeIlikeLiteral(email))
      .maybeSingle();
    if (errByEmail) {
      console.error('[nexusSupabaseAuth] profile by email', email, errByEmail.message);
      const err = new Error(`Supabase profiles query failed: ${errByEmail.message}`);
      err.code = 'PROFILE_QUERY_ERROR';
      throw err;
    }
    profile = byEmail;
    if (profile && normalizeSupabaseUserId(profile.id) !== sub) {
      console.warn(
        '[nexusSupabaseAuth] profiles.id',
        profile.id,
        'does not match auth uid',
        sub,
        'for',
        email,
        '— sign-in allowed via email match; fix: set profiles.id = auth.users.id for this user in Supabase.'
      );
    }
  }

  if (!profile && sub) {
    try {
      const autoEmail = email || null;
      const autoRole = 'Support Coordinator';
      const { error: insErr } = await admin
        .from('profiles')
        .upsert(
          {
            id: sub,
            email: autoEmail,
            role: autoRole
          },
          { onConflict: 'id' }
        );
      if (insErr) {
        console.warn('[nexusSupabaseAuth] profile auto-heal upsert failed', sub, insErr.message);
      } else {
        console.log('[nexusSupabaseAuth] profile auto-healed for auth user', sub);
      }
    } catch (e) {
      console.warn('[nexusSupabaseAuth] profile auto-heal error', sub, e?.message || e);
    }

    const { data: healedById, error: healedByIdErr } = await admin
      .from('profiles')
      .select(PROFILE_SELECT)
      .eq('id', sub)
      .maybeSingle();
    if (!healedByIdErr && healedById) {
      profile = healedById;
    } else if (healedByIdErr) {
      console.warn('[nexusSupabaseAuth] profile auto-heal recheck failed', sub, healedByIdErr.message);
    }
  }

  if (!profile) {
    console.warn('[nexusSupabaseAuth] NO_PROFILE sub=', sub, 'email_used=', email || '(empty)');
    const err = new Error(
      [
        'No matching row in public.profiles for this login.',
        'Check: (1) Nexus server SUPABASE_URL is the same Supabase project as this dashboard,',
        '(2) profiles.id equals the user UUID under Authentication → Users for this account.',
        'Apply repo supabase migrations (including backfill) if the table is empty or out of date.',
      ].join(' ')
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
  const sub = normalizeSupabaseUserId(payload.sub);
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

  const shifterOrg = await findShifterOrganizationByName(name);
  let orgId = null;

  if (shifterOrg?.id) {
    const { data: byId, error: byIdErr } = await admin
      .from('organizations')
      .select('id')
      .eq('id', shifterOrg.id)
      .maybeSingle();
    if (byIdErr) {
      const err = new Error(byIdErr.message || 'Failed to verify organisation in Supabase');
      err.code = 'SUPABASE_ORG';
      throw err;
    }

    if (byId?.id) {
      const { error: updErr } = await admin
        .from('organizations')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', shifterOrg.id);
      if (updErr) {
        const err = new Error(updErr.message || 'Failed to update organisation');
        err.code = 'SUPABASE_ORG';
        throw err;
      }
      orgId = shifterOrg.id;
    } else {
      const { data: seededRow, error: seededErr } = await admin
        .from('organizations')
        .insert({ id: shifterOrg.id, name })
        .select('id')
        .single();
      if (seededErr) {
        const err = new Error(seededErr.message || 'Failed to create organisation');
        err.code = 'SUPABASE_ORG';
        throw err;
      }
      orgId = seededRow.id;
    }
  } else {
    const { data: orgRow, error: orgErr } = await admin.from('organizations').insert({ name }).select('id').single();
    if (orgErr) {
      const err = new Error(orgErr.message || 'Failed to create organisation');
      err.code = 'SUPABASE_ORG';
      throw err;
    }
    orgId = orgRow.id;
  }

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
