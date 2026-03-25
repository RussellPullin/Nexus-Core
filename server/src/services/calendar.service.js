/**
 * Calendar service - ICS export and future Google/Outlook/Apple sync
 */

const formatDate = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

export function generateICS(shift, participantName, staffName) {
  const start = new Date(shift.start_time);
  const end = new Date(shift.end_time);
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
export function generateICSForMultipleShifts(shifts) {
  const events = shifts.map((shift) => {
    const start = new Date(shift.start_time);
    const end = new Date(shift.end_time);
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
