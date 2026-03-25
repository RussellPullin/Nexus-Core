import {
  getShifterServiceRoleClient,
  resolveEffectiveShifterOrgIdForNexusOrg,
} from './supabaseStaffShifter.service.js';

const SHIFT_TABLE_CANDIDATES = ['shifts'];
const ORG_COLUMN_CANDIDATES = [
  'org',
  'org_id',
  'organization_id',
  'organisation_id',
  'organization_profile_id',
  'organisation_profile_id',
  'profile_id',
];
const PAGE_SIZE = 1000;

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

function toHm(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const m = raw.match(/(\d{1,2}):(\d{2})/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dateFromDateOrTimestamp(row) {
  const fromDateField = pickString(row, ['date', 'shift_date', 'support_date']);
  if (fromDateField) return toIsoDate(fromDateField);
  const fromTs = pickString(row, ['scheduled_start', 'start_time', 'start_at']);
  return toIsoDate(fromTs);
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
    'travel_duration_min',
    'travel_duration_minutes',
    'travel_duration',
    'travel_time',
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

function mapShifterRowToWebhookShift(row) {
  const shiftId = pickString(row, ['shift_id', 'id', 'external_shift_id']);
  const date = dateFromDateOrTimestamp(row);
  const startTime = toHm(pickString(row, ['start_time', 'scheduled_start', 'start_at'])) || '09:00';
  const finishTime = toHm(pickString(row, ['end_time', 'scheduled_end', 'end_at'])) || '17:00';
  const staffName = pickString(row, ['staff_name', 'worker_name', 'carer_name']);
  const clientName = pickString(row, ['client_name', 'client', 'participant_name']);
  const travelKm = mapTravelKm(row);
  const travelTimeMinutes = mapTravelTimeMinutes(row);
  const expenses = toNumberOrNull(row.expenses);
  const duration = toNumberOrNull(row.duration ?? row.duration_hours ?? row.duration_minutes);

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
    sessionDetails: pickString(row, ['session_details', 'notes']),
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

  let pulledRows = [];
  let matchedTable = null;
  let matchedOrgCol = null;
  let lastError = null;
  let successfulProbeCount = 0;

  for (const table of SHIFT_TABLE_CANDIDATES) {
    for (const orgCol of ORG_COLUMN_CANDIDATES) {
      const result = await fetchRowsByOrgFromTable(shifterAdmin, table, orgCol, shifterOrgId, limit);
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
    throw new Error(`Unable to query Shifter shifts by organisation${reason}`);
  }

  const mapped = pulledRows.map(mapShifterRowToWebhookShift);
  const filteredByDate = mapped.filter((s) => dateInRange(s.date, fromDate, toDate));
  const valid = filteredByDate.filter((s) => s.shiftId && s.date);
  const skipped = filteredByDate.length - valid.length;

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
      const { data, error, count } = await shifterAdmin
        .from(table)
        .select('*', { count: 'exact' })
        .eq(orgCol, shifterOrgId)
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
      const mapped = rows.map(mapShifterRowToWebhookShift);
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
