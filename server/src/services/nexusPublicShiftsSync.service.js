/**
 * Mirrors SQLite shifts to Nexus Core Supabase public.shifts so Database Webhooks
 * (e.g. push-shift-to-shifter) can run. staff_id is set to public.profiles.id (matched by staff email).
 */
import { db } from '../db/index.js';
import {
  getSupabaseServiceRoleClient,
  getShifterServiceRoleClient,
  provisionNexusSupabaseProfileForStaff,
  resolveEffectiveShifterOrgIdForNexusOrg,
} from './supabaseStaffShifter.service.js';

function normalizeEmail(email) {
  if (email == null || typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

function escapeIlikeLiteral(s) {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function isUuid(s) {
  return (
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim())
  );
}

/** SQLite / CRM datetime string → ISO for timestamptz */
function sqliteTimeToIso(s) {
  if (s == null || typeof s !== 'string') return null;
  const t = s.trim().replace(' ', 'T');
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

async function findNexusProfileIdByStaffEmail(admin, emailRaw) {
  const emailKey = normalizeEmail(emailRaw);
  if (!emailKey) return null;

  let { data: rows, error } = await admin.from('profiles').select('id').eq('email', emailKey).limit(2);
  if (error) throw error;
  if (rows?.length > 1) {
    console.warn('[nexus-public-shifts] multiple profiles for email, using first', emailKey);
    return rows[0].id;
  }
  if (rows?.[0]?.id) return rows[0].id;

  const pat = escapeIlikeLiteral(emailKey);
  const { data: ilikeRows, error: ilikeErr } = await admin
    .from('profiles')
    .select('id')
    .ilike('email', pat)
    .limit(2);
  if (ilikeErr) throw ilikeErr;
  if (ilikeRows?.length > 1) {
    console.warn('[nexus-public-shifts] ambiguous ilike profile for', emailKey);
    return ilikeRows[0].id;
  }
  return ilikeRows?.[0]?.id ?? null;
}

function runDeferred(fn) {
  if (typeof queueMicrotask === 'function') queueMicrotask(fn);
  else setImmediate(fn);
}
const _profileProvisionBlockedEmails = new Set();

function pickFirstNonEmptyString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

async function findShifterClientIdByName(shifter, clientNameRaw, shifterOrgId, clientEmailRaw = null) {
  const clientName = String(clientNameRaw || '').trim();
  const clientEmail = normalizeEmail(clientEmailRaw || '');
  if (!clientName && !clientEmail) return null;

  const tables = ['clients', 'participants', 'client_profiles'];
  const nameCols = ['name', 'client_name', 'participant_name'];
  const emailCols = ['email', 'client_email', 'participant_email'];
  const orgCols = ['org_id', 'organization_id', 'org', 'organisation_id'];
  const exactName = clientName ? escapeIlikeLiteral(clientName) : null;
  const fuzzyName = clientName ? `%${escapeIlikeLiteral(clientName)}%` : null;

  for (const table of tables) {
    if (clientEmail) {
      const emailPat = escapeIlikeLiteral(clientEmail);
      for (const emailCol of emailCols) {
        if (shifterOrgId) {
          for (const orgCol of orgCols) {
            const { data, error } = await shifter
              .from(table)
              .select('*')
              .ilike(emailCol, emailPat)
              .eq(orgCol, shifterOrgId)
              .limit(2);
            if (error) continue;
            const rows = data || [];
            if (!rows.length) continue;
            return pickFirstNonEmptyString(rows[0], ['id', 'client_id', 'participant_id', 'profile_id']);
          }
        }
        // Never cross org boundaries: only run unscoped email lookup when no org scope exists.
        if (!shifterOrgId) {
          const { data, error } = await shifter.from(table).select('*').ilike(emailCol, emailPat).limit(2);
          if (error) continue;
          const rows = data || [];
          if (!rows.length) continue;
          return pickFirstNonEmptyString(rows[0], ['id', 'client_id', 'participant_id', 'profile_id']);
        }
      }
    }

    if (!exactName && !fuzzyName) continue;
    for (const nameCol of nameCols) {
      if (shifterOrgId) {
        for (const orgCol of orgCols) {
          const { data, error } = await shifter
            .from(table)
            .select('*')
            .ilike(nameCol, exactName)
            .eq(orgCol, shifterOrgId)
            .limit(2);
          if (error) continue;
          const rows = data || [];
          if (!rows.length) continue;
          return pickFirstNonEmptyString(rows[0], ['id', 'client_id', 'participant_id', 'profile_id']);
        }
      }

      // Never cross org boundaries: only run unscoped name lookup when no org scope exists.
      if (!shifterOrgId) {
        const { data, error } = await shifter.from(table).select('*').ilike(nameCol, exactName).limit(2);
        if (error) continue;
        const rows = data || [];
        if (rows.length) {
          return pickFirstNonEmptyString(rows[0], ['id', 'client_id', 'participant_id', 'profile_id']);
        }
      }

      // Loose contains match for cases where Shifter stores suffix/prefix labels.
      if (fuzzyName && !shifterOrgId) {
        const { data: fuzzyRows, error: fuzzyErr } = await shifter.from(table).select('*').ilike(nameCol, fuzzyName).limit(2);
        if (fuzzyErr) continue;
        const fr = fuzzyRows || [];
        if (!fr.length) continue;
        return pickFirstNonEmptyString(fr[0], ['id', 'client_id', 'participant_id', 'profile_id']);
      }
    }
  }

  return null;
}

async function upsertShiftDirectlyToShifter({
  shiftId,
  workerProfileId,
  scheduledStartIso,
  scheduledEndIso,
  clientName,
  clientEmail,
  nexusOrgId,
  status,
}) {
  if (!workerProfileId) return { ok: false, skipped: true, reason: 'no_shifter_worker_profile_id' };
  const shifter = getShifterServiceRoleClient();
  if (!shifter) return { ok: false, skipped: true, reason: 'shifter_not_configured' };
  if (!isUuid(nexusOrgId)) {
    return { ok: false, skipped: true, reason: 'no_valid_nexus_org_id' };
  }

  let shifterOrgId = null;
  try {
    shifterOrgId = await resolveEffectiveShifterOrgIdForNexusOrg(nexusOrgId.trim());
  } catch (e) {
    console.warn('[nexus-public-shifts] resolve shifter org failed', shiftId, e?.message || e);
  }
  if (!isUuid(shifterOrgId)) {
    return { ok: false, skipped: true, reason: 'no_valid_shifter_org_id' };
  }
  const shifterClientId = await findShifterClientIdByName(shifter, clientName, shifterOrgId, clientEmail);

  const upsertRow = {
    nexuscore_shift_id: shiftId,
    worker_id: workerProfileId,
    scheduled_start: scheduledStartIso,
    scheduled_end: scheduledEndIso,
    client: clientName || null,
    client_id: shifterClientId || null,
    org_id: shifterOrgId.trim(),
    org: shifterOrgId.trim(),
    status: status || 'scheduled',
  };

  const cleanupForSchemaMismatch = (payload, msg) => {
    if (msg.includes("Could not find the 'client' column")) {
      delete payload.client;
      return true;
    }
    if (msg.includes("Could not find the 'client_id' column")) {
      delete payload.client_id;
      return true;
    }
    if (msg.includes("Could not find the 'org' column")) {
      delete payload.org;
      return true;
    }
    if (msg.includes("Could not find the 'org_id' column")) {
      delete payload.org_id;
      return true;
    }
    return false;
  };

  let payload = { ...upsertRow };
  for (let attempt = 0; attempt < 4; attempt++) {
    const { error } = await shifter.from('shifts').upsert(payload, { onConflict: 'nexuscore_shift_id' });
    if (!error) return { ok: true };

    const msg = String(error.message || '');
    if (cleanupForSchemaMismatch(payload, msg)) continue;

    if (msg.includes('no unique or exclusion constraint matching the ON CONFLICT specification')) {
      // Some Shifter projects don't enforce unique(nexuscore_shift_id).
      // Fallback: update by nexuscore_shift_id, and if nothing matched then insert.
      const { data: updatedRows, error: updErr } = await shifter
        .from('shifts')
        .update(payload)
        .eq('nexuscore_shift_id', shiftId)
        .select('nexuscore_shift_id')
        .limit(1);
      if (!updErr && updatedRows?.length) return { ok: true };
      if (updErr) {
        const updMsg = String(updErr.message || '');
        if (cleanupForSchemaMismatch(payload, updMsg)) continue;
        console.warn('[nexus-public-shifts] direct shifter update failed', shiftId, updMsg);
        return { ok: false, error: updMsg };
      }

      const { error: insErr } = await shifter.from('shifts').insert(payload);
      if (!insErr) return { ok: true };
      const insMsg = String(insErr.message || '');
      if (cleanupForSchemaMismatch(payload, insMsg)) continue;
      console.warn('[nexus-public-shifts] direct shifter insert failed', shiftId, insMsg);
      return { ok: false, error: insMsg };
    }

    if (msg.includes('shifts_client_id_fkey')) {
      const retryClientId = await findShifterClientIdByName(shifter, clientName, shifterOrgId, clientEmail);
      if (retryClientId && retryClientId !== payload.client_id) {
        payload.client_id = retryClientId;
        continue;
      }
    }

    console.warn('[nexus-public-shifts] direct shifter upsert failed', shiftId, msg);
    return { ok: false, error: msg };
  }
  console.warn('[nexus-public-shifts] direct shifter upsert failed', shiftId, 'schema_mismatch_after_retries');
  return { ok: false, error: 'schema_mismatch_after_retries' };
}

/**
 * Upsert public.shifts from the SQLite row (by shift id).
 * If Supabase already has status completed (e.g. sync-completed-shift) but SQLite is still scheduled,
 * completion and actual times are preserved so Shifter completions are not regressed.
 */
export async function mirrorShiftToNexusSupabase(shiftId) {
  const admin = getSupabaseServiceRoleClient();
  if (!admin) return { ok: false, skipped: true, reason: 'supabase_not_configured' };

  const row = db
    .prepare(
      `
    SELECT s.*, p.name AS participant_name, p.provider_org_id, p.email AS participant_email,
           st.id AS sqlite_staff_id,
           st.email AS staff_email,
           st.shifter_worker_profile_id,
           st.role AS staff_role,
           st.org_id AS staff_org_id
    FROM shifts s
    JOIN participants p ON s.participant_id = p.id
    JOIN staff st ON s.staff_id = st.id
    WHERE s.id = ?
  `,
    )
    .get(shiftId);

  if (!row) return { ok: false, skipped: true, reason: 'shift_not_found' };

  const startIso = sqliteTimeToIso(row.start_time);
  const endIso = sqliteTimeToIso(row.end_time);
  if (!startIso || !endIso) {
    console.warn('[nexus-public-shifts] invalid times', shiftId, row.start_time, row.end_time);
    return { ok: false, skipped: true, reason: 'invalid_times' };
  }

  let profileStaffId = null;
  try {
    profileStaffId = await findNexusProfileIdByStaffEmail(admin, row.staff_email);
  } catch (e) {
    console.warn('[nexus-public-shifts] profile lookup failed', shiftId, e.message);
  }

  if (!profileStaffId && row.staff_email) {
    const emailKey = normalizeEmail(row.staff_email);
    const provisionBlocked = emailKey && _profileProvisionBlockedEmails.has(emailKey);
    if (provisionBlocked) {
      console.warn('[nexus-public-shifts] profile auto-provision disabled for email due to prior auth-admin failure', {
        shiftId,
        staff_email: row.staff_email || null,
      });
    } else {
    try {
      const provision = await provisionNexusSupabaseProfileForStaff(row.staff_email, row.staff_org_id || row.provider_org_id || null, {
        staffRole: row.staff_role || null,
      });
      if (provision?.ok) {
        profileStaffId = await findNexusProfileIdByStaffEmail(admin, row.staff_email);
      } else if (!provision?.skipped) {
        console.warn('[nexus-public-shifts] profile provision failed', shiftId, provision?.error || 'unknown');
        if (/valid Bearer token/i.test(String(provision?.error || '')) && emailKey) {
          _profileProvisionBlockedEmails.add(emailKey);
        }
      }
    } catch (e) {
      console.warn('[nexus-public-shifts] profile provision error', shiftId, e?.message || e);
      if (/valid Bearer token/i.test(String(e?.message || '')) && emailKey) {
        _profileProvisionBlockedEmails.add(emailKey);
      }
    }
    }
  }

  if (!profileStaffId) {
    console.warn('[nexus-public-shifts] no Supabase profile match for staff email; skipping shift mirror to avoid RLS failure', {
      shiftId,
      sqlite_staff_id: row.sqlite_staff_id,
      staff_email: row.staff_email || null,
    });
    return { ok: false, skipped: true, reason: 'staff_profile_missing' };
  }

  const localStatus = row.status || 'scheduled';

  const { data: existing, error: fetchErr } = await admin
    .from('shifts')
    .select('status, actual_start, actual_end')
    .eq('id', row.id)
    .maybeSingle();
  if (fetchErr) console.warn('[nexus-public-shifts] fetch existing row', fetchErr.message);

  const payload = {
    id: row.id,
    participant_id: row.participant_id,
    staff_id: profileStaffId,
    scheduled_start: startIso,
    scheduled_end: endIso,
    start_time: startIso,
    end_time: endIso,
    client: row.participant_name,
    client_name: row.participant_name,
    client_id: row.participant_id,
    org_id: isUuid(row.provider_org_id) ? row.provider_org_id.trim() : null,
    status: localStatus,
    notes: row.notes ?? null,
    updated_at: new Date().toISOString(),
  };

  if (localStatus === 'completed') {
    payload.actual_start = startIso;
    payload.actual_end = endIso;
  } else if (existing?.status === 'completed') {
    payload.status = 'completed';
    if (existing.actual_start) payload.actual_start = existing.actual_start;
    if (existing.actual_end) payload.actual_end = existing.actual_end;
  }

  const { error } = await admin.from('shifts').upsert(payload, { onConflict: 'id' });
  if (error) {
    console.warn('[nexus-public-shifts] upsert failed', shiftId, error.message);
    return { ok: false, error: error.message };
  }

  // Primary path is DB webhook -> push-shift-to-shifter. Also perform direct upsert so
  // worker app remains in sync even if webhook routing/config is delayed.
  const directPush = await upsertShiftDirectlyToShifter({
    shiftId: row.id,
    workerProfileId: row.shifter_worker_profile_id || null,
    scheduledStartIso: startIso,
    scheduledEndIso: endIso,
    clientName: row.participant_name || null,
    clientEmail: row.participant_email || null,
    nexusOrgId: row.provider_org_id || row.staff_org_id || null,
    status: payload.status,
  });
  if (!directPush.ok && !directPush.skipped) {
    console.warn('[nexus-public-shifts] direct push fallback failed', shiftId, directPush.error || directPush.reason);
  }

  return { ok: true };
}

export function scheduleMirrorShiftToNexusSupabase(shiftId) {
  if (!shiftId) return;
  runDeferred(() => {
    mirrorShiftToNexusSupabase(shiftId).catch((e) =>
      console.warn('[nexus-public-shifts] mirror error', e?.message || e),
    );
  });
}

export async function removeShiftFromNexusSupabase(shiftId) {
  const admin = getSupabaseServiceRoleClient();
  if (!admin) return { ok: false, skipped: true, reason: 'supabase_not_configured' };

  const { error } = await admin.from('shifts').delete().eq('id', shiftId);
  if (error) {
    console.warn('[nexus-public-shifts] delete failed', shiftId, error.message);
    return { ok: false, error: error.message };
  }

  const shifter = getShifterServiceRoleClient();
  if (shifter) {
    const { error: shifterErr } = await shifter.from('shifts').delete().eq('nexuscore_shift_id', shiftId);
    if (shifterErr) {
      console.warn('[nexus-public-shifts] direct shifter delete failed', shiftId, shifterErr.message);
    }
  }
  return { ok: true };
}

export function scheduleRemoveShiftFromNexusSupabase(shiftId) {
  if (!shiftId) return;
  runDeferred(() => {
    removeShiftFromNexusSupabase(shiftId).catch((e) =>
      console.warn('[nexus-public-shifts] delete error', e?.message || e),
    );
  });
}

let _fullMirrorRunning = false;

/**
 * Re-mirror every SQLite shift to public.shifts (backfill, cron, or periodic reconciliation).
 * Skips when Supabase is not configured. Serialized so overlapping runs do not stack.
 */
export async function mirrorAllShiftsToNexusSupabase() {
  if (_fullMirrorRunning) {
    return { skipped: true, reason: 'already_running' };
  }
  const admin = getSupabaseServiceRoleClient();
  if (!admin) {
    return { total: 0, mirrored: 0, skipped_count: 0, failed: 0, skipped: true, reason: 'supabase_not_configured' };
  }

  const ids = db.prepare('SELECT id FROM shifts').all().map((r) => r.id);
  _fullMirrorRunning = true;
  let mirrored = 0;
  let skippedCount = 0;
  let failed = 0;
  try {
    for (const id of ids) {
      const r = await mirrorShiftToNexusSupabase(id);
      if (r.ok) mirrored++;
      else if (r.skipped) skippedCount++;
      else failed++;
    }
  } finally {
    _fullMirrorRunning = false;
  }
  return { total: ids.length, mirrored, skipped_count: skippedCount, failed };
}

/** Re-mirror all shifts assigned to a SQLite staff row (e.g. after email change updates profile link). */
export function scheduleMirrorShiftsForStaffSqliteId(staffSqliteId) {
  if (!staffSqliteId) return;
  const ids = db.prepare('SELECT id FROM shifts WHERE staff_id = ?').all(staffSqliteId).map((r) => r.id);
  for (const id of ids) scheduleMirrorShiftToNexusSupabase(id);
}

/** Re-mirror shifts for a participant (e.g. after client name change for Shifter display). */
export function scheduleMirrorShiftsForParticipantId(participantId) {
  if (!participantId) return;
  const ids = db.prepare('SELECT id FROM shifts WHERE participant_id = ?').all(participantId).map((r) => r.id);
  for (const id of ids) scheduleMirrorShiftToNexusSupabase(id);
}
