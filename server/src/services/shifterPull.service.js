import {
  getShifterServiceRoleClient,
  resolveEffectiveShifterOrgIdForNexusOrg,
  getShifterOrgTimezoneSpecForNexusOrg,
} from './supabaseStaffShifter.service.js';
import { agentDebugIngest460342 } from '../lib/debugAgent460342.js';
import { DateTime, FixedOffsetZone } from 'luxon';

// Prefer nexus_shifts when available: it is normalized for Nexus (correct start/finish + travel fields).
const SHIFT_TABLE_CANDIDATES = ['nexus_shifts', 'shifts'];
// Some Shifter deployments store travel/time/km in a separate "captured shift data" table.
// We probe a few common names and merge captured fields into the base shift rows.
const CAPTURE_TABLE_CANDIDATES = [
  'captured_shift_data',
  'captured_shift_datas',
  'captured_shifts',
  'shift_captures',
  'shift_capture',
  'captured_shift',
  'captured_shifts_data',
  'captured_shift_records',
  'captured_shift_record',
];
const ORG_COLUMN_CANDIDATES = [
  // nexus_shifts commonly has nexus-org scoping
  'nexus_org_id',
  'nexuscore_org_id',
  'nexus_org',
  'org',
  'org_id',
  'organization_id',
  'organisation_id',
  'organization_profile_id',
  'organisation_profile_id',
  'profile_id',
];
const PAGE_SIZE = 1000;
const LOOKUP_CHUNK = 150;

function isUuidString(s) {
  return (
    typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim())
  );
}

function pickString(row, keys) {
  for (const key of keys) {
    const val = row?.[key];
    if (val == null) continue;
    const s = String(val).trim();
    if (s) return s;
  }
  return '';
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function pickNumber(row, keys) {
  for (const key of keys) {
    if (row?.[key] == null || row?.[key] === '') continue;
    const n = toNumberOrNull(row[key]);
    if (n != null) return n;
  }
  return null;
}

function toIsoDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const yyyyMmDd = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (yyyyMmDd) return `${yyyyMmDd[1]}-${yyyyMmDd[2]}-${yyyyMmDd[3]}`;
  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return `${slash[3]}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}`;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function tzSpecToLuxonZone(tzSpec) {
  if (!tzSpec) return null;
  if (tzSpec.kind === 'iana' && tzSpec.zone) return tzSpec.zone;
  if (tzSpec.kind === 'fixed' && Number.isFinite(tzSpec.offsetMinutes)) {
    return FixedOffsetZone.instance(tzSpec.offsetMinutes);
  }
  return null;
}

function toIsoDateInZone(value, tzSpec) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const yyyyMmDd = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (yyyyMmDd) return `${yyyyMmDd[1]}-${yyyyMmDd[2]}-${yyyyMmDd[3]}`;
  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return `${slash[3]}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}`;

  const zone = tzSpecToLuxonZone(tzSpec);
  if (zone) {
    const dt = DateTime.fromISO(raw, { zone: 'utc' });
    if (dt.isValid) return dt.setZone(zone).toFormat('yyyy-LL-dd');
  }
  return toIsoDate(raw);
}

