/**
 * Diagnose why a staff user is "not getting shifts coming through".
 *
 * Usage:
 *   node server/scripts/diagnose-shift-delivery.mjs --profile-id <uuid>
 *   node server/scripts/diagnose-shift-delivery.mjs --email <email>
 *   node server/scripts/diagnose-shift-delivery.mjs --staff-id <sqlite_staff_id>
 *
 * Notes:
 * - This script reads the local SQLite DB (data/schedule.db by default).
 * - If Supabase service-role env is configured, it can also look up `profiles` by id/email.
 */
import Database from 'better-sqlite3';
import process from 'node:process';

function getArg(name) {
  const idx = process.argv.findIndex((a) => a === name);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

function safeJson(x) {
  return JSON.stringify(x, null, 2);
}

const profileId = getArg('--profile-id') || getArg('--profile_id');
const emailArg = getArg('--email');
const staffIdArg = getArg('--staff-id') || getArg('--staff_id');

const dbPath = process.env.DATABASE_PATH || '../data/schedule.db';
const db = new Database(dbPath, { readonly: true });

const out = {
  input: { profileId: profileId || null, email: emailArg || null, staffId: staffIdArg || null },
  sqlite: {},
  supabase: { configured: false, profile: null },
  conclusions: [],
};

// ── SQLite lookup ────────────────────────────────────────────────────────────
let sqliteStaff = null;
if (staffIdArg) {
  sqliteStaff = db.prepare('SELECT id, org_id, name, email, shifter_worker_profile_id, archived_at FROM staff WHERE id = ?').get(staffIdArg);
}

if (!sqliteStaff && emailArg) {
  sqliteStaff = db
    .prepare('SELECT id, org_id, name, email, shifter_worker_profile_id, archived_at FROM staff WHERE lower(email) = ?')
    .get(normEmail(emailArg));
}

out.sqlite.staff = sqliteStaff || null;

if (sqliteStaff?.id) {
  out.sqlite.shift_counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled,
         SUM(CASE WHEN status IN ('completed','completed_by_admin') THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
         COUNT(*) AS total
       FROM shifts
       WHERE staff_id = ?`,
    )
    .get(sqliteStaff.id);
  out.sqlite.next_10_shifts = db
    .prepare(
      `SELECT id, participant_id, start_time, end_time, status, shifter_shift_id
       FROM shifts
       WHERE staff_id = ?
       ORDER BY start_time ASC
       LIMIT 10`,
    )
    .all(sqliteStaff.id);
}

// ── Supabase lookup (optional) ───────────────────────────────────────────────
try {
  const mod = await import('../src/services/supabaseStaffShifter.service.js');
  const admin = mod.getSupabaseServiceRoleClient?.();
  if (admin) {
    out.supabase.configured = true;

    if (profileId) {
      const { data, error } = await admin.from('profiles').select('id,email,shifter_enabled').eq('id', profileId).maybeSingle();
      if (!error) out.supabase.profile = data || null;
      else out.supabase.error = error.message;
    } else if (emailArg) {
      const { data, error } = await admin
        .from('profiles')
        .select('id,email,shifter_enabled')
        .eq('email', normEmail(emailArg))
        .limit(5);
      if (!error) out.supabase.profile = Array.isArray(data) ? data : null;
      else out.supabase.error = error.message;
    }
  }
} catch (e) {
  out.supabase.configured = false;
  out.supabase.error = String(e?.message || e);
}

// ── Heuristics / conclusions ────────────────────────────────────────────────
if (!sqliteStaff) {
  out.conclusions.push(
    'No matching SQLite staff row found. If shifts are imported by staff name, confirm the staff name in Shifter/Excel matches exactly (including spaces). If shifts are assigned manually, confirm you selected the correct staff member.',
  );
} else {
  if (sqliteStaff.archived_at) {
    out.conclusions.push('Staff is archived in SQLite. Archived staff may not appear in pickers; confirm shifts are assigned to this staff id.');
  }
  if (!sqliteStaff.email) {
    out.conclusions.push(
      'SQLite staff row has no email. Mirroring to Nexus Supabase (for Shifter delivery) matches profiles by staff email, so this will block delivery.',
    );
  }
  if (out.sqlite.shift_counts && out.sqlite.shift_counts.total === 0) {
    out.conclusions.push('SQLite shows 0 shifts for this staff_id. The issue may be matching/assignment (not delivery).');
  }
}

if (out.supabase.configured) {
  if (!out.supabase.profile) {
    out.conclusions.push(
      'Supabase is configured but no matching profile was found for the provided id/email. If shifts are mirrored using staff email → profile lookup, this prevents delivery. Ensure the staff email matches the Supabase profile email.',
    );
  }
} else {
  out.conclusions.push(
    'Supabase service-role is not configured in this environment, so shift mirroring/delivery to the worker app may be disabled here. Check production env has SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set.',
  );
}

console.log(safeJson(out));

