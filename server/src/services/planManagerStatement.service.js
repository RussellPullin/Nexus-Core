/**
 * Plan manager monthly statements: extract per-category and per-provider spend,
 * remaining balances, and optional funding-period totals. Reuses the same PDF
 * text pipeline as NDIS plan parsing (native text + optional OCR).
 */
import * as llm from './llm.service.js';
import { roundMoney } from '../lib/invoiceGst.js';
import { parseFundReleaseScheduleFromDb } from '../utils/fundReleaseSchedule.js';

const CATEGORY_NAMES = {
  '01': 'Assistance with Daily Life',
  '02': 'Transport',
  '03': 'Consumables',
  '04': 'Assistance with Social, Economic and Community Participation',
  '05': 'Assistive Technology',
  '06': 'Home Modifications and SDA',
  '07': 'Support Coordination',
  '08': 'Improved Living Arrangements',
  '09': 'Increased Social and Community Participation',
  '10': 'Finding and Keeping a Job',
  '11': 'Improved Relationships',
  '12': 'Improved Health and Wellbeing',
  '13': 'Improved Learning',
  '14': 'Improved Life Choices',
  '15': 'Improved Daily Living Skills'
};

export function normalizeStatementText(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\uE000-\uF8FF]/g, ' ');
}

function parseMoney(s) {
  if (s == null || s === '') return null;
  const n = parseFloat(String(s).replace(/[$,]/g, '').trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return roundMoney(n);
}

function padCat(c) {
  const n = String(c || '').replace(/\D/g, '').slice(0, 2);
  if (!n) return null;
  return n.padStart(2, '0');
}

/** Token overlap 0..1 for fuzzy provider name match */
export function nameSimilarity(a, b) {
  const A = String(a || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const B = String(b || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (A.length === 0 || B.length === 0) return 0;
  const setB = new Set(B);
  let hit = 0;
  for (const t of A) {
    if (setB.has(t)) hit += 1;
  }
  const jacc = hit / (A.length + B.length - hit);
  if (A.join(' ') === B.join(' ')) return 1;
  return jacc;
}

/**
 * Lightweight deterministic hints (amounts near Remaining / Spent labels, category codes).
 * Does not replace LLM for messy layouts; used to validate or fill gaps.
 */
export function deterministicStatementHints(text) {
  const t = normalizeStatementText(text);
  const lower = t.toLowerCase();
  const hints = { keyword_hits: { remaining: 0, spent: 0 }, category_codes_seen: new Set() };
  hints.keyword_hits.remaining = (lower.match(/\bremaining\b|\bavailable\b|\bbalance\b/g) || []).length;
  hints.keyword_hits.spent = (lower.match(/\bspent\b|\bused\b|\bpaid\b|\binvoiced\b/g) || []).length;
  const catRe = /\b(0[1-9]|1[0-5])\b/g;
  let m;
  while ((m = catRe.exec(t)) !== null) {
    hints.category_codes_seen.add(m[1].padStart(2, '0'));
  }
  return hints;
}

/** "do it with ease" MY NDIS BUDGET — fixed column order in NDIS Budget table */
const DWE_CATEGORY_ORDER = [
  { key: 'adl', cat: '01', label: 'Assistance with Daily Life' },
  { key: 'asc', cat: '04', label: 'Assistance with Social, Economic and Community Participation' },
  { key: 'idl', cat: '15', label: 'Improved Daily Living Skills' },
  { key: 'sc', cat: '07', label: 'Support Coordination' },
  { key: 'cnc', cat: '14', label: 'Improved Life Choices' }
];

const DWE_HEADER_TO_CAT = {
  'assistance with daily life': '01',
  'assistance social & community': '04',
  'assistance social & community participation': '04',
  'improved daily living skills': '15',
  'support coordination': '07',
  'choice & control': '14',
  'choice and control': '14'
};

function parseAuStatementDateLine(s) {
  const MONTH = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11
  };
  const m = String(s || '')
    .trim()
    .match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (!m) return null;
  const monKey = m[2].toLowerCase().slice(0, 3);
  const mon = MONTH[monKey];
  if (mon == null) return null;
  const day = String(m[1]).padStart(2, '0');
  const mm = String(mon + 1).padStart(2, '0');
  return `${m[3]}-${mm}-${day}`;
}

function ddMmYyToIso(d, m, y2) {
  const y = 2000 + parseInt(y2, 10);
  const mm = String(parseInt(m, 10)).padStart(2, '0');
  const dd = String(parseInt(d, 10)).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

/** Parse plan period when NDIS number is glued to end date, e.g. 28/09/27430725817 */
function extractPlanPeriodIso(t) {
  const loose = t.match(/(\d{2}\/\d{2}\/\d{2})\s*-\s*(\d{2}\/\d{2}\/\d{2})\d+/);
  const strict = t.match(/(\d{2}\/\d{2}\/\d{2})\s*-\s*(\d{2}\/\d{2}\/\d{2})(?!\d)/);
  const raw = loose?.[0] || strict?.[0];
  if (!raw) return { start: null, end: null };
  const inner = raw.match(/(\d{2})\/(\d{2})\/(\d{2})\s*-\s*(\d{2})\/(\d{2})\/(\d{2})/);
  if (!inner) return { start: null, end: null };
  return {
    start: ddMmYyToIso(inner[1], inner[2], inner[3]),
    end: ddMmYyToIso(inner[4], inner[5], inner[6])
  };
}

/** Read five $ rows after an exact line label (e.g. "Budget" under the NDIS category headers). */
function extractFiveDollarRowsAfterLine(lines, lineLabel) {
  const idx = lines.findIndex((l) => l === lineLabel);
  if (idx < 0) return [];
  const out = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const mm = lines[i].match(/^\$([\d,]+(?:\.\d{2})?)$/);
    if (mm) {
      const v = parseMoney(mm[1]);
      if (v != null) out.push(v);
      if (out.length >= 5) break;
    } else if (out.length > 0) break;
  }
  return out;
}

/**
 * NDIS Budget summary grid: categories (5 lines) then Budget / Expended / Remaining rows with 5 amounts each.
 * Stops before "Funds Released". Avoids matching "Remaining" inside "Total Remaining Budget".
 */
function extractNdisBudgetGrid(lines) {
  const ndisIdx = lines.findIndex((l) => /^NDIS Budget$/i.test(l));
  if (ndisIdx < 0) return null;
  const frIdx = lines.findIndex((l, i) => i > ndisIdx && /^Funds Released$/i.test(l));
  const slice = frIdx > 0 ? lines.slice(ndisIdx, frIdx) : lines.slice(ndisIdx);

  const cncIdx = slice.findIndex((l) => /^choice\s*&\s*control$/i.test(l));
  if (cncIdx < 0) return null;
  const budgetLabelAt = slice.findIndex((l, i) => i > cncIdx && l === 'Budget');
  if (budgetLabelAt < 0) return null;

  const budgetAmounts = extractFiveDollarRowsAfterLine(slice, 'Budget');
  const expIdx = slice.findIndex((l, i) => i > budgetLabelAt && l === 'Expended');
  if (expIdx < 0) return null;
  const expendedAmounts = extractFiveDollarRowsAfterLine(slice, 'Expended');
  const remIdx = slice.findIndex((l, i) => i > expIdx && l === 'Remaining');
  if (remIdx < 0) return null;
  const remainingAmounts = extractFiveDollarRowsAfterLine(slice, 'Remaining');

  if (budgetAmounts.length < 5 || expendedAmounts.length < 5 || remainingAmounts.length < 5) return null;
  return { budgetAmounts, expendedAmounts, remainingAmounts };
}

function extractFundsReleasedGrid(lines) {
  const frIdx = lines.findIndex((l) => /^Funds Released$/i.test(l));
  if (frIdx < 0) return { released: [], available: [] };
  const slice = lines.slice(frIdx);
  const relIdx = slice.findIndex((l, i) => i > 0 && l === 'Released');
  const released = relIdx > 0 ? extractFiveDollarRowsAfterLine(slice, 'Released') : [];
  const availIdx = slice.findIndex((l, i) => i > 0 && l === 'Available');
  const available = availIdx > 0 ? extractFiveDollarRowsAfterLine(slice, 'Available') : [];
  return { released, available };
}

function extractProviderFromDweInvoiceLine(line) {
  if (!/^\d{2}\/\d{2}\/\d{2}/.test(line)) return null;
  const tail = line.replace(/^\d{2}\/\d{2}\/\d{2}\s*/, '');
  const inv = tail.match(/^(.+?)INV-\d+/i);
  if (inv) return inv[1].replace(/\s+/g, ' ').trim();
  const li = tail.match(/^(.+?)(\d{2}_\d{3}_\d{4}_\d_\d)/);
  if (li) {
    return li[1]
      .replace(/\s+/g, ' ')
      .replace(/\b\d{5,}\b/g, '')
      .trim();
  }
  return tail.split(/\d{2}_\d{3}_/)[0].replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * After NDIS line item, portal text is often hours, rate, total then dd-Mmmdd-Mmm (no spaces).
 * Greedy `\d+\.\d{2}(?=\d{2}-Mmm)` can mis-anchor (e.g. 99232.9903-Mar); use hour/rate/total triplet.
 */
function extractInvoiceTotalFromDweLine(line) {
  const triplet = line.match(/(\d+\.\d{2})\s*(\d+\.\d{2})\s*(\d+\.\d{2})(?=\d{2}-[A-Za-z]{3})/);
  if (triplet) return parseMoney(triplet[3]);
  const m = [...line.matchAll(/(\d+\.\d{2})(?=\d{2}-[A-Za-z]{3})/g)];
  if (!m.length) return null;
  const last = m[m.length - 1][1];
  const n = parseFloat(last);
  if (n > 50000) return null;
  return parseMoney(last);
}

/**
 * Deterministic parse for "do it with ease" / MY NDIS BUDGET monthly statements (columnar summary + invoice detail).
 * @returns {object|null} same shape as normalizeLlmStatement, or null if layout not detected
 */
export function parseDoItWithEaseMonthlyStatement(text) {
  const t = normalizeStatementText(text);
  const tl = t.toLowerCase();
  if (!tl.includes('do it with ease') && !tl.includes('my ndis budget')) return null;
  if (!t.includes('NDIS Budget') || !t.includes('Support Category')) return null;

  const statementDateM = t.match(/Statement Date:\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i);
  const statement_as_of = statementDateM ? parseAuStatementDateLine(statementDateM[1]) : null;

  const period = extractPlanPeriodIso(t);

  let participant_name = null;
  const nameM = t.match(/MY NDIS BUDGET\s*([^\n]+?)(?:\n|\d{2}\/\d{2})/i);
  if (nameM) participant_name = nameM[1].replace(/\s+/g, ' ').trim();

  const totalBudgetM = t.match(/Total NDIS Budget\s*\$?([\d,]+)/i);
  const totalExpM = t.match(/Total Expenses\s*\$?([\d,]+)/i);
  const totalRemM = t.match(/Total Remaining Budget\s*\$?([\d,]+)/i);

  const lines = t.split(/\n/).map((l) => l.trim());
  const grid = extractNdisBudgetGrid(lines);
  if (!grid) return null;
  const { budgetAmounts, expendedAmounts, remainingAmounts } = grid;
  const { released: releasedAmounts, available: availableAmounts } = extractFundsReleasedGrid(lines);

  const budgets = DWE_CATEGORY_ORDER.map((row, i) => ({
    category: row.cat,
    category_label: row.label,
    total_budget: budgetAmounts[i] ?? null,
    spent: expendedAmounts[i] ?? null,
    remaining: remainingAmounts[i] ?? null,
    release_total: releasedAmounts[i] != null ? releasedAmounts[i] : null,
    release_remaining: availableAmounts[i] != null ? availableAmounts[i] : null,
    providers: []
  }));

  const sections = t.split(/Support Category\s*-\s*/i).slice(1);
  for (const sec of sections) {
    const head = sec.split('\n')[0] || '';
    const headLower = head.toLowerCase().trim();
    let cat = null;
    for (const [k, c] of Object.entries(DWE_HEADER_TO_CAT)) {
      if (headLower.includes(k)) {
        cat = c;
        break;
      }
    }
    if (!cat) continue;
    const b = budgets.find((x) => x.category === cat);
    if (!b) continue;

    const byProv = {};
    const lines = sec.split(/\n/);
    for (const line of lines) {
      const prov = extractProviderFromDweInvoiceLine(line);
      const amt = extractInvoiceTotalFromDweLine(line);
      if (!prov || amt == null) continue;
      byProv[prov] = (byProv[prov] || 0) + amt;
    }
    const spendLine = sec.match(/Current Statement Spend:\s*\$?([\d,]+(?:\.\d{2})?)/i);
    const statementMonthSpend = spendLine ? parseMoney(spendLine[1]) : null;

    b.providers = Object.entries(byProv).map(([name, spent]) => ({ name, spent: roundMoney(spent) }));
    b.current_statement_spend = statementMonthSpend;
  }

  const sumAvail = availableAmounts.length === 5 ? roundMoney(availableAmounts.reduce((s, x) => s + x, 0)) : null;
  const sumReleased = releasedAmounts.length === 5 ? roundMoney(releasedAmounts.reduce((s, x) => s + x, 0)) : null;

  return {
    statement_period: period.start && period.end ? { start: period.start, end: period.end } : null,
    statement_as_of,
    participant_name,
    plan_total_budget: totalBudgetM ? parseMoney(totalBudgetM[1]) : null,
    plan_total_spent: totalExpM ? parseMoney(totalExpM[1]) : null,
    plan_total_remaining: totalRemM ? parseMoney(totalRemM[1]) : null,
    funding_release: {
      label: 'All categories — current release (summed)',
      period_total: sumReleased,
      spent: null,
      remaining: sumAvail
    },
    budgets,
    notes: 'Parsed deterministically (do it with ease / MY NDIS BUDGET layout).'
  };
}

const LLM_SCHEMA = `You are extracting structured data from an Australian NDIS PLAN MANAGER monthly statement (or similar portal export). The document lists budgets by support category, amounts funded, spent, remaining, and often a breakdown by provider or payee.

Return ONE JSON object only (no markdown), with this exact shape:
{
  "statement_period": { "start": "YYYY-MM-DD" | null, "end": "YYYY-MM-DD" | null },
  "statement_as_of": "YYYY-MM-DD" | null,
  "participant_name": string | null,
  "plan_total_budget": number | null,
  "plan_total_remaining": number | null,
  "plan_total_spent": number | null,
  "funding_release": {
    "label": string | null,
    "period_total": number | null,
    "spent": number | null,
    "remaining": number | null
  } | null,
  "budgets": [
    {
      "category": "01" through "15" (two digits),
      "category_label": string,
      "total_budget": number | null,
      "spent": number | null,
      "remaining": number | null,
      "providers": [ { "name": string, "spent": number } ]
    }
  ],
  "notes": string
}

Rules:
- Use ONLY numbers printed in the document for dollar fields (no guessing). If a value is not clearly stated, use null.
- Map each support category to NDIS categories 01-15 (first two digits of line items if shown, e.g. 04_xxx -> "04").
- providers: every payee/provider name with a dollar amount for that category; sum of provider spent should match category spent when the document shows both.
- If the document is not a plan manager statement, return budgets: [] and explain in notes.`;

export async function extractPlanManagerStatementWithLlm(text) {
  if (!text || String(text).trim().length < 40) return null;
  if (!(await llm.isAvailable())) return null;
  const prompt = `${LLM_SCHEMA}

Document text:
---
${String(text).slice(0, 48000)}
---`;
  const raw = await llm.completeJson(prompt, { maxTokens: 8000 });
  if (!raw || typeof raw !== 'object') return null;
  return normalizeLlmStatement(raw);
}

function normalizeLlmStatement(raw) {
  const budgets = [];
  const list = Array.isArray(raw.budgets) ? raw.budgets : [];
  for (const b of list) {
    const cat = padCat(b.category);
    if (!cat || !CATEGORY_NAMES[cat]) continue;
    const providers = [];
    for (const p of Array.isArray(b.providers) ? b.providers : []) {
      const name = String(p?.name || '').trim();
      const spent = parseMoney(p?.spent);
      if (!name || spent == null) continue;
      providers.push({ name, spent });
    }
    budgets.push({
      category: cat,
      category_label: String(b.category_label || CATEGORY_NAMES[cat]).trim(),
      total_budget: parseMoney(b.total_budget),
      spent: parseMoney(b.spent),
      remaining: parseMoney(b.remaining),
      providers
    });
  }

  return {
    statement_period: raw.statement_period && typeof raw.statement_period === 'object' ? raw.statement_period : null,
    statement_as_of: typeof raw.statement_as_of === 'string' ? raw.statement_as_of : null,
    participant_name: raw.participant_name != null ? String(raw.participant_name) : null,
    plan_total_budget: parseMoney(raw.plan_total_budget),
    plan_total_remaining: parseMoney(raw.plan_total_remaining),
    plan_total_spent: parseMoney(raw.plan_total_spent),
    funding_release:
      raw.funding_release && typeof raw.funding_release === 'object'
        ? {
            label: raw.funding_release.label != null ? String(raw.funding_release.label) : null,
            period_total: parseMoney(raw.funding_release.period_total),
            spent: parseMoney(raw.funding_release.spent),
            remaining: parseMoney(raw.funding_release.remaining)
          }
        : null,
    budgets,
    notes: typeof raw.notes === 'string' ? raw.notes : ''
  };
}

/**
 * Days inclusive between two YYYY-MM-DD dates.
 */
export function daysInclusive(startYmd, endYmd) {
  if (!startYmd || !endYmd || !/^\d{4}-\d{2}-\d{2}$/.test(startYmd) || !/^\d{4}-\d{2}-\d{2}$/.test(endYmd)) return null;
  const a = new Date(`${startYmd}T12:00:00Z`);
  const b = new Date(`${endYmd}T12:00:00Z`);
  const d = Math.round((b - a) / 86400000) + 1;
  return d > 0 ? d : null;
}

/**
 * Projected depletion and burn rates from statement figures.
 */
export function computeStatementTrends(parsed, planStart, planEnd) {
  const asOf =
    parsed?.statement_as_of ||
    (parsed?.statement_period?.end && /^\d{4}-\d{2}-\d{2}$/.test(parsed.statement_period.end) ? parsed.statement_period.end : null) ||
    new Date().toISOString().slice(0, 10);

  const statementDays =
    parsed?.statement_period?.start && parsed?.statement_period?.end
      ? daysInclusive(parsed.statement_period.start, parsed.statement_period.end)
      : null;

  const planDaysTotal = planStart && planEnd ? daysInclusive(planStart, planEnd) : null;
  const planDaysElapsed = planStart && asOf ? daysInclusive(planStart, asOf) : null;

  const budgets = (parsed?.budgets || []).map((b) => {
    const spent = b.spent != null ? b.spent : null;
    const remaining = b.remaining != null ? b.remaining : null;
    const denom = statementDays && statementDays > 0 ? statementDays : planDaysElapsed && planDaysElapsed > 0 ? planDaysElapsed : null;
    const avgDailySpend = spent != null && denom ? roundMoney(spent / denom) : null;
    const daysUntilEmpty =
      avgDailySpend != null && avgDailySpend > 0 && remaining != null ? Math.ceil(remaining / avgDailySpend) : null;
    const projectedDepletion =
      daysUntilEmpty != null ? addDaysYmd(asOf, daysUntilEmpty) : null;

    return {
      category: b.category,
      category_label: b.category_label,
      spent,
      remaining,
      avg_daily_spend_statement_period: avgDailySpend,
      statement_period_days: statementDays,
      projected_days_until_depleted: daysUntilEmpty,
      projected_depletion_date: projectedDepletion,
      providers: (b.providers || []).map((p) => ({
        name: p.name,
        spent: p.spent,
        avg_daily_spend:
          p.spent != null && denom ? roundMoney(p.spent / denom) : null
      }))
    };
  });

  let planTrend = null;
  const ptSpent = parsed?.plan_total_spent;
  const ptRem = parsed?.plan_total_remaining;
  if (ptSpent != null && planDaysElapsed && planDaysElapsed > 0 && ptRem != null) {
    const avgPlanDaily = roundMoney(ptSpent / planDaysElapsed);
    const daysLeft = avgPlanDaily > 0 ? Math.ceil(ptRem / avgPlanDaily) : null;
    planTrend = {
      avg_daily_spend_plan_to_date: avgPlanDaily,
      plan_days_elapsed: planDaysElapsed,
      plan_days_total: planDaysTotal,
      projected_days_until_plan_depleted: daysLeft,
      projected_plan_depletion_date: daysLeft != null ? addDaysYmd(asOf, daysLeft) : null
    };
  }

  const fr = parsed?.funding_release;
  let fundingReleaseTrend = null;
  if (fr && (fr.remaining != null || fr.spent != null) && statementDays && statementDays > 0) {
    const frSpent = fr.spent != null ? fr.spent : null;
    const frRem = fr.remaining != null ? fr.remaining : null;
    const daily = frSpent != null ? roundMoney(frSpent / statementDays) : null;
    const daysR = daily != null && daily > 0 && frRem != null ? Math.ceil(frRem / daily) : null;
    fundingReleaseTrend = {
      label: fr.label,
      avg_daily_spend: daily,
      projected_days_until_release_depleted: daysR,
      projected_release_depletion_date: daysR != null ? addDaysYmd(asOf, daysR) : null
    };
  }

  return {
    as_of: asOf,
    statement_period_days: statementDays,
    plan_days_total: planDaysTotal,
    plan_days_elapsed: planDaysElapsed,
    budgets,
    plan: planTrend,
    funding_release: fundingReleaseTrend
  };
}

function addDaysYmd(ymd, days) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseDetailsJson(details) {
  if (!details || typeof details !== 'string') return {};
  try {
    const o = JSON.parse(details);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return { _legacy_text: details };
  }
}

function stringifyDetails(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return '{}';
  }
}

/**
 * Pick best plan_budget row for a statement line when multiple share the same category.
 */
export function pickBudgetForCategory(candidates, categoryLabel) {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const label = String(categoryLabel || '').toLowerCase();
  let best = candidates[0];
  let bestScore = 0;
  for (const c of candidates) {
    const sc = nameSimilarity(c.name, label);
    if (sc > bestScore) {
      bestScore = sc;
      best = c;
    }
  }
  return best;
}

export function getStatementSpendFromDetails(details) {
  const o = parseDetailsJson(details);
  const v = o?.plan_manager_statement?.provider_spent;
  return v != null && Number.isFinite(Number(v)) ? roundMoney(Number(v)) : null;
}

/**
 * Join parsed statement + trend lines with local budgets and allocations for API/UI.
 * @param {object} parsed
 * @param {object} trends - from computeStatementTrends
 * @param {Array<{ id: string, category: string, name: string, amount: number, allocations?: object[] }>} planBudgets
 */
export function mergeStatementWithLocalData(parsed, trends, planBudgets) {
  const byCat = {};
  for (const b of planBudgets || []) {
    const c = padCat(b.category);
    if (!c) continue;
    if (!byCat[c]) byCat[c] = [];
    byCat[c].push(b);
  }

  const rows = [];
  for (const pb of parsed?.budgets || []) {
    const cat = padCat(pb.category);
    if (!cat) continue;
    const locals = byCat[cat] || [];
    const picked = pickBudgetForCategory(locals, pb.category_label);
    const trendRow = trends?.budgets?.find((t) => t.category === cat);
    const allocs = picked?.allocations || [];
    const stmtProviders = Array.isArray(pb.providers) ? pb.providers : [];

    const matchedPairs = [];
    const unmatchedStatementProviders = [];

    for (const sp of stmtProviders) {
      let best = null;
      let bestScore = 0;
      for (const a of allocs) {
        const pn = a.provider_name || '';
        const sc = nameSimilarity(pn, sp.name);
        if (sc > bestScore) {
          bestScore = sc;
          best = a;
        }
      }
      if (best && bestScore >= 0.35) {
        matchedPairs.push({
          provider_statement_name: sp.name,
          match_score: Math.round(bestScore * 100) / 100,
          allocation_id: best.id,
          provider_name: best.provider_name,
          coordinator_annual_allocation: best.amount != null ? roundMoney(Number(best.amount)) : null,
          statement_spend: roundMoney(sp.spent),
          details_statement_spend: getStatementSpendFromDetails(best.details)
        });
      } else {
        unmatchedStatementProviders.push({ name: sp.name, spent: roundMoney(sp.spent) });
      }
    }

    rows.push({
      category: cat,
      category_label: pb.category_label || CATEGORY_NAMES[cat],
      local_budget_id: picked?.id || null,
      local_budget_name: picked?.name || null,
      local_amount_before: picked?.amount != null ? roundMoney(Number(picked.amount)) : null,
      statement_total_budget: pb.total_budget,
      statement_spent: pb.spent,
      statement_remaining: pb.remaining,
      trends: trendRow || null,
      provider_rows: matchedPairs,
      providers_not_matched_to_allocations: unmatchedStatementProviders
    });
  }

  return {
    rows,
    plan_total: {
      from_statement: {
        budget: parsed?.plan_total_budget,
        spent: parsed?.plan_total_spent,
        remaining: parsed?.plan_total_remaining
      },
      trends: trends?.plan || null
    },
    funding_release: {
      from_statement: parsed?.funding_release || null,
      trends: trends?.funding_release || null
    }
  };
}

/**
 * Apply parsed statement: update budget amounts to remaining, merge provider spend into implementation details.
 */
export function applyPlanManagerStatement(db, { participantId, planId, parsed, apply }) {
  const warnings = [];
  if (!parsed || !Array.isArray(parsed.budgets) || parsed.budgets.length === 0) {
    return { applied: false, budgets_updated: 0, implementations_updated: 0, warnings: ['No budget rows parsed from statement.'] };
  }

  const plan = db.prepare('SELECT * FROM ndis_plans WHERE id = ? AND participant_id = ?').get(planId, participantId);
  if (!plan) {
    return { applied: false, budgets_updated: 0, implementations_updated: 0, warnings: ['Plan not found.'] };
  }

  const budgetRows = db.prepare('SELECT * FROM plan_budgets WHERE plan_id = ?').all(planId);
  const byCat = {};
  for (const b of budgetRows) {
    const c = padCat(b.category);
    if (!c) continue;
    if (!byCat[c]) byCat[c] = [];
    byCat[c].push(b);
  }

  const implRows = db.prepare(`
    SELECT i.*, o.name as provider_name
    FROM implementations i
    LEFT JOIN organisations o ON i.provider_type = 'organisation' AND i.provider_id = o.id
    WHERE i.plan_id = ?
  `).all(planId);

  const implByBudget = {};
  for (const i of implRows) {
    if (!implByBudget[i.budget_id]) implByBudget[i.budget_id] = [];
    implByBudget[i.budget_id].push(i);
  }

  let budgetsUpdated = 0;
  let implUpdated = 0;
  const asOf =
    parsed.statement_as_of ||
    (parsed.statement_period?.end && /^\d{4}-\d{2}-\d{2}$/.test(parsed.statement_period.end) ? parsed.statement_period.end : null) ||
    new Date().toISOString().slice(0, 10);

  const updBudget = db.prepare('UPDATE plan_budgets SET amount = ?, updated_at = datetime(\'now\') WHERE id = ? AND plan_id = ?');

  for (const sb of parsed.budgets) {
    const cat = padCat(sb.category);
    if (!cat || !byCat[cat]) {
      warnings.push(`No local budget for category ${cat || sb.category} (${sb.category_label || ''}).`);
      continue;
    }
    const picked = pickBudgetForCategory(byCat[cat], sb.category_label);
    if (!picked) continue;

    if (apply && sb.remaining != null && sb.remaining >= 0) {
      updBudget.run(sb.remaining, picked.id, planId);
      budgetsUpdated += 1;
    }

    const impls = implByBudget[picked.id] || [];
    const stmtProviders = Array.isArray(sb.providers) ? sb.providers : [];

    for (const sp of stmtProviders) {
      let best = null;
      let bestScore = 0;
      for (const im of impls) {
        const pn = im.provider_name || '';
        const sc = nameSimilarity(pn, sp.name);
        if (sc > bestScore) {
          bestScore = sc;
          best = im;
        }
      }
      if (best && bestScore >= 0.35) {
        if (apply) {
          const prev = parseDetailsJson(best.details);
          const next = {
            ...prev,
            plan_manager_statement: {
              ...(prev.plan_manager_statement || {}),
              last_as_of: asOf,
              provider_spent: roundMoney(sp.spent),
              provider_name: sp.name
            }
          };
          db.prepare('UPDATE implementations SET details = ?, updated_at = datetime(\'now\') WHERE id = ? AND plan_id = ?').run(
            stringifyDetails(next),
            best.id,
            planId
          );
          implUpdated += 1;
        }
      } else if (stmtProviders.length > 0) {
        warnings.push(`Category ${cat}: no allocation matched provider "${sp.name}" (best score ${bestScore.toFixed(2)}).`);
      }
    }
  }

  if (apply) {
    let sch = parseFundReleaseScheduleFromDb(plan.fund_release_schedule);
    if (sch == null || typeof sch !== 'object') sch = {};
    sch.pm_statement_snapshot = {
      captured_at: new Date().toISOString(),
      statement_as_of: asOf,
      plan_total_remaining: parsed.plan_total_remaining,
      plan_total_spent: parsed.plan_total_spent,
      funding_release: parsed.funding_release || null
    };
    db.prepare(`UPDATE ndis_plans SET fund_release_schedule = ?, updated_at = datetime('now') WHERE id = ?`).run(
      JSON.stringify(sch),
      planId
    );
  }

  return {
    applied: !!apply,
    budgets_updated: budgetsUpdated,
    implementations_updated: implUpdated,
    warnings
  };
}

export async function parsePlanManagerStatementDocument(text, useAi) {
  const normalized = normalizeStatementText(text);
  const hints = deterministicStatementHints(normalized);
  const dwe = parseDoItWithEaseMonthlyStatement(normalized);
  if (dwe?.budgets?.length > 0) {
    return { parsed: dwe, hints, validation_warning: null };
  }
  let parsed = null;
  if (useAi) {
    parsed = await extractPlanManagerStatementWithLlm(normalized);
  }
  if (!parsed || !parsed.budgets?.length) {
    return {
      parsed: parsed || { budgets: [], notes: 'Could not extract structured rows.' },
      hints,
      validation_warning:
        !useAi || !(await llm.isAvailable())
          ? 'Enable local AI (Ollama) for best results on varied statement layouts, or ensure the PDF has selectable text.'
          : 'Statement layout not recognised; try OCR or a clearer export.'
    };
  }
  return { parsed, hints, validation_warning: null };
}