function toHm(value, tzSpec) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const m = raw.match(/(\d{1,2}):(\d{2})/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  const zone = tzSpecToLuxonZone(tzSpec);
  if (zone) {
    const dt = DateTime.fromISO(raw, { zone: 'utc' });
    if (dt.isValid) return dt.setZone(zone).toFormat('HH:mm');
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dateFromDateOrTimestamp(row, tzSpec) {
  const fromDateField = pickString(row, ['date', 'shift_date', 'support_date']);
  if (fromDateField) return toIsoDate(fromDateField);
  const fromTs = pickString(row, ['scheduled_start', 'start_time', 'start_at']);
  return toIsoDateInZone(fromTs, tzSpec);
}

function mapTravelKm(row) {
  const direct = pickNumber(row, [
    'travel_km',
    'travelKm',
    'kms',
    'km',
    'distance_km',
    'travel_distance_km',
    'participant_travel_km',
    'mileage_km',
    'mileage',
    'total_km',
    'travel_distance',
    'kms_travelled',
    'kms_traveled',
  ]);
  if (direct != null) return direct;

  const nested = row?.travel;
  if (nested && typeof nested === 'object') {
    return (
      pickNumber(nested, ['km', 'kms', 'distance_km', 'distance', 'participant_km', 'travel_km']) ?? null
    );
  }
  return null;
}

function mapTravelTimeMinutes(row) {
  const direct = pickNumber(row, [
    'travel_time_min',
    'travel_time_minutes',
    'travelTimeMinutes',
    'travel_minutes',
    'travel_mins',
    'travel_duration_min',
    'travel_duration_minutes',
    'travel_duration',
    'travel_time',
    'provider_travel_minutes',
    'provider_travel_mins',
    'travel_time_mins',
  ]);
  if (direct != null) return direct;

  const nested = row?.travel;
  if (nested && typeof nested === 'object') {
    const mins = pickNumber(nested, ['minutes', 'mins', 'travel_time_min', 'travel_time_minutes', 'duration_minutes']);
    if (mins != null) return mins;
    const hours = pickNumber(nested, ['hours', 'duration_hours']);
    if (hours != null) return Math.round(hours * 60);
  }
  return null;
}

function profileLabelFromRow(p) {
  if (!p || typeof p !== 'object') return '';
  const fromName = pickString(p, ['display_name', 'full_name', 'name', 'preferred_name']);
  if (fromName) return fromName;
  return pickString(p, ['email']);
}

/**
 * Shifter Schedule / Progress stores shifts with worker_id → profiles and client_id → clients.
 * Raw select('*') has no staff_name / client_name; resolve labels for Nexus matching.
 */
async function fetchProfileLabelsByIds(shifterAdmin, ids, logWarn) {
  const map = new Map();
  const unique = [...new Set((ids || []).filter((id) => isUuidString(String(id))))];
  if (unique.length === 0 || !shifterAdmin) return map;

  for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
    const chunk = unique.slice(i, i + LOOKUP_CHUNK);
    const { data, error } = await shifterAdmin.from('profiles').select('id, display_name, email').in('id', chunk);
    if (error) {
      if (logWarn) logWarn('Shifter profiles lookup failed (staff names)', { message: error.message });
      break;
    }
    for (const p of data || []) {
      const id = p?.id != null ? String(p.id).trim() : '';
      const label = profileLabelFromRow(p);
      if (id && label) map.set(id, label);
    }
  }
  return map;
}

async function fetchClientLabelsByIds(shifterAdmin, ids, logWarn) {
  const map = new Map();
  const unique = [...new Set((ids || []).filter((id) => isUuidString(String(id))))];
  if (unique.length === 0 || !shifterAdmin) return map;

  for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
    const chunk = unique.slice(i, i + LOOKUP_CHUNK);
    const { data, error } = await shifterAdmin.from('clients').select('id, name').in('id', chunk);
    if (error) {
      if (logWarn) logWarn('Shifter clients lookup failed (client names)', { message: error.message });
      break;
    }
    for (const c of data || []) {
      const id = c?.id != null ? String(c.id).trim() : '';
      const name = pickString(c, ['name', 'client_name', 'display_name']);
      if (id && name) map.set(id, name);
    }
  }
  return map;
}

function collectWorkerIdsForLookup(rows) {
  const ids = [];
  for (const row of rows || []) {
    for (const key of ['worker_id', 'user_id', 'staff_id']) {
      const v = row?.[key];
      if (v == null || v === '') continue;
      const s = String(v).trim();
      if (isUuidString(s)) ids.push(s);
    }
  }
  return ids;
}

function collectClientIdsForLookup(rows) {
  const ids = [];
  for (const row of rows || []) {
    for (const key of ['client_id', 'participant_id']) {
      const v = row?.[key];
      if (v == null || v === '') continue;
      const s = String(v).trim();
      if (isUuidString(s)) ids.push(s);
    }
  }
  return ids;
}

