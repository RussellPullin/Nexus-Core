/** Weekday keys for recurring weekly availability (JSON stored on staff.availability_json). */
export const STAFF_AVAILABILITY_DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function emptyStaffAvailability() {
  return Object.fromEntries(STAFF_AVAILABILITY_DAY_KEYS.map((k) => [k, []]));
}

function isEmptySchedule(schedule) {
  return STAFF_AVAILABILITY_DAY_KEYS.every((k) => !schedule[k]?.length);
}

/**
 * Parse and validate availability from JSON string, object, or unknown input.
 * @returns {Record<string, Array<{start: string, end: string}>>}
 */
export function parseStaffAvailability(raw) {
  const out = emptyStaffAvailability();
  if (raw == null || raw === '') return out;
  let obj;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return out;
    }
  } else if (typeof raw === 'object' && raw !== null) {
    obj = raw;
  } else {
    return out;
  }
  for (const key of STAFF_AVAILABILITY_DAY_KEYS) {
    const arr = obj[key];
    if (!Array.isArray(arr)) continue;
    for (const slot of arr) {
      if (!slot || typeof slot !== 'object') continue;
      const start = String(slot.start ?? '').trim();
      const end = String(slot.end ?? '').trim();
      if (!TIME_RE.test(start) || !TIME_RE.test(end)) continue;
      if (start >= end) continue;
      out[key].push({ start, end });
    }
  }
  return out;
}

/**
 * @returns {string|null} JSON string for DB, or null when no hours any day
 */
export function normalizedAvailabilityJsonString(raw) {
  const schedule = parseStaffAvailability(raw);
  if (isEmptySchedule(schedule)) return null;
  return JSON.stringify(schedule);
}

/**
 * @param {object} body - request body
 * @returns {{ present: boolean, value: string|null }}
 */
export function availabilityFromRequestBody(body) {
  if (!body || typeof body !== 'object') return { present: false, value: null };
  const hasJson = Object.prototype.hasOwnProperty.call(body, 'availability_json');
  const hasAvail = Object.prototype.hasOwnProperty.call(body, 'availability');
  if (!hasJson && !hasAvail) return { present: false, value: null };
  const raw = hasJson ? body.availability_json : body.availability;
  return { present: true, value: normalizedAvailabilityJsonString(raw) };
}
