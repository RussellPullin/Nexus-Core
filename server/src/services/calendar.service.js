/**
 * Calendar service - ICS export and future Google/Outlook/Apple sync
 */

import { sqliteNaiveToUtcIso } from '../lib/shiftTimezone.js';

const formatDate = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

function toUtcDate(isoOrNaive, tzSpec) {
  const raw = String(isoOrNaive || '').trim();
  if (!raw) return null;
  // If the string already carries a timezone/offset, trust it.
  if (/[zZ]$/.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const utcIso = sqliteNaiveToUtcIso(raw, tzSpec || null);
  if (!utcIso) return null;
  const d = new Date(utcIso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function generateICS(shift, participantName, staffName, options = {}) {
  const tzSpec = options.tzSpec || null;
  const start = toUtcDate(shift.start_time, tzSpec);
  const end = toUtcDate(shift.end_time, tzSpec);
  if (!start || !end) throw new Error('Invalid shift start/end time');
  const uid = `shift-${shift.id}@schedule-app`;
  const summary = `Shift: ${participantName} - ${staffName}`;
  const description = shift.notes
    ? `Support shift with ${participantName}\n\nNotes: ${shift.notes}`
    : `Support shift with ${participantName}`;

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Schedule Shift App//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatDate(new Date())}`,
    `DTSTART:${formatDate(start)}`,
    `DTEND:${formatDate(end)}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}

/** Generate ICS with multiple shifts (for week roster) */
export function generateICSForMultipleShifts(shifts, options = {}) {
  const tzSpec = options.tzSpec || null;
  const events = shifts.map((shift) => {
    const start = toUtcDate(shift.start_time, tzSpec);
    const end = toUtcDate(shift.end_time, tzSpec);
    if (!start || !end) throw new Error('Invalid shift start/end time');
    const uid = `shift-${shift.id}@schedule-app`;
    const summary = `Shift: ${shift.participant_name} - ${shift.staff_name}`;
    const description = shift.notes
      ? `Support shift with ${shift.participant_name}\n\nNotes: ${shift.notes}`
      : `Support shift with ${shift.participant_name}`;
    return [
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${formatDate(new Date())}`,
      `DTSTART:${formatDate(start)}`,
      `DTEND:${formatDate(end)}`,
      `SUMMARY:${summary}`,
      `DESCRIPTION:${description}`,
      'END:VEVENT'
    ].join('\r\n');
  });
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Schedule Shift App//EN',
    ...events,
    'END:VCALENDAR'
  ].join('\r\n');
}