function collectShiftIdsForProgressNotes(rows) {
  const ids = [];
  for (const row of rows || []) {
    const sid = pickString(row, ['shift_id', 'id', 'external_shift_id']);
    if (sid && isUuidString(sid)) ids.push(sid);
  }
  return ids;
}

function collectShiftIdsForCaptureLookup(mappedShifts) {
  const ids = [];
  for (const s of mappedShifts || []) {
    const sid = String(s?.shiftId || '').trim();
    if (sid && isUuidString(sid)) ids.push(sid);
  }
  return [...new Set(ids)];
}

function captureShiftIdFromRow(row) {
  return pickString(row, [
    'shift_id',
    'shifts_id',
    'parent_shift_id',
    'source_shift_id',
    'external_shift_id',
    'nexuscore_shift_id',
    'nexus_shift_id',
    'shiftId',
  ]);
}

function mergeCapturedFieldsIntoShift(mappedShift, capturedRow) {
  if (!mappedShift || !capturedRow) return mappedShift;
  const next = { ...mappedShift };

  const km = mapTravelKm(capturedRow);
  if (next.travelKm == null && km != null) next.travelKm = km;

  const mins = mapTravelTimeMinutes(capturedRow);
  if (next.travelTimeMinutes == null && mins != null) next.travelTimeMinutes = mins;

  // Some schemas store expenses on capture rows.
  const exp = toNumberOrNull(capturedRow?.expenses);
  if (next.expenses == null && exp != null) next.expenses = exp;

  const notes = pickString(capturedRow, [
    'session_details',
    'session_notes',
    'completion_notes',
    'notes',
  ]);
  if (!next.sessionDetails && notes) next.sessionDetails = notes;

  return next;
}

async function fetchCapturedShiftDataByShiftIds(shifterAdmin, shiftIds, logWarn) {
  const unique = [...new Set((shiftIds || []).filter((id) => isUuidString(String(id))))];
  if (unique.length === 0 || !shifterAdmin) return { table: null, byShiftId: new Map() };

  let best = { table: null, byShiftId: new Map() };

  for (const table of CAPTURE_TABLE_CANDIDATES) {
    const byShiftId = new Map();
    let anyOk = false;

    for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
      const chunk = unique.slice(i, i + LOOKUP_CHUNK);
      // Try common foreign key column names; first one that works wins for this table.
      const fkCols = ['shift_id', 'shifts_id', 'parent_shift_id', 'source_shift_id', 'external_shift_id', 'nexuscore_shift_id'];
      let chunkRows = null;
      for (const fk of fkCols) {
        const { data, error } = await shifterAdmin.from(table).select('*').in(fk, chunk).limit(10000);
        if (error) continue;
        chunkRows = data || [];
        anyOk = true;
        break;
      }
      if (!anyOk) {
        if (logWarn) logWarn('Shifter captured shift lookup failed', { table, message: 'no_matching_fk_column' });
        byShiftId.clear();
        break;
      }

      for (const row of chunkRows || []) {
        const sid = captureShiftIdFromRow(row);
        if (!sid) continue;
        if (!byShiftId.has(sid)) byShiftId.set(sid, row);
      }
    }

    if (anyOk && byShiftId.size > best.byShiftId.size) {
      best = { table, byShiftId };
    }
  }

  return best;
}

/**
 * Shifter mobile stores completion narrative in public.progress_notes.notes, not on shifts.session_details.
 * Latest note per shift wins (ordered by created_at DESC).
 */
async function fetchProgressNotesByShiftIds(shifterAdmin, shiftIds, logWarn) {
  const map = new Map();
  const unique = [...new Set((shiftIds || []).filter((id) => isUuidString(String(id))))];
  if (unique.length === 0 || !shifterAdmin) return map;

  for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
    const chunk = unique.slice(i, i + LOOKUP_CHUNK);
    const { data, error } = await shifterAdmin
      .from('progress_notes')
      .select('shift_id, notes, created_at')
      .in('shift_id', chunk)
      .order('created_at', { ascending: false });

    if (error) {
      if (logWarn) logWarn('Shifter progress_notes lookup failed (shift notes)', { message: error.message });
      break;
    }
    for (const row of data || []) {
      const sid = row?.shift_id != null ? String(row.shift_id).trim() : '';
      const text = String(row?.notes || '').trim();
      if (!sid || !text) continue;
      if (!map.has(sid)) map.set(sid, text);
    }
  }
  return map;
}

