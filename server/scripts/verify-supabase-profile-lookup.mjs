#!/usr/bin/env node
/**
 * Same profile lookups Nexus uses after Supabase sign-in (service role).
 * Usage (from repo root, .env with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY):
 *   node server/scripts/verify-supabase-profile-lookup.mjs you@example.com
 *   node server/scripts/verify-supabase-profile-lookup.mjs <auth-user-uuid>
 */
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
config({ path: join(projectRoot, '.env') });

const PROFILE_SELECT = 'id, email, org_id, role, shifter_enabled';

function escapeIlikeLiteral(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env (project root).');
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node server/scripts/verify-supabase-profile-lookup.mjs <email-or-auth-uuid>');
  process.exit(1);
}

const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg.trim());

if (isUuid) {
  const sub = arg.trim();
  const { data: byId, error: errId } = await admin
    .from('profiles')
    .select(PROFILE_SELECT)
    .eq('id', sub)
    .maybeSingle();
  console.log('profiles.eq(id):', errId?.message || 'ok', byId || null);

  const { data: authData, error: authErr } = await admin.auth.admin.getUserById(sub);
  const u = authData?.user;
  console.log('auth.getUserById:', authErr?.message || 'ok', u ? { id: u.id, email: u.email } : null);

  if (u?.email) {
    const em = String(u.email).trim().toLowerCase();
    const { data: byIlike, error: errIlike } = await admin
      .from('profiles')
      .select(PROFILE_SELECT)
      .ilike('email', escapeIlikeLiteral(em))
      .maybeSingle();
    console.log('profiles.ilike(email from auth):', errIlike?.message || 'ok', byIlike || null);
    if (byIlike && byIlike.id !== sub) {
      console.log('MISMATCH: profiles.id !== auth id. Sign-in needs aligned ids or ilike path (deploy latest server).');
    }
  }
} else {
  const email = arg.trim().toLowerCase();
  const { data: byIlike, error: errIlike } = await admin
    .from('profiles')
    .select(PROFILE_SELECT)
    .ilike('email', escapeIlikeLiteral(email))
    .maybeSingle();
  console.log('profiles.ilike(email):', errIlike?.message || 'ok', byIlike || null);

  const { data: byEq, error: errEq } = await admin
    .from('profiles')
    .select(PROFILE_SELECT)
    .eq('email', email)
    .maybeSingle();
  console.log('profiles.eq(lower email):', errEq?.message || 'ok', byEq || null);

  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const match = list?.users?.find((x) => String(x.email || '').trim().toLowerCase() === email);
  console.log(
    'auth user (first 200 users):',
    listErr?.message || 'ok',
    match ? { id: match.id, email: match.email } : 'no match',
  );
  if (match && byIlike && match.id !== byIlike.id) {
    console.log('MISMATCH: auth.users.id !== profiles.id for this email.');
  }
}

console.log('SUPABASE_URL host:', new URL(url).host);
process.exit(0);
