import { createClient } from '@supabase/supabase-js';

let _admin = null;
let _shifterAdmin = null;

function normalizeEmail(email) {
  if (email == null || typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

/** Escape `%`, `_`, `\` so ILIKE treats the string as a literal (case-insensitive equality). */
function escapeIlikeLiteral(s) {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function isSupabaseShifterConfigured() {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

/** Shifter app Supabase (separate project). Used to verify workers exist in the org before enabling. */
export function isShifterRemoteConfigured() {
  return Boolean(process.env.SHIFTER_SUPABASE_URL?.trim() && process.env.SHIFTER_SERVICE_ROLE_KEY?.trim());
}

function getAdminClient() {
  if (!isSupabaseShifterConfigured()) return null;
  if (!_admin) {
    _admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _admin;
}

function getShifterAdminClient() {
  if (!isShifterRemoteConfigured()) return null;
  if (!_shifterAdmin) {
    _shifterAdmin = createClient(process.env.SHIFTER_SUPABASE_URL, process.env.SHIFTER_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _shifterAdmin;
}

/** Service-role client for the separate Shifter Supabase project. */
export function getShifterServiceRoleClient() {
  return getShifterAdminClient();
}

function normalizeOrgName(name) {
  return String(name || '').trim();
}

/**
 * Resolve a Shifter organization by name (case-insensitive exact match).
 * Returns null when Shifter is not configured or no match exists.
 */
export async function findShifterOrganizationByName(orgNameRaw) {
  const shifterAdmin = getShifterAdminClient();
  const orgName = normalizeOrgName(orgNameRaw);
  if (!shifterAdmin || !orgName) return null;

  const namePattern = escapeIlikeLiteral(orgName);
  const nameColumns = ['name', 'org_name', 'organisation_name', 'title'];
  for (const nameCol of nameColumns) {
    const { data, error } = await shifterAdmin
      .from('organizations')
      .select('id')
      .ilike(nameCol, namePattern)
      .limit(2);
    if (error) continue;
    const rows = data || [];
    if (rows.length > 1) {
      const err = new Error('Multiple Shifter organizations match this name');
      err.code = 'SHIFTER_ORG_AMBIGUOUS';
      throw err;
    }
    if (rows.length === 1 && rows[0]?.id) {
      return { id: String(rows[0].id).trim(), source: `organizations.${nameCol}` };
    }
  }

  return null;
}

function isUuidString(s) {
  return (
    typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim())
  );
}

/**
 * After Nexus links to a Shifter org, write Schedule Shift / CRM webhook URL (+ optional API key) on Shifter
 * public.organizations when known column names exist. Best-effort; Shifter schemas differ between deployments.
 */
export async function pushScheduleShiftIntegrationToShifter(shifterOrgId, { webhookUrl, apiKey } = {}) {
  const shifter = getShifterAdminClient();
  if (!shifter || !isUuidString(String(shifterOrgId || ''))) {
    return { ok: false, skipped: true, reason: 'shifter_not_configured_or_invalid_org_id' };
  }
  const oid = String(shifterOrgId).trim();
  const url = String(webhookUrl || '').trim();
  if (!url) {
    return { ok: false, skipped: true, reason: 'no_webhook_url' };
  }
  const key = String(apiKey || '').trim();

  const pairs = [
    ['schedule_shift_webhook_url', 'schedule_shift_api_key'],
    ['schedule_shift_webhook_url', 'crm_api_key'],
    ['schedule_shift_webhook_url', 'schedule_shift_crm_api_key'],
    ['crm_webhook_url', 'crm_api_key'],
    ['nexus_webhook_url', 'nexus_api_key'],
    ['nexus_crm_webhook_url', 'nexus_crm_api_key'],
    ['progress_notes_webhook_url', 'progress_notes_api_key'],
    ['webhook_url', 'api_key'],
  ];

  for (const [urlCol, keyCol] of pairs) {
    const patch = { [urlCol]: url };
    if (key && keyCol) patch[keyCol] = key;
    const { error } = await shifter.from('organizations').update(patch).eq('id', oid);
    if (!error) {
      return {
        ok: true,
        webhook_column: urlCol,
        api_key_column: key && keyCol ? keyCol : null,
        api_key_set: Boolean(key && keyCol),
      };
    }
  }

  const urlOnlyCols = [
    'schedule_shift_webhook_url',
    'crm_webhook_url',
    'nexus_webhook_url',
    'progress_notes_webhook_url',
    'webhook_url',
  ];
  for (const col of urlOnlyCols) {
    const { error } = await shifter.from('organizations').update({ [col]: url }).eq('id', oid);
    if (!error) {
      return {
        ok: true,
        webhook_column: col,
        api_key_column: null,
        api_key_set: false,
        note: key
          ? 'Server has CRM_API_KEY but no matching API key column on Shifter organisations — set the key in Shifter admin or align column names.'
          : null,
      };
    }
  }

  return {
    ok: false,
    skipped: false,
    reason: 'no_matching_columns',
    detail: 'No known webhook columns on Shifter public.organizations',
  };
}

/**
 * Maps NexusCore public.organizations.id to the org id used in Shifter (profiles.org_id, etc.).
 */
async function resolveEffectiveShifterOrgId(nexusAdmin, nexusOrgId) {
  if (!nexusOrgId || !nexusAdmin) return null;
  const { data, error } = await nexusAdmin
    .from('organizations')
    .select('id, shifter_organization_id')
    .eq('id', nexusOrgId)
    .maybeSingle();
  if (error) {
    console.warn('[shifter-link] organizations lookup', error.message);
    return nexusOrgId;
  }
  if (!data) return nexusOrgId;
  return data.shifter_organization_id || data.id;
}

/** Resolve org id used in Shifter for a given Nexus org id. */
export async function resolveEffectiveShifterOrgIdForNexusOrg(nexusOrgId) {
  const nexusAdmin = getAdminClient();
  if (!nexusAdmin || !nexusOrgId) return nexusOrgId || null;
  return resolveEffectiveShifterOrgId(nexusAdmin, nexusOrgId);
}

function joinShifterProgressNotesPath(folderRaw, filenameRaw) {
  const folder = String(folderRaw || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  const name = String(filenameRaw || '').trim();
  if (folder && name) return `${folder}/${name}`;
  return name || folder || null;
}

function isShifterAdminLikeRole(role) {
  const s = String(role || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  return (
    s === 'admin' ||
    s === 'org_admin' ||
    s === 'organisation_admin' ||
    s === 'organization_admin'
  );
}

/**
 * OneDrive path (folder + file under the connected user’s drive root) for the Progress Notes / shifts workbook.
 * Loaded from the Shifter Supabase project: Org Admin profiles for the same org (see supabase/shifter-migrations).
 * @param {string} nexusOrgId - Nexus / public.organizations.id (uuid)
 * @returns {Promise<string | null>} Relative path, or null to fall back to env default
 */
export async function resolveOnedriveExcelPathFromShifterForNexusOrg(nexusOrgId) {
  const shifter = getShifterAdminClient();
  if (!shifter || !nexusOrgId) return null;

  const shifterOrgId = await resolveEffectiveShifterOrgIdForNexusOrg(nexusOrgId);
  if (!shifterOrgId) return null;

  const sel = 'email, role, progress_notes_onedrive_path, progress_notes_folder, progress_notes_filename';
  const { data, error } = await shifter
    .from('profiles')
    .select(sel)
    .eq('org_id', shifterOrgId)
    .order('email', { ascending: true });

  if (error) {
    console.warn('[shifter-excel-path] profiles read:', error.message);
    return null;
  }

  let rows = data || [];
  if (rows.length === 0) {
    const alt = await shifter.from('profiles').select(sel).eq('organization_id', shifterOrgId).order('email', { ascending: true });
    if (!alt.error && alt.data?.length) rows = alt.data;
    else if (alt.error && !/column .* does not exist/i.test(String(alt.error.message || ''))) {
      console.warn('[shifter-excel-path] profiles organization_id read:', alt.error.message);
    }
  }
  const admins = rows.filter((r) => isShifterAdminLikeRole(r.role));

  for (const row of admins) {
    const full = String(row.progress_notes_onedrive_path || '').trim().replace(/^\/+/, '');
    if (full) return full;
    const joined = joinShifterProgressNotesPath(row.progress_notes_folder, row.progress_notes_filename);
    if (joined) return joined.replace(/^\/+/, '');
  }

  return null;
}

function pickShifterProfileIdFromRow(row, table) {
  if (!row || typeof row !== 'object') return null;
  if (table === 'profiles') return row.id || null;
  return row.profile_id || row.user_id || null;
}

async function verifyShifterProfileMatchesEmail(shifterAdmin, profileId, ilikePattern) {
  const { data, error } = await shifterAdmin
    .from('profiles')
    .select('id')
    .eq('id', profileId)
    .ilike('email', ilikePattern)
    .maybeSingle();
  if (error || !data?.id) return false;
  return true;
}

/**
 * Find a Shifter profiles.id (or equivalent) scoped to organisation: tries public.profiles, staff, workers
 * with org_id or organization_id.
 */
async function findShifterWorkerInOrg(shifterAdmin, emailKey, shifterOrgId) {
  const pat = escapeIlikeLiteral(emailKey);
  const tables = ['profiles', 'staff', 'workers'];
  const orgCols = ['org_id', 'organization_id'];

  for (const table of tables) {
    for (const orgCol of orgCols) {
      const { data, error } = await shifterAdmin
        .from(table)
        .select('*')
        .ilike('email', pat)
        .eq(orgCol, shifterOrgId)
        .limit(2);
      if (error) continue;
      const rows = data || [];
      if (rows.length > 1) {
        const err = new Error(`Multiple Shifter ${table} rows match this email in the organisation`);
        err.code = 'SHIFTER_AMBIGUOUS';
        throw err;
      }
      if (rows.length === 0) continue;
      const profileId = pickShifterProfileIdFromRow(rows[0], table);
      if (!profileId) continue;
      const ok = await verifyShifterProfileMatchesEmail(shifterAdmin, profileId, pat);
      if (ok) return { profileId, source: `${table}.${orgCol}` };
    }
  }
  return null;
}

/**
 * Resolve Shifter worker profiles.id (or equivalent) from email when SQLite staff.shifter_worker_profile_id
 * is unset — same lookup as enabling Shifter for a worker, so roster shifts reach the app without that extra step.
 */
export async function resolveShifterWorkerProfileIdForEmail(emailRaw, nexusOrgIdRaw) {
  const shifter = getShifterAdminClient();
  if (!shifter) return null;
  const nexusAdmin = getAdminClient();
  if (!nexusAdmin) return null;
  const emailKey = normalizeEmail(emailRaw);
  const nexusOrgId =
    typeof nexusOrgIdRaw === 'string' && nexusOrgIdRaw.trim() ? nexusOrgIdRaw.trim() : null;
  if (!emailKey || !nexusOrgId || !isUuidString(nexusOrgId)) return null;
  let effectiveShifterOrg;
  try {
    effectiveShifterOrg = await resolveEffectiveShifterOrgId(nexusAdmin, nexusOrgId);
  } catch (e) {
    console.warn('[shifter-link] resolveShifterWorkerProfileIdForEmail org', e?.message || e);
    return null;
  }
  if (!effectiveShifterOrg) return null;
  try {
    const match = await findShifterWorkerInOrg(shifter, emailKey, effectiveShifterOrg);
    return match?.profileId ?? null;
  } catch (e) {
    console.warn('[shifter-link] resolveShifterWorkerProfileIdForEmail worker', e?.message || e);
    return null;
  }
}

async function findNexusProfileByEmail(nexusAdmin, emailKey) {
  let { data: rows, error: selErr } = await nexusAdmin.from('profiles').select('id').eq('email', emailKey).limit(2);
  if (selErr) throw selErr;
  if (rows?.length > 1) {
    const err = new Error('Multiple Nexus profiles match this email; resolve duplicates in Supabase');
    err.code = 'PROFILE_AMBIGUOUS';
    throw err;
  }
  let profile = rows?.[0];
  if (!profile?.id) {
    const { data: ilikeRows, error: ilikeErr } = await nexusAdmin
      .from('profiles')
      .select('id')
      .ilike('email', escapeIlikeLiteral(emailKey))
      .limit(2);
    if (ilikeErr) throw ilikeErr;
    if (ilikeRows?.length > 1) {
      const err = new Error('Multiple Nexus profiles match this email; resolve duplicates in Supabase');
      err.code = 'PROFILE_AMBIGUOUS';
      throw err;
    }
    profile = ilikeRows?.[0];
  }
  return profile?.id ? { id: profile.id } : null;
}

/** Paginate Auth users until we find a matching email (handles "already registered" with no public.profiles row). */
async function findAuthUserIdByEmail(nexusAdmin, emailKey) {
  const target = emailKey;
  const perPage = 1000;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await nexusAdmin.auth.admin.listUsers({ page, perPage });
    if (error) {
      console.warn('[shifter-link] listUsers', error.message);
      return null;
    }
    const users = data?.users || [];
    for (const u of users) {
      if (normalizeEmail(u.email) === target) return u.id;
    }
    if (users.length < perPage) break;
  }
  return null;
}

/** Map SQLite staff.role (or similar) to public.profiles.role text. */
function staffRoleToProfileRole(staffRole) {
  const r = String(staffRole || '').trim();
  if (!r) return 'Support Worker';
  const lower = r.toLowerCase().replace(/\s+/g, '_');
  const map = {
    support_worker: 'Support Worker',
    supportworker: 'Support Worker',
    team_leader: 'Team Leader',
    teamleader: 'Team Leader',
    coordinator: 'Coordinator',
    admin: 'Admin',
    manager: 'Manager',
    delegate: 'Coordinator',
  };
  if (map[lower]) return map[lower];
  if (/^support worker$/i.test(r)) return 'Support Worker';
  return r;
}

async function ensureNexusProfileRowForAuthUser(nexusAdmin, userId, emailKey, nexusOrgId, opts = {}) {
  const shifterEnabled = opts.shifterEnabled ?? true;
  const role = opts.role ?? 'Support Worker';
  let emailForRow = emailKey;
  const { data: udata } = await nexusAdmin.auth.admin.getUserById(userId);
  if (udata?.user?.email) {
    emailForRow = normalizeEmail(udata.user.email) || emailKey;
  }
  const row = {
    id: userId,
    email: emailForRow,
    shifter_enabled: shifterEnabled,
    role,
  };
  if (nexusOrgId && isUuidString(nexusOrgId)) row.org_id = nexusOrgId.trim();
  const { error: upErr } = await nexusAdmin.from('profiles').upsert(row, { onConflict: 'id' });
  if (upErr) {
    console.warn('[shifter-link] profiles upsert', upErr.message);
    const { error: patchErr } = await nexusAdmin
      .from('profiles')
      .update({
        shifter_enabled: shifterEnabled,
        role,
        email: emailForRow,
        ...(nexusOrgId && isUuidString(nexusOrgId) ? { org_id: nexusOrgId.trim() } : {}),
      })
      .eq('id', userId);
    if (patchErr) {
      const err = new Error(
        patchErr.message ||
          'Could not create or update public.profiles (check triggers, NOT NULL columns, and RLS for service role).',
      );
      err.code = 'NEXUS_PROFILE_UPSERT_FAILED';
      throw err;
    }
  }
}

/**
 * Create or resolve auth.users id for email. Passes org_id in user_metadata so handle_new_user() can seed profiles.
 */
async function ensureNexusAuthUserByEmail(nexusAdmin, emailKey, nexusOrgId) {
  const userMeta =
    nexusOrgId && isUuidString(nexusOrgId) ? { user_metadata: { org_id: nexusOrgId.trim() } } : {};

  const { data: created, error: createErr } = await nexusAdmin.auth.admin.createUser({
    email: emailKey,
    email_confirm: true,
    ...userMeta,
  });

  if (!createErr && created?.user?.id) {
    return created.user.id;
  }

  if (createErr && /already|registered|exists/i.test(createErr.message || '')) {
    const uid = await findAuthUserIdByEmail(nexusAdmin, emailKey);
    if (uid) return uid;
    const orphan = await findNexusProfileByEmail(nexusAdmin, emailKey);
    if (orphan?.id) return orphan.id;
    const err = new Error(
      'This email is already registered in Nexus Core Auth, but no matching public.profiles row was found and the user could not be listed. Check Supabase Auth → Users or add the profile manually.',
    );
    err.code = 'NEXUS_AUTH_ORPHAN';
    throw err;
  }

  if (createErr) {
    const err = new Error(createErr.message || 'Failed to create Nexus Core auth user');
    err.code = 'NEXUS_AUTH_CREATE_FAILED';
    throw err;
  }

  const err = new Error('Nexus auth user create returned no id');
  err.code = 'NEXUS_AUTH_CREATE_FAILED';
  throw err;
}

async function ensureNexusAuthUserAndProfile(nexusAdmin, emailKey, nexusOrgId) {
  const uid = await ensureNexusAuthUserByEmail(nexusAdmin, emailKey, nexusOrgId);
  await ensureNexusProfileRowForAuthUser(nexusAdmin, uid, emailKey, nexusOrgId, {
    shifterEnabled: true,
    role: 'Support Worker',
  });
  const found = await findNexusProfileByEmail(nexusAdmin, emailKey);
  return found || { id: uid };
}

/**
 * Ensure Nexus Supabase Auth user + public.profiles exist for CRM staff (shifter_enabled stays false until enabled in UI).
 * Call when staff is created or when an email is first set. No-op without email or Supabase config.
 */
export async function provisionNexusSupabaseProfileForStaff(emailRaw, nexusOrgId, opts = {}) {
  const nexusAdmin = getAdminClient();
  if (!nexusAdmin) {
    return { ok: false, skipped: true, reason: 'supabase_not_configured' };
  }
  const key = normalizeEmail(emailRaw);
  if (!key) {
    return { ok: false, skipped: true, reason: 'no_email' };
  }

  const profileRole = staffRoleToProfileRole(opts.staffRole);

  try {
    const existing = await findNexusProfileByEmail(nexusAdmin, key);
    if (existing?.id) {
      const updates = { role: profileRole };
      if (nexusOrgId && isUuidString(nexusOrgId)) {
        const { data: prow } = await nexusAdmin.from('profiles').select('org_id').eq('id', existing.id).maybeSingle();
        if (!prow?.org_id) updates.org_id = nexusOrgId.trim();
      }
      const { error: uerr } = await nexusAdmin.from('profiles').update(updates).eq('id', existing.id);
      if (uerr) {
        console.warn('[staff-profile] update existing', uerr.message);
        return { ok: false, error: uerr.message, profile_id: existing.id };
      }
      return { ok: true, profile_id: existing.id, created: false };
    }

    const uid = await ensureNexusAuthUserByEmail(nexusAdmin, key, nexusOrgId);
    await ensureNexusProfileRowForAuthUser(nexusAdmin, uid, key, nexusOrgId, {
      shifterEnabled: false,
      role: profileRole,
    });
    const found = await findNexusProfileByEmail(nexusAdmin, key);
    return { ok: true, profile_id: found?.id || uid, created: true };
  } catch (e) {
    console.warn('[staff-profile]', e?.message || e);
    return { ok: false, error: e?.message || String(e), code: e?.code };
  }
}

/** Service-role Supabase client (org_features, profiles, etc.). Same instance as Shifter helpers. */
export function getSupabaseServiceRoleClient() {
  return getAdminClient();
}

async function fetchAuthUsersByIds(admin, userIds) {
  const authByUserId = new Map();
  const ids = [...new Set((userIds || []).filter(Boolean))];
  await Promise.all(
    ids.map(async (uid) => {
      const { data, error } = await admin.auth.admin.getUserById(uid);
      if (error) {
        console.warn('[supabaseStaffShifter] getUserById', uid, error.message);
        return;
      }
      if (data?.user?.id) authByUserId.set(data.user.id, data.user);
    })
  );
  return authByUserId;
}

/**
 * Load profiles for the given emails; optionally load auth rows only for enabled profiles.
 */
async function loadProfilesAndAuthForEmails(admin, normalizedEmails, { loadAuth } = { loadAuth: true }) {
  const unique = [...new Set(normalizedEmails.filter(Boolean))];
  const profileByEmail = new Map();
  if (unique.length === 0) {
    return { profileByEmail, authByUserId: new Map() };
  }

  const { data: profiles, error: profErr } = await admin.from('profiles').select('id, email, shifter_enabled').in('email', unique);
  if (profErr) throw profErr;
  for (const p of profiles || []) {
    const key = normalizeEmail(p.email);
    if (key) profileByEmail.set(key, p);
  }

  const missingKeys = unique.filter((k) => !profileByEmail.has(k));
  if (missingKeys.length > 0) {
    await Promise.all(
      missingKeys.map(async (k) => {
        const pattern = escapeIlikeLiteral(k);
        const { data: rows, error: ilikeErr } = await admin
          .from('profiles')
          .select('id, email, shifter_enabled')
          .ilike('email', pattern)
          .limit(2);
        if (ilikeErr) throw ilikeErr;
        if (rows?.length === 1) {
          profileByEmail.set(k, rows[0]);
        }
      })
    );
  }

  if (!loadAuth) {
    return { profileByEmail, authByUserId: new Map() };
  }

  const allMatched = [...profileByEmail.values()];
  const enabledIds = allMatched.filter((p) => p.shifter_enabled).map((p) => p.id);
  const authByUserId = await fetchAuthUsersByIds(admin, enabledIds);
  return { profileByEmail, authByUserId };
}

function rowFromProfile(profile, authByUserId) {
  if (!profile) {
    return { shifter_enabled: false, shifter_status: 'not_enabled', supabase_profile_id: null };
  }
  const enabled = Boolean(profile.shifter_enabled);
  if (!enabled) {
    return { shifter_enabled: false, shifter_status: 'not_enabled', supabase_profile_id: profile.id };
  }
  const authUser = profile.id ? authByUserId.get(profile.id) : null;
  const hasSignedIn = Boolean(authUser?.last_sign_in_at);
  return {
    shifter_enabled: true,
    shifter_status: hasSignedIn ? 'active' : 'invited',
    supabase_profile_id: profile.id,
  };
}

/**
 * @param {Array<{ email?: string | null }>} staffRows
 * @returns {Promise<Map<string, { shifter_enabled: boolean, shifter_status: string, supabase_profile_id: string | null }>>}
 */
export async function getShifterFieldsByStaffId(staffRows) {
  const admin = getAdminClient();
  const empty = () => ({
    shifter_enabled: false,
    shifter_status: 'not_enabled',
    supabase_profile_id: null,
  });

  const byStaffId = new Map();
  if (!admin) {
    for (const s of staffRows) byStaffId.set(s.id, empty());
    return byStaffId;
  }

  const emails = staffRows.map((s) => normalizeEmail(s.email));
  const { profileByEmail, authByUserId } = await loadProfilesAndAuthForEmails(admin, emails);

  for (const s of staffRows) {
    const key = normalizeEmail(s.email);
    const profile = key ? profileByEmail.get(key) : null;
    const row = rowFromProfile(profile, authByUserId);
    byStaffId.set(s.id, row);
  }

  return byStaffId;
}

async function buildSetShifterResponse(admin, profileId, emailKey, shifter_enabled, extras = {}) {
  const profileRow = { id: profileId, email: emailKey, shifter_enabled };
  if (!shifter_enabled) {
    return { profile_id: profileId, ...extras, ...rowFromProfile(profileRow, new Map()) };
  }
  const { data: userData } = await admin.auth.admin.getUserById(profileId);
  const authByUserId = new Map();
  if (userData?.user?.id) authByUserId.set(userData.user.id, userData.user);
  return { profile_id: profileId, ...extras, ...rowFromProfile(profileRow, authByUserId) };
}

/**
 * @param {string} email
 * @param {boolean} shifter_enabled
 * @param {{ nexusOrgId?: string | null, staffId?: string, db?: object }} [ctx]
 */
export async function setShifterEnabledForStaffEmail(email, shifter_enabled, ctx = {}) {
  const { nexusOrgId, staffId, db } = ctx;
  const nexusAdmin = getAdminClient();
  if (!nexusAdmin) {
    const err = new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    err.code = 'SUPABASE_NOT_CONFIGURED';
    throw err;
  }
  const key = normalizeEmail(email);
  if (!key) {
    const err = new Error('Staff member needs an email address to link Shifter access in Supabase');
    err.code = 'NO_EMAIL';
    throw err;
  }

  if (!shifter_enabled) {
    if (staffId && db) {
      db.prepare('UPDATE staff SET shifter_worker_profile_id = NULL WHERE id = ?').run(staffId);
    }
    let profile = await findNexusProfileByEmail(nexusAdmin, key);
    if (!profile?.id) {
      return {
        profile_id: null,
        shifter_worker_profile_id: null,
        shifter_link_source: null,
        shifter_enabled: false,
        shifter_status: 'not_enabled',
        supabase_profile_id: null,
      };
    }
    const { error: updErr } = await nexusAdmin.from('profiles').update({ shifter_enabled: false }).eq('id', profile.id);
    if (updErr) throw updErr;
    return buildSetShifterResponse(nexusAdmin, profile.id, key, false, {
      shifter_worker_profile_id: null,
      shifter_link_source: null,
    });
  }

  let shifterLinkMeta = null;
  const shifterClient = getShifterAdminClient();
  if (shifterClient) {
    if (!nexusOrgId) {
      const err = new Error(
        'Your account has no organisation; cannot verify this worker exists in Shifter for your org. Assign an organisation or add SHIFTER_* only after fixing org.',
      );
      err.code = 'NO_ORG_FOR_SHIFTER_LINK';
      throw err;
    }
    const effectiveShifterOrg = await resolveEffectiveShifterOrgId(nexusAdmin, nexusOrgId);
    if (!effectiveShifterOrg) {
      const err = new Error('Could not resolve Shifter organisation id from Nexus Core Supabase (public.organizations).');
      err.code = 'NO_ORG_FOR_SHIFTER_LINK';
      throw err;
    }
    const match = await findShifterWorkerInOrg(shifterClient, key, effectiveShifterOrg);
    if (!match) {
      const err = new Error(
        'No Shifter worker or staff row found for this email in your organisation. Add them in Shifter first, or align organisations (same organizations.id in both projects, or set public.organizations.shifter_organization_id in Nexus Core).',
      );
      err.code = 'SHIFTER_WORKER_NOT_FOUND';
      throw err;
    }
    shifterLinkMeta = match;
    if (staffId && db) {
      db.prepare('UPDATE staff SET shifter_worker_profile_id = ? WHERE id = ?').run(match.profileId, staffId);
    }
  }

  let profile = await findNexusProfileByEmail(nexusAdmin, key);
  if (profile?.id) {
    const { data: prow } = await nexusAdmin.from('profiles').select('shifter_enabled').eq('id', profile.id).maybeSingle();
    if (prow?.shifter_enabled) {
      console.log('[shifter-enabled]', { email: key, profile_id: profile.id, action: 'already_enabled' });
      return buildSetShifterResponse(nexusAdmin, profile.id, key, true, {
        shifter_worker_profile_id: shifterLinkMeta?.profileId ?? null,
        shifter_link_source: shifterLinkMeta?.source ?? null,
        skipped: true,
        reason: 'already_enabled',
      });
    }
  }

  if (!profile?.id) {
    const shouldProvision = Boolean(shifterLinkMeta) || !getShifterAdminClient();
    if (shouldProvision) {
      profile = await ensureNexusAuthUserAndProfile(nexusAdmin, key, nexusOrgId);
    }
  }
  if (!profile?.id) {
    const err = new Error(
      'No Nexus Core Supabase profile found for this email. With Shifter credentials set, the worker must exist in Shifter for your org first; otherwise ensure SUPABASE_* points at the project where public.profiles lives.',
    );
    err.code = 'PROFILE_NOT_FOUND';
    throw err;
  }

  const { error: updErr } = await nexusAdmin.from('profiles').update({ shifter_enabled: true }).eq('id', profile.id);
  if (updErr) throw updErr;

  console.log('[shifter-enabled]', {
    email: key,
    profile_id: profile.id,
    shifter_worker_profile_id: shifterLinkMeta?.profileId,
    action: 'set shifter_enabled true',
  });
  return buildSetShifterResponse(nexusAdmin, profile.id, key, true, {
    shifter_worker_profile_id: shifterLinkMeta?.profileId ?? null,
    shifter_link_source: shifterLinkMeta?.source ?? null,
  });
}

/**
 * @param {string[]} staffIds
 * @param {(id: string) => object | undefined} getStaffById
 * @param {{ nexusOrgId?: string | null, db?: object }} [ctx]
 */
export async function sendShifterInvitesForStaffIds(staffIds, getStaffById, ctx = {}) {
  const nexusAdmin = getAdminClient();
  if (!nexusAdmin) {
    const err = new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    err.code = 'SUPABASE_NOT_CONFIGURED';
    throw err;
  }

  const results = [];
  for (const staffId of staffIds) {
    const s = getStaffById(staffId);
    if (!s) {
      results.push({ staff_id: staffId, ok: false, error: 'Staff not found' });
      continue;
    }
    try {
      const updated = await setShifterEnabledForStaffEmail(s.email, true, {
        nexusOrgId: ctx.nexusOrgId,
        staffId: s.id,
        db: ctx.db,
      });
      results.push({
        staff_id: staffId,
        ok: true,
        ...updated,
      });
    } catch (err) {
      results.push({
        staff_id: staffId,
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
  }

  return results;
}