async function buildShiftRowNameLookups(shifterAdmin, rows, logWarn) {
  const workerIds = collectWorkerIdsForLookup(rows);
  const clientIds = collectClientIdsForLookup(rows);
  const shiftIds = collectShiftIdsForProgressNotes(rows);
  const [profileById, clientById, progressNoteByShiftId] = await Promise.all([
    fetchProfileLabelsByIds(shifterAdmin, workerIds, logWarn),
    fetchClientLabelsByIds(shifterAdmin, clientIds, logWarn),
    fetchProgressNotesByShiftIds(shifterAdmin, shiftIds, logWarn),
  ]);
  return { profileById, clientById, progressNoteByShiftId };
}

function mapShifterRowToWebhookShift(row, lookups = null, tzSpec = null) {
  const profileById = lookups?.profileById;
  const clientById = lookups?.clientById;
  const progressNoteByShiftId = lookups?.progressNoteByShiftId;

  // nexus_shifts often stores the Nexus shift id under nexuscore_shift_id.
  const shiftId = pickString(row, ['nexuscore_shift_id', 'shift_id', 'id', 'external_shift_id']);
  const date = dateFromDateOrTimestamp(row, tzSpec);
  const startTime = toHm(pickString(row, ['start_time', 'scheduled_start', 'start_at']), tzSpec) || '09:00';
  const finishTime = toHm(pickString(row, ['end_time', 'scheduled_end', 'end_at']), tzSpec) || '17:00';
  let staffName = pickString(row, ['staff_name', 'worker_name', 'carer_name']);
  if (!staffName && profileById?.size) {
    const wid = pickString(row, ['worker_id', 'user_id', 'staff_id']);
    if (wid && profileById.has(wid)) staffName = profileById.get(wid);
  }
  let clientName = pickString(row, ['client_name', 'participant_name']);
  const clientRaw = row?.client != null && row?.client !== '' ? String(row.client).trim() : '';
  if (!clientName && clientRaw && !isUuidString(clientRaw)) clientName = clientRaw;
  if (!clientName && clientById?.size) {
    const cid = pickString(row, ['client_id', 'participant_id']);
    if (cid && clientById.has(cid)) clientName = clientById.get(cid);
  }
  const travelKm = mapTravelKm(row);
  const travelTimeMinutes = mapTravelTimeMinutes(row);
  const expenses = toNumberOrNull(row.expenses);
  const duration = toNumberOrNull(row.duration ?? row.duration_hours ?? row.duration_minutes);

  const fromRowSession = pickString(row, [
    'session_details',
    'session_notes',
    'shift_notes',
    'completion_notes',
    'progress_note',
    'notes',
  ]);
  const fromProgressNote = shiftId && progressNoteByShiftId?.get(shiftId) ? String(progressNoteByShiftId.get(shiftId)).trim() : '';
  let sessionDetails = '';
  if (fromProgressNote && fromRowSession) {
    sessionDetails = fromProgressNote === fromRowSession.trim() ? fromProgressNote : `${fromRowSession.trim()}\n\n${fromProgressNote}`;
  } else {
    sessionDetails = fromProgressNote || fromRowSession || '';
  }

  return {
    shiftId,
    date,
    staffName,
    clientName,
    startTime,
    finishTime,
    duration,
    travelKm,
    travelTimeMinutes,
    expenses,
    incidents: pickString(row, ['incidents']),
    mood: pickString(row, ['mood']),
    sessionDetails,
    medicationChecks: row.medication_checks || {},
  };
}

function dateInRange(isoDate, fromDate, toDate) {
  if (!isoDate) return false;
  if (fromDate && isoDate < fromDate) return false;
  if (toDate && isoDate > toDate) return false;
  return true;
}

