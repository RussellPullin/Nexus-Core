/**
 * Deterministic NDIS plan parsing: "Support Category N" blocks and per-block fund releases.
 */

const PLAN_TOTAL_LINE_HINTS =
  /total\s+funded\s+supports|total\s+plan\s+budget|plan\s+total|total\s+capacity\s+building\s+supports|total\s+core\s+supports|valued\s+at/i;

const STATED_SUPPORT_RE = /\bstated\s+(?:support|supports|item|items)\b/i;

export const SUPPORT_CATEGORY_HEADER_RE =
  /(?:^|[\n\r])\s*(?:Support\s+)?Category\s*(0?[1-9]|1[0-5])\b(?:\s+[^\n\r]{0,160})?/gi;

function containsStatedSupport(text) {
  return STATED_SUPPORT_RE.test(String(text || ''));
}

export function parseAmountExactStr(amountStr) {
  if (!amountStr || typeof amountStr !== 'string') return 0;
  const cleaned = amountStr.replace(/[$,]/g, '').trim();
  const n = parseFloat(cleaned);
  if (isNaN(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

/** @param {string} blockText */
export function extractFundReleasesFromCategoryBlock(blockText) {
  const out = [];
  const seen = new Set();
  const dmyMoney = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})[^\n$]{0,72}\$\s*([\d,]+(?:\.\d{2})?)/gi;
  let m;
  while ((m = dmyMoney.exec(blockText)) !== null) {
    const [, d, mo, y, amtStr] = m;
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const amt = parseAmountExactStr(amtStr);
    if (amt < 1) continue;
    const k = `${iso}|${amt}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ scheduled_date: iso, amount: amt, proportion: null, label: `Release ${out.length + 1}` });
  }
  return out;
}

function lineLooksLikePlanSubtotalOrNoise(line) {
  const L = String(line || '').toLowerCase();
  return (
    PLAN_TOTAL_LINE_HINTS.test(L) ||
    /total\s+(?:core|capacity|capital)\s+supports/.test(L) ||
    /flexible\s+core/.test(L) ||
    /^\s*page\s+\d+/i.test(L)
  );
}

function isAcceptableCategoryDollarAmount(amount, total_plan_budget) {
  if (total_plan_budget != null && total_plan_budget > 0 && Math.abs(amount - total_plan_budget) / total_plan_budget < 0.005) {
    return false;
  }
  return true;
}

/**
 * @param {string} blockText
 * @param {number|null} total_plan_budget
 */
export function extractAmountFromCategoryBlock(blockText, total_plan_budget) {
  const tb = String(blockText || '');
  if (tb.length < 8) return 0;
  const lines = tb.split(/\n/);
  for (const line of lines) {
    if (lineLooksLikePlanSubtotalOrNoise(line)) continue;
    const L = line.toLowerCase();
    if (/(?:includes?|including)\b/.test(L) && /\$/.test(L) && !containsStatedSupport(L)) continue;
    const budgetLine = line.match(
      /(?:your\s+budget|budget\s+amount|funding\s+for\s+this\s+category|total\s+for\s+this\s+category|category\s+budget)\s*[:\s]*\$?\s*([\d,]+(?:\.\d{2})?)/i
    );
    if (budgetLine && budgetLine[1]) {
      const a = parseAmountExactStr(budgetLine[1]);
      if (a >= 1 && isAcceptableCategoryDollarAmount(a, total_plan_budget)) return a;
    }
  }
  const amountRe = /\$\s*([\d,]+(?:\.\d{2})?)/g;
  let best = 0;
  let m;
  while ((m = amountRe.exec(tb)) !== null) {
    const idx = m.index;
    const ctxStart = Math.max(0, idx - 90);
    const ctx = tb.slice(ctxStart, Math.min(tb.length, idx + 24)).toLowerCase();
    if (/(?:includes?|including)\b/.test(ctx) && !containsStatedSupport(ctx)) continue;
    if (PLAN_TOTAL_LINE_HINTS.test(ctx)) continue;
    const a = parseAmountExactStr(m[1]);
    if (a < 1 || !isAcceptableCategoryDollarAmount(a, total_plan_budget)) continue;
    if (a > best) best = a;
  }
  return best;
}

/**
 * @param {string} text
 * @param {Record<string, string>} catNames
 * @param {number|null} total_plan_budget
 */
export function extractBudgetsFromSupportCategoryBlocks(text, catNames, total_plan_budget) {
  const t = String(text || '');
  const spans = [];
  let mh;
  SUPPORT_CATEGORY_HEADER_RE.lastIndex = 0;
  while ((mh = SUPPORT_CATEGORY_HEADER_RE.exec(t)) !== null) {
    const cat = String(mh[1]).padStart(2, '0');
    if (!/^0[1-9]$|^1[0-5]$/.test(cat)) continue;
    spans.push({ cat, start: mh.index });
  }
  if (spans.length < 1) return [];
  spans.sort((a, b) => a.start - b.start);
  const out = [];
  const byCat = new Map();
  for (let i = 0; i < spans.length; i++) {
    const { cat, start } = spans[i];
    const end = i + 1 < spans.length ? spans[i + 1].start : t.length;
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push({ start, end });
  }
  for (const cat of [
    '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15'
  ]) {
    const ranges = byCat.get(cat);
    if (!ranges?.length) continue;
    const { start, end } = ranges[ranges.length - 1];
    const block = t.slice(start, end);
    const amount = extractAmountFromCategoryBlock(block, total_plan_budget);
    if (amount < 1) continue;
    const lineItems = (block.match(/\d{2}_\d{3}_\d{4}_\d_\d/g) || []).slice(0, 12);
    const fr = extractFundReleasesFromCategoryBlock(block);
    const winLower = block.slice(0, 800).toLowerCase();
    const stated = containsStatedSupport(winLower);
    const row = {
      category: cat,
      name: catNames[cat] || `Category ${cat}`,
      amount,
      line_item_numbers: lineItems,
      management_type: 'self',
      is_stated_support: stated,
      auto_budgeted: stated
    };
    if (fr.length > 0) row.fund_releases = fr;
    out.push(row);
  }
  return out;
}

/** Cat 07 / coordination map keys must be this close to the $ (char distance from key start to end of preceding). */
export const COORDINATION_PROXIMITY_TO_DOLLAR = 118;
export const CATEGORY_LABEL_PROXIMITY_TO_DOLLAR = 400;

export function mapKeyProximityLimit(key, cat) {
  if (cat === '07') return COORDINATION_PROXIMITY_TO_DOLLAR;
  if (/coordination|recovery coach|support connection/i.test(key)) return COORDINATION_PROXIMITY_TO_DOLLAR;
  return CATEGORY_LABEL_PROXIMITY_TO_DOLLAR;
}
