export const STAFF_AVAILABILITY_DAYS = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function emptyStaffAvailability() {
  return Object.fromEntries(STAFF_AVAILABILITY_DAYS.map((d) => [d.key, []]));
}

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
  for (const { key } of STAFF_AVAILABILITY_DAYS) {
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

export function parseStaffAvailabilityFromRow(staff) {
  if (!staff) return emptyStaffAvailability();
  return parseStaffAvailability(staff.availability_json);
}

/** @returns {boolean} true if at least one slot on any day */
export function hasAnyAvailabilitySlots(schedule) {
  return STAFF_AVAILABILITY_DAYS.some((d) => (schedule[d.key] || []).length > 0);
}

/**
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateAvailabilitySlots(schedule) {
  for (const { key, label } of STAFF_AVAILABILITY_DAYS) {
    const slots = schedule[key] || [];
    for (const slot of slots) {
      const start = String(slot.start ?? '').trim();
      const end = String(slot.end ?? '').trim();
      if (!start || !end) {
        return { ok: false, message: `Complete start and end times for ${label}, or remove empty rows.` };
      }
      if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
        return { ok: false, message: `Invalid time on ${label}. Use HH:MM format.` };
      }
      if (start >= end) {
        return { ok: false, message: `On ${label}, end time must be after start time.` };
      }
    }
  }
  return { ok: true };
}

export function formatHmLocal(hm) {
  if (!hm || typeof hm !== 'string') return hm;
  const parts = hm.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (Number.isNaN(h) || Number.isNaN(m)) return hm;
  const d = new Date(2000, 0, 1, h, m);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