async function fetchRowsByOrgFromTable(shifterAdmin, table, orgCol, shifterOrgId, limit) {
  const allRows = [];
  let offset = 0;

  while (allRows.length < limit) {
    const upper = Math.min(offset + PAGE_SIZE - 1, limit - 1);
    const { data, error } = await shifterAdmin
      .from(table)
      .select('*')
      .eq(orgCol, shifterOrgId)
      .range(offset, upper);

    if (error) return { ok: false, error };

    const rows = data || [];
    allRows.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return { ok: true, rows: allRows };
}

export async function pullShiftsFromShifterSupabase(options = {}) {
  const log = options.log || (() => {});
  const logWarn = options.logWarn || (() => {});
  const nexusOrgId = options.nexusOrgId || null;
  const fromDate = options.fromDate ? toIsoDate(options.fromDate) : '';
  const toDate = options.toDate ? toIsoDate(options.toDate) : '';
  const limit = Math.max(1, Math.min(Number(options.limit) || 5000, 50000));

  if (!nexusOrgId) {
    throw new Error('nexusOrgId is required to pull shifts from Shifter Supabase');
  }

  const shifterAdmin = getShifterServiceRoleClient();
  if (!shifterAdmin) {
    throw new Error('Shifter Supabase is not configured (SHIFTER_SUPABASE_URL / SHIFTER_SERVICE_ROLE_KEY)');
  }

  const shifterOrgId = await resolveEffectiveShifterOrgIdForNexusOrg(nexusOrgId);
  if (!shifterOrgId) {
    throw new Error('Could not resolve Shifter org id for this Nexus organisation');
  }

  let tzSpec = null;
  try {
    tzSpec = await getShifterOrgTimezoneSpecForNexusOrg(nexusOrgId);
  } catch (e) {
    logWarn('Failed to resolve org timezone for Shifter pull; using raw timestamps', { message: e?.message || String(e) });
    tzSpec = null;
  }

  let pulledRows = [];
  let matchedTable = null;
  let matchedOrgCol = null;
  let lastError = null;
  let successfulProbeCount = 0;

  for (const table of SHIFT_TABLE_CANDIDATES) {
    for (const orgCol of ORG_COLUMN_CANDIDATES) {
      const scopedOrgId =
        table === 'nexus_shifts' && /nexus/i.test(String(orgCol || ''))
          ? String(nexusOrgId)
          : String(shifterOrgId);
      const result = await fetchRowsByOrgFromTable(shifterAdmin, table, orgCol, scopedOrgId, limit);
      if (!result.ok) {
        lastError = result.error;
        continue;
      }
      successfulProbeCount += 1;
      // Prefer the candidate that returns the largest set for this org id.
      if (!matchedTable || result.rows.length > pulledRows.length) {
        pulledRows = result.rows;
        matchedTable = table;
        matchedOrgCol = orgCol;
      }
    }
  }

  if (!matchedTable || successfulProbeCount === 0) {
    const reason = lastError?.message ? ` (${lastError.message})` : '';
    // #region agent log
    agentDebugIngest460342({
      hypothesisId: 'H3',
      location: 'shifterPull.service.js:pullShiftsFromShifterSupabase',
      message: 'shifter_probe_zero_rows',
      data: {
        nexusOrgId: String(nexusOrgId),
        shifterOrgId: String(shifterOrgId),
        successfulProbeCount,
        lastErrorMsg: lastError?.message ? String(lastError.message).slice(0, 200) : null,
      },
    });
    // #endregion
    throw new Error(`Unable to query Shifter shifts by organisation${reason}`);
  }

  const lookups = await buildShiftRowNameLookups(shifterAdmin, pulledRows, logWarn);
  let mapped = pulledRows.map((row) => mapShifterRowToWebhookShift(row, lookups, tzSpec));

  // If travel/time/km were stored in a separate "captured shift data" table, merge them in.
  // This is important for Nexus billing because travel charges are created from travelKm/travelTimeMinutes.
  try {
    const shiftIds = collectShiftIdsForCaptureLookup(mapped);
    const captured = await fetchCapturedShiftDataByShiftIds(shifterAdmin, shiftIds, logWarn);
    if (captured?.byShiftId?.size) {
      mapped = mapped.map((s) => {
        const row = captured.byShiftId.get(s.shiftId);
        return row ? mergeCapturedFieldsIntoShift(s, row) : s;
      });
    }
  } catch (e) {
    if (logWarn) logWarn('Shifter captured shift merge failed', { message: e?.message || String(e) });
  }
  const filteredByDate = mapped.filter((s) => dateInRange(s.date, fromDate, toDate));
  const valid = filteredByDate.filter((s) => s.shiftId && s.date);
  const skipped = filteredByDate.length - valid.length;

  // #region agent log
  agentDebugIngest460342({
    hypothesisId: 'H5',
    location: 'shifterPull.service.js:pullShiftsFromShifterSupabase',
    message: 'pull_counts',
    data: {
      nexusOrgId: String(nexusOrgId),
      shifterOrgId: String(shifterOrgId),
      matchedTable,
      matchedOrgCol,
      pulledRows: pulledRows.length,
      mappedRows: filteredByDate.length,
      validShifts: valid.length,
      skippedRows: skipped,
      fromDate: fromDate || null,
      toDate: toDate || null,
    },
  });
  // #endregion

  log('Shifter Supabase pull complete', {
    nexusOrgId,
    shifterOrgId,
    table: matchedTable,
    orgColumn: matchedOrgCol,
    pulledRows: pulledRows.length,
    mappedRows: filteredByDate.length,
    validShifts: valid.length,
    skippedRows: skipped,
    fromDate: fromDate || null,
    toDate: toDate || null,
  });

  return {
    shifts: valid,
    pulledRows: pulledRows.length,
    mappedRows: filteredByDate.length,
    skippedRows: skipped,
    shifterOrgId,
    table: matchedTable,
    orgColumn: matchedOrgCol,
  };
}

export async function debugShifterShiftsByOrg(options = {}) {
  const logWarn = options.logWarn || (() => {});
  const nexusOrgId = options.nexusOrgId || null;
  const limit = Math.max(1, Math.min(Number(options.limit) || 10, 100));

  if (!nexusOrgId) {
    throw new Error('nexusOrgId is required to debug Shifter shifts');
  }

  const shifterAdmin = getShifterServiceRoleClient();
  if (!shifterAdmin) {
    throw new Error('Shifter Supabase is not configured (SHIFTER_SUPABASE_URL / SHIFTER_SERVICE_ROLE_KEY)');
  }

  const shifterOrgId = await resolveEffectiveShifterOrgIdForNexusOrg(nexusOrgId);
  if (!shifterOrgId) {
    throw new Error('Could not resolve Shifter org id for this Nexus organisation');
  }

  const candidates = [];
  for (const table of SHIFT_TABLE_CANDIDATES) {
    for (const orgCol of ORG_COLUMN_CANDIDATES) {
      const scopedOrgId =
        table === 'nexus_shifts' && /nexus/i.test(String(orgCol || ''))
          ? String(nexusOrgId)
          : String(shifterOrgId);
      const { data, error, count } = await shifterAdmin
        .from(table)
        .select('*', { count: 'exact' })
        .eq(orgCol, scopedOrgId)
        .limit(limit);

      if (error) {
        candidates.push({
          table,
          org_column: orgCol,
          ok: false,
          error: error.message || String(error),
        });
        continue;
      }

      const rows = data || [];
      const lookups = await buildShiftRowNameLookups(shifterAdmin, rows, logWarn);
      let tzSpec = null;
      try {
        tzSpec = await getShifterOrgTimezoneSpecForNexusOrg(nexusOrgId);
      } catch {
        tzSpec = null;
      }
      const mapped = rows.map((row) => mapShifterRowToWebhookShift(row, lookups, tzSpec));
      candidates.push({
        table,
        org_column: orgCol,
        ok: true,
        row_count: typeof count === 'number' ? count : rows.length,
        sample_row_keys: rows[0] ? Object.keys(rows[0]) : [],
        sample_mapped_shifts: mapped.slice(0, 3),
      });
    }
  }

  return {
    nexus_org_id: nexusOrgId,
    shifter_org_id: shifterOrgId,
    candidates,
  };
}
