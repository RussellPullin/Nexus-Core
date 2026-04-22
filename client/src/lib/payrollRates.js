/**
 * Resolves per-bucket pay rates (weekday, Saturday, Sunday, public holiday, evening).
 * `hourly_rate` on the staff row is the default; optional overrides in `pay_rates_json`.
 */
export function effectivePayRates(staffRow) {
  const base = staffRow?.hourly_rate != null && staffRow?.hourly_rate !== ''
    ? Number(staffRow.hourly_rate)
    : null;
  let o = {};
  if (staffRow?.pay_rates_json) {
    try {
      o = JSON.parse(staffRow.pay_rates_json) || {};
    } catch {
      o = {};
    }
  }
  const n = (k) => {
    if (o[k] == null || o[k] === '') return null;
    const v = Number(o[k]);
    return Number.isFinite(v) && v >= 0 ? v : null;
  };
  return {
    base,
    weekday: n('weekday') ?? base,
    saturday: n('saturday') ?? base,
    sunday: n('sunday') ?? base,
    public_holiday: n('public_holiday') ?? base,
    evening: n('evening') ?? base,
  };
}

/**
 * Subcontractor labour: weekday daytime uses (weekday hours − evening hours) × weekday rate;
 * evening hours × evening rate; weekend/PH as listed. Matches Admin pay-summary hour buckets.
 */
export function computeSubcontractorLaborDollars(hours, rates) {
  if (!rates) return 0;
  const rW = rates.weekday;
  if (rW == null || !Number.isFinite(rW)) return 0;
  const wk = Number(hours?.weekdayHours) || 0;
  const eve = Number(hours?.eveningHours) || 0;
  const dayWk = Math.max(0, wk - eve);
  const sat = Number(hours?.saturdayHours) || 0;
  const sun = Number(hours?.sundayHours) || 0;
  const ph = Number(hours?.holidayHours) || 0;
  const rE = rates.evening != null && Number.isFinite(rates.evening) ? rates.evening : rW;
  const rS = rates.saturday != null && Number.isFinite(rates.saturday) ? rates.saturday : rW;
  const rSu = rates.sunday != null && Number.isFinite(rates.sunday) ? rates.sunday : rW;
  const rPh = rates.public_holiday != null && Number.isFinite(rates.public_holiday) ? rates.public_holiday : rW;
  return (
    Math.round(100 * (dayWk * rW + eve * rE + sat * rS + sun * rSu + ph * rPh)) / 100
  );
}

export function payRateOverridesFromFormFields(fields) {
  const out = {};
  const add = (key, val) => {
    if (val == null || val === '') return;
    const n = Number(val);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  };
  add('saturday', fields?.pay_saturday);
  add('sunday', fields?.pay_sunday);
  add('public_holiday', fields?.pay_public_holiday);
  add('evening', fields?.pay_evening);
  return Object.keys(out).length > 0 ? out : null;
}

export function payRateFormFieldsFromRow(staffRow) {
  let o = {};
  if (staffRow?.pay_rates_json) {
    try {
      o = JSON.parse(staffRow.pay_rates_json) || {};
    } catch {
      o = {};
    }
  }
  const s = (k) => (o[k] != null && o[k] !== '' && Number.isFinite(Number(o[k])) ? String(o[k]) : '');
  return {
    pay_saturday: s('saturday'),
    pay_sunday: s('sunday'),
    pay_public_holiday: s('public_holiday'),
    pay_evening: s('evening'),
  };
}
