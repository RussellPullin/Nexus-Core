/**
 * Client-side fund release normalization (display only; mirrors server logic).
 */

function normalizeDate(d) {
  if (!d || typeof d !== 'string') return null;
  const t = d.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

function addMonthsYmd(ymd, months) {
  const [y, m, day] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function normalizeFundReleaseSchedule(raw, planStart, planEnd) {
  const warnings = [];
  if (!raw || typeof raw !== 'object') {
    return { releases: [], derived: false, warnings, meta: null };
  }
  const pattern = String(raw.pattern || 'unknown').toLowerCase().replace(/\s+/g, '_');
  let src = Array.isArray(raw.releases) ? raw.releases.filter((r) => r && typeof r === 'object') : [];

  const metaBase = {
    pattern: raw.pattern || 'unknown',
    period_months: raw.period_months != null && raw.period_months !== '' ? Number(raw.period_months) : null,
    evidence_quote: typeof raw.evidence_quote === 'string' ? raw.evidence_quote : '',
    confidence: typeof raw.confidence === 'string' ? raw.confidence : 'medium'
  };

  if (src.length === 0) {
    return { releases: [], derived: false, warnings, meta: metaBase };
  }

  const amtVals = src.map((r) => {
    const v = r.amount;
    if (v == null) return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  });
  const hasAmounts = amtVals.some((a) => a != null);

  let out = [];
  if (hasAmounts) {
    const amounts = src.map((_, i) => (amtVals[i] != null ? amtVals[i] : 0));
    const sum = amounts.reduce((s, x) => s + x, 0);
    if (sum <= 0) {
      warnings.push('Release amounts sum to zero; schedule ignored.');
      return { releases: [], derived: false, warnings, meta: metaBase };
    }
    out = src.map((r, i) => ({
      date: normalizeDate(r.scheduled_date) || normalizeDate(r.date),
      proportion: amounts[i] / sum,
      label: String(r.label || `Release ${i + 1}`),
      derived_date: false,
      amount_nominal: Math.round(amounts[i] * 100) / 100
    }));
  } else {
    let props = src.map((r) => {
      const p = r.proportion;
      if (p == null) return null;
      let n = typeof p === 'number' ? p : parseFloat(String(p).replace(/%/g, ''));
      if (!Number.isFinite(n)) return null;
      if (n > 1 && n <= 100) n /= 100;
      return n;
    });
    const equalish = pattern === 'equal_periods' || pattern === 'equal';
    if (props.every((p) => p == null || p === 0) && equalish) {
      const n = src.length || 1;
      props = src.map(() => 1 / n);
    }
    let sumP = props.reduce((s, p) => s + (Number.isFinite(p) ? p : 0), 0);
    if (sumP <= 0) {
      const n = src.length;
      props = src.map(() => 1 / n);
      sumP = 1;
      warnings.push('No valid proportions; using equal split.');
    } else if (Math.abs(sumP - 1) > 0.02) {
      props = props.map((p) => (Number.isFinite(p) ? p : 0) / sumP);
      warnings.push('Proportions normalized to sum to 1.');
    } else {
      props = props.map((p) => (Number.isFinite(p) ? p : 0) / sumP);
    }
    out = src.map((r, i) => ({
      date: normalizeDate(r.scheduled_date) || normalizeDate(r.date),
      proportion: props[i] ?? 0,
      label: String(r.label || `Release ${i + 1}`),
      derived_date: false,
      amount_nominal: null
    }));
  }

  let derived = false;
  const periodMonths = Number(metaBase.period_months);
  const startNorm = normalizeDate(planStart);
  const endNorm = normalizeDate(planEnd);
  if (startNorm && out.length > 0 && periodMonths > 0) {
    const anyMissing = out.some((r) => !r.date);
    if (anyMissing) {
      derived = true;
      out = out.map((r, i) => {
        if (r.date) return r;
        return {
          ...r,
          date: addMonthsYmd(startNorm, i * periodMonths),
          derived_date: true
        };
      });
      warnings.push('Some release dates were derived from plan start and period length.');
    }
  }

  if (startNorm && endNorm) {
    for (const r of out) {
      if (r.date && (r.date < startNorm || r.date > endNorm)) {
        warnings.push(`Release date ${r.date} is outside the plan period.`);
      }
    }
  }

  return {
    releases: out,
    derived,
    warnings,
    meta: metaBase
  };
}

export function splitAnnualAmount(annual, releases) {
  const a = Number(annual) || 0;
  if (!releases?.length || a === 0) return [];
  return releases.map((r) => ({
    proportion: r.proportion,
    amount_portion: Math.round(a * (Number(r.proportion) || 0) * 100) / 100
  }));
}

export function splitAnnualHours(annualHours, releases) {
  const h = Number(annualHours) || 0;
  if (!releases?.length || h === 0) return [];
  return releases.map((r) => ({
    proportion: r.proportion,
    hours_portion: Math.round(h * (Number(r.proportion) || 0) * 10) / 10
  }));
}
