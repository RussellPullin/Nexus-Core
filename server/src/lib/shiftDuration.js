/**
 * Hours between two ISO datetimes (e.g. shift start_time / end_time).
 * @param {string|null|undefined} startIso
 * @param {string|null|undefined} endIso
 * @returns {number|null}
 */
export function hoursBetweenIsoDateTimes(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const ms = new Date(String(startIso).replace(' ', 'T')).getTime();
  const me = new Date(String(endIso).replace(' ', 'T')).getTime();
  if (!Number.isFinite(ms) || !Number.isFinite(me)) return null;
  return Math.max(0, (me - ms) / (1000 * 60 * 60));
}

/**
 * Hours between two same-day clock times (HH:mm or HH:mm:ss).
 * If end is before start, treats as overnight (adds 24h).
 * @param {string|null|undefined} startTimeStr
 * @param {string|null|undefined} endTimeStr
 * @returns {number|null} decimal hours, or null if either value unparseable
 */
export function hoursBetweenClockStrings(startTimeStr, endTimeStr) {
  if (startTimeStr == null || endTimeStr == null) return null;
  const startMins = String(startTimeStr).trim().match(/^(\d{1,2}):(\d{2})/);
  const endMins = String(endTimeStr).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!startMins || !endMins) return null;
  const sm = parseInt(startMins[1], 10) * 60 + parseInt(startMins[2], 10);
  const em = parseInt(endMins[1], 10) * 60 + parseInt(endMins[2], 10);
  if (!Number.isFinite(sm) || !Number.isFinite(em)) return null;
  let diff = em - sm;
  if (diff < 0) diff += 24 * 60;
  return Math.max(0, diff / 60);
}

/**
 * Normalize duration from progress note / webhook fields.
 * When both start and finish are explicitly provided, wall-clock duration wins (avoids whole-hour `duration` overriding :30 ends).
 * @param {{ startTimeStr: string, endTimeStr: string, explicitStart: boolean, explicitEnd: boolean, duration: unknown }} p
 * @returns {number}
 */
export function resolveProgressNoteDurationHours(p) {
  const { startTimeStr, endTimeStr, explicitStart, explicitEnd, duration } = p;

  if (explicitStart && explicitEnd) {
    const fromTimes = hoursBetweenClockStrings(startTimeStr, endTimeStr);
    if (fromTimes != null) return fromTimes;
  }

  let durationHours = duration;
  if (durationHours == null || durationHours === '') {
    const fromTimes = hoursBetweenClockStrings(startTimeStr, endTimeStr);
    durationHours = fromTimes != null ? fromTimes : 0;
  }
  durationHours = typeof durationHours === 'number' ? durationHours : parseFloat(durationHours) || 0;
  if (durationHours > 24) {
    durationHours = durationHours / 60;
  }
  return durationHours;
}
