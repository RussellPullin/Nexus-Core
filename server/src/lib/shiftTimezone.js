/**
 * Naive SQLite shift datetimes are local wall times. Converting them for timestamptz
 * requires a zone — never treat plain "08:00" as UTC when the product means Australian local.
 */
import { DateTime, FixedOffsetZone, Info } from 'luxon';

/** Zones that mean "UTC wall clock" for naive strings — wrong for NDIS local times; use fallback instead. */
function isUtcWallZone(z) {
  if (!z || typeof z !== 'string') return false;
  const l = z.trim().toLowerCase();
  return l === 'utc' || l === 'gmt' || l === 'etc/utc' || l === 'greenwich' || l === 'etc/gmt' || l === 'zulu';
}

/**
 * @typedef {{ kind: 'iana', zone: string } | { kind: 'fixed', offsetMinutes: number }} ShiftMirrorTzSpec
 */

/**
 * Parse common offset strings: "+10", "+10:30", "UTC+10", "GMT+11", "10" (assume hours east).
 * Returns minutes east of UTC, or null.
 */
export function parseOffsetMinutesEastOfUtc(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;

  const m1 = s.match(/^(?:UTC|GMT)\s*([+-])(\d{1,2})(?::(\d{2}))?$/i);
  const m2 = s.match(/^([+-])(\d{1,2})(?::(\d{2}))?$/);
  const m = m1 || m2;
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const hours = parseInt(m[2], 10);
  const mins = m[3] ? parseInt(m[3], 10) : 0;
  if (Number.isNaN(hours) || Number.isNaN(mins)) return null;
  return sign * (hours * 60 + mins);
}

const WINDOWS_TZ_TO_IANA = {
  'aus eastern standard time': 'Australia/Sydney',
  'australian eastern standard time': 'Australia/Sydney',
  'e. australia standard time': 'Australia/Brisbane',
  'aus central standard time': 'Australia/Adelaide',
  'aus central w. standard time': 'Australia/Adelaide',
  'w. australia standard time': 'Australia/Perth',
};

/**
 * Normalize a value from Shifter public.organizations (or env) into a mirror spec.
 * @param {unknown} raw
 * @returns {ShiftMirrorTzSpec | null}
 */
export function normalizeOrgTimezoneRaw(raw) {
  if (raw == null) return null;
  const str = typeof raw === 'string' ? raw.trim() : String(raw).trim();
  if (!str) return null;

  let z = str;
  const paren = z.indexOf(' (');
  if (paren > 0) z = z.slice(0, paren).trim();

  const lower = z.toLowerCase();
  if (WINDOWS_TZ_TO_IANA[lower]) {
    return { kind: 'iana', zone: WINDOWS_TZ_TO_IANA[lower] };
  }

  if (Info.isValidIANAZone(z)) {
    if (isUtcWallZone(z)) return null;
    return { kind: 'iana', zone: z };
  }

  const off = parseOffsetMinutesEastOfUtc(z);
  if (off != null) return { kind: 'fixed', offsetMinutes: off };

  return null;
}

/**
 * @param {string | null | undefined} s - Naive datetime from SQLite
 * @param {ShiftMirrorTzSpec | null} spec
 * @returns {string | null} ISO UTC
 */
export function sqliteNaiveToUtcIso(s, spec) {
  if (s == null || typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed) return null;

  // Naive SQLite strings represent *wall time* in an org schedule timezone.
  // Never interpret them in the server's local timezone or as UTC by accident.
  let effectiveSpec = spec || normalizeOrgTimezoneRaw(process.env.NEXUS_SHIFT_TIMEZONE_FALLBACK);
  if (!effectiveSpec) effectiveSpec = { kind: 'iana', zone: 'Australia/Sydney' };

  let normalized = trimmed.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    normalized = `${normalized}T00:00:00`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) {
    normalized = `${normalized}:00`;
  }

  const base = normalized.length >= 19 ? normalized.slice(0, 19) : normalized;

  if (effectiveSpec?.kind === 'iana') {
    const dt = DateTime.fromISO(base, { zone: effectiveSpec.zone });
    if (dt.isValid) return dt.toUTC().toISO();
  } else if (effectiveSpec?.kind === 'fixed') {
    const zone = FixedOffsetZone.instance(effectiveSpec.offsetMinutes);
    const dt = DateTime.fromISO(base, { zone });
    if (dt.isValid) return dt.toUTC().toISO();
  }

  return null;
}
