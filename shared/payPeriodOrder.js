/**
 * Pay period labels are dd/mm/yyyy. String sort puts 28/09 before 14/10.
 * Compare on yyyy-mm-dd so fortnights stay in date order, newest first.
 */

export function payPeriodIso(value) {
  const t = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (!m) return '';
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** Newest period first, then staff name. */
export function comparePaySummaryRows(a, b) {
  const end = payPeriodIso(b?.periodEnd).localeCompare(payPeriodIso(a?.periodEnd));
  if (end !== 0) return end;
  const start = payPeriodIso(b?.periodStart).localeCompare(payPeriodIso(a?.periodStart));
  if (start !== 0) return start;
  return String(a?.staffName || '').localeCompare(String(b?.staffName || ''), undefined, { sensitivity: 'base' });
}

/** Newest period first. */
export function comparePayPeriodOptions(a, b) {
  const end = payPeriodIso(b?.periodEnd).localeCompare(payPeriodIso(a?.periodEnd));
  if (end !== 0) return end;
  return payPeriodIso(b?.periodStart).localeCompare(payPeriodIso(a?.periodStart));
}
