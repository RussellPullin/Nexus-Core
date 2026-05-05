/**
 * Deterministic extraction of NDIS fund-release / instalment tables from plan PDF text.
 * Complements LLM extraction when tables are present as plain text.
 */

const SECTION_RE =
  /\b(fund\s+release|funding\s+schedule|payment\s+schedule|funds?\s+released|instalments?|installments?|scheduled\s+release)\b/i;

const MONTH_NAMES = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12'
};

function parseDmyToIso(d, m, y) {
  const yy = String(y).padStart(4, '0');
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  if (!/^\d{4}$/.test(yy) || Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
  return `${yy}-${mm}-${dd}`;
}

function parseAmount(str) {
  const n = parseFloat(String(str || '').replace(/[$,]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}

/**
 * @param {string} text
 * @returns {object|null} Same shape as LLM fund_release_schedule or null
 */
export function extractFundReleaseScheduleFromPdfText(text) {
  const t = String(text || '');
  const sec = t.match(SECTION_RE);
  if (!sec || sec.index == null) return null;

  const slice = t.slice(sec.index, sec.index + 12000);
  const releases = [];
  const seen = new Set();

  // dd/mm/yyyy or dd-mm-yyyy then dollars within same line
  const dmyMoney = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})[^\n$]{0,72}\$\s*([\d,]+(?:\.\d{2})?)/gi;
  let m;
  while ((m = dmyMoney.exec(slice)) !== null) {
    const iso = parseDmyToIso(m[1], m[2], m[3]);
    const amount = parseAmount(m[4]);
    if (!iso || amount <= 0) continue;
    const key = `${iso}|${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    releases.push({
      scheduled_date: iso,
      amount,
      proportion: null,
      label: `Release ${releases.length + 1}`
    });
  }

  // "11 October 2023" ... $12,345.67 on same line
  const namedMoney =
    /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})[^\n$]{0,72}\$\s*([\d,]+(?:\.\d{2})?)/gi;
  while ((m = namedMoney.exec(slice)) !== null) {
    const mon = MONTH_NAMES[m[2].toLowerCase()];
    if (!mon) continue;
    const iso = parseDmyToIso(m[1], mon, m[3]);
    const amount = parseAmount(m[4]);
    if (!iso || amount <= 0) continue;
    const key = `${iso}|${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    releases.push({
      scheduled_date: iso,
      amount,
      proportion: null,
      label: `Release ${releases.length + 1}`
    });
  }

  if (releases.length === 0) return null;

  return {
    pattern: 'explicit_amounts',
    period_months: null,
    releases,
    evidence_quote: slice.slice(0, 280).replace(/\s+/g, ' ').trim(),
    confidence: 'medium'
  };
}
