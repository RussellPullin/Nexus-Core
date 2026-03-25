/**
 * Extract NDIS plan budgets from narrative text using the LLM.
 * Used when regex parsing finds little or no structured data.
 * Uses learned user preferences to improve suggestions (e.g. Level 2 SC, common therapies).
 */

import * as llm from '../llm.service.js';
import { buildLLMContext } from '../preferenceLearning.service.js';

const STATED_SUPPORT_RE = /\bstated\s+(?:support|supports|item|items)\b/i;

const NDIS_CATEGORIES = `01: Assistance with Daily Life
02: Transport
03: Consumables
04: Assistance with Social, Economic and Community Participation
05: Assistive Technology
06: Home Modifications and SDA
07: Support Coordination
08: Improved Living Arrangements
09: Increased Social and Community Participation
10: Finding and Keeping a Job
11: Improved Relationships
12: Improved Health and Wellbeing
13: Improved Learning
14: Improved Life Choices
15: Improved Daily Living Skills`;

const FORMAT_EXAMPLES = `Common NDIS plan formats:
- "01 Assistance with Daily Life $7,026.24" or "01 - Assistance with Daily Life: $7,026.24"
- "Core - Assistance with Daily Life $5,000.00" or "Capacity - Transport $1,200"
- "Support Category 07 Support Coordination Budget: $2,500.00"
- "Total funded supports $81,230.80" (plan total)
- "NDIS plan start date: 11 October 2023" and "NDIS plan review due date: 10 October 2025"
- "Core Supports" with "Total Core Supports $1,997.27"
- "Improved Daily Living (CB Daily Activity) $77,683.73" (category 15)
- "Improved Health and Wellbeing (CB Health & Wellbeing) $1,549.80" (category 12)
- "Total Capacity Building Supports $79,233.53" (subtotal, not plan total)
- Table rows with columns: Category | Name | Budget Amount`;

/**
 * Phase 1: Extract total plan budget and dates only (ground truth first).
 */
async function extractTotalAndDates(text) {
  const prompt = `Extract from this NDIS plan text:
1. Total plan budget – the single dollar figure for the WHOLE plan. Look for: "Total funded supports $X", "Your plan is valued at $X", "Total plan budget: $X", "Plan total $X". Do NOT use "Total Core Supports" or "Total Capacity Building Supports" – those are category subtotals.
2. Plan start and end dates (YYYY-MM-DD). Look for: "NDIS plan start date: 11 October 2023", "NDIS plan review due date: 10 October 2025", "plan started on X and will be reviewed by Y", "Plan Approved: X".

Return valid JSON only:
{ "total_plan_budget": 81230.80, "plan_dates": { "start_date": "2023-10-11", "end_date": "2025-10-10" } }

${(function () { try { const ctx = buildLLMContext(); return ctx ? `\nUser context (use to inform defaults): ${ctx}\n` : ''; } catch { return ''; } })()}

Plan text (first 20000 chars – include budget section where "Total funded supports" appears):
---
${text.slice(0, 20000)}
---`;
  const result = await llm.completeJson(prompt, { maxTokens: 500 });
  return result;
}

/**
 * Extract scheduled fund releases (quarterly / instalments) when explicitly stated in the plan.
 * @param {string} text
 * @param {{ start_date?: string, end_date?: string }|null} planDatesHint
 */
async function extractFundReleaseSchedule(text, planDatesHint) {
  const dateHint = planDatesHint?.start_date
    ? `If the document does not give exact release dates but gives an interval (e.g. every 3 months), set period_months (e.g. 3) and leave scheduled_date null for those rows—do not invent dates. Known plan start from earlier extraction (for context only): ${planDatesHint.start_date}.`
    : 'If only an interval is stated without dates, set period_months and leave scheduled_date null—do not invent dates.';

  const prompt = `From this NDIS plan text, extract SCHEDULED FUND RELEASES / payment instalments ONLY if explicitly stated (e.g. tables, "funds released on", "payment schedule", dollar amounts per instalment, or percentages per release).

RULES:
- If the plan does not clearly describe instalment amounts, dates, or percentages, return pattern "unknown" and releases [].
- Do NOT guess dates. If the plan says "quarterly" or "every three months" but gives NO amounts, dates, or percentages, use pattern "unknown", period_months: 3, releases [].
- If dollar amounts per instalment are given, use pattern "explicit_amounts", put each amount in "amount", scheduled_date if stated else null.
- If percentages or fractions are given (summing to 100% or 1), use pattern "explicit_proportions" and set "proportion" as a decimal 0–1 per release.
- If equal instalments are clearly stated with a count (e.g. four equal quarterly payments) but no per-line amounts, use pattern "equal_periods", set period_months if interval known (e.g. 3 for quarterly), and releases as that many rows with proportion 0.25 each (or null proportion for equal split).
- proportion values must sum to 1.0 when using proportions (after normalization).

${dateHint}

Return valid JSON only:
{
  "pattern": "equal_periods | explicit_amounts | explicit_proportions | unknown",
  "period_months": null,
  "releases": [
    { "scheduled_date": "YYYY-MM-DD or null", "proportion": 0.25, "amount": null, "label": "Release 1" }
  ],
  "evidence_quote": "short verbatim from plan or empty string",
  "confidence": "high | medium | low"
}

Plan text (first 16000 chars):
---
${text.slice(0, 16000)}
---`;
  const result = await llm.completeJson(prompt, { maxTokens: 1200 });
  if (!result || typeof result !== 'object') return null;
  return {
    pattern: result.pattern || 'unknown',
    period_months: result.period_months ?? null,
    releases: Array.isArray(result.releases) ? result.releases : [],
    evidence_quote: typeof result.evidence_quote === 'string' ? result.evidence_quote : '',
    confidence: typeof result.confidence === 'string' ? result.confidence : 'low'
  };
}

/**
 * Phase 2: Extract category budgets that MUST sum to the given total.
 * @param {string} text - Plan text
 * @param {number|null} totalPlanBudget - Total plan budget to match
 * @param {{ budgets: Array, sum: number }|null} previousAttempt - If provided, adds correction feedback to prompt
 */
async function extractBudgetsWithTotal(text, totalPlanBudget, previousAttempt = null) {
  const totalHint = totalPlanBudget ? `\nCRITICAL: The sum of all budget amounts MUST equal ${totalPlanBudget}. Verify your math before returning. If you include a category, its amount must be explicitly stated in the document.` : '';

  const correctionBlock = previousAttempt && totalPlanBudget
    ? `CORRECTION REQUEST: Your previous extraction returned budgets summing to $${previousAttempt.sum.toLocaleString()}, but the plan total is $${totalPlanBudget.toLocaleString()}.
Re-read the document carefully and extract budgets that sum exactly to $${totalPlanBudget.toLocaleString()}. Common errors: missing categories, incorrect amounts, or including category 10/13 when they are not in the plan.

`
    : '';

  const prompt = `${correctionBlock}Extract NDIS plan category budgets from this document.

NDIS categories (01-15):
${NDIS_CATEGORIES}

RULES:
- Only include categories that are EXPLICITLY listed with a dollar amount in the document.
- Do NOT add category 10 (Finding and Keeping a Job) or 13 (Improved Learning) unless they appear with a dollar amount.
- Extract ONLY exact dollar amounts. Do NOT estimate from hours.
- Categories 01 and 04 often have equal amounts when both appear (Core vs Capacity). Check the document.
- For each budget, capture the FULL stated description from the plan – the paragraph that explains what the funding is for. Include specific supports, provider types, or conditions mentioned (e.g. "Funding for an allied health professional to assess and provide support...", "Support to help with coordinating life stages, transitions, mentoring, peer-support"). If the plan says it is a Stated support with a detailed description, include that entire description in support_narrative (up to ~500 chars per budget). If no description exists, use "".
${totalHint}

Format examples: "01 Assistance with Daily Life $5,000", "Core - Assistance with Daily Life $5,000", "04 Assistance with Social... $5,000", "Core Supports $1,997.27", "Improved Daily Living (CB Daily Activity) $77,683.73", "Improved Health and Wellbeing (CB Health & Wellbeing) $1,549.80". Map "CB Daily Activity" to category 15, "CB Health & Wellbeing" to category 12, "Core Supports" (single total) to category 01.

Return valid JSON only:
{
  "budgets": [
    {
      "category": "01",
      "name": "Assistance with Daily Life",
      "amount": 5000,
      "support_narrative": "Support with daily activities, personal tasks, and self-care.",
      "line_item_numbers": [],
      "evidence_quote": "Assistance with Daily Life: $5,000"
    }
  ]
}

Plan text:
---
${text.slice(0, 24000)}
---`;
  const result = await llm.completeJson(prompt, { maxTokens: 3500 });
  return result;
}

/** Normalize raw LLM budgets to our format. */
function normalizeBudgets(rawBudgets) {
  if (!rawBudgets || !Array.isArray(rawBudgets)) return [];
  return rawBudgets
    .filter((b) => b && b.category && (b.amount > 0 || b.category))
    .map((b) => {
      const amount = typeof b.amount === 'number' && !isNaN(b.amount)
        ? b.amount
        : parseFloat(String(b.amount || '0').replace(/[$,]/g, '')) || 0;
      const supportNarrative = typeof b.support_narrative === 'string' ? b.support_narrative.trim() : '';
      const evidenceQuote = typeof b.evidence_quote === 'string' ? b.evidence_quote.trim() : '';
      const statedText = `${b.name || ''} ${supportNarrative} ${evidenceQuote}`;
      const isStatedSupport = STATED_SUPPORT_RE.test(statedText);
      return {
        category: String(b.category).replace(/\D/g, '').slice(0, 2).padStart(2, '0'),
        name: b.name || `Category ${b.category}`,
        amount,
        support_narrative: supportNarrative,
        line_item_numbers: Array.isArray(b.line_item_numbers) ? b.line_item_numbers : [],
        evidence_quote: evidenceQuote,
        is_stated_support: isStatedSupport,
        auto_budgeted: isStatedSupport,
        source: 'narrative',
        needs_review: true
      };
    })
    .filter((b) => b.amount > 0);
}

/** Apply 10/13 filter if it improves match to total. Returns budgets (possibly filtered). */
function apply10and13Filter(budgets, total_plan_budget) {
  if (!total_plan_budget || total_plan_budget <= 0 || !budgets?.length) return budgets;
  const sum = budgets.reduce((s, b) => s + b.amount, 0);
  const diff = Math.abs(sum - total_plan_budget) / total_plan_budget;
  if (diff <= 0.01) return budgets;
  const without10and13 = budgets.filter((b) => b.category !== '10' && b.category !== '13');
  const sumWithout = without10and13.reduce((s, b) => s + b.amount, 0);
  const diffWithout = Math.abs(sumWithout - total_plan_budget) / total_plan_budget;
  if (diffWithout < diff && without10and13.length > 0) return without10and13;
  return budgets;
}

/**
 * Extract budgets and plan dates from plan text using the LLM.
 * Two-phase: first get total and dates, then extract budgets constrained to sum to total.
 * If the sum does not match, retries once with correction feedback.
 */
export async function extractPlanFromText(text) {
  if (!text || text.trim().length < 50) {
    return { budgets: [], plan_dates: null, total_plan_budget: null, fund_release_schedule: null };
  }

  const phase1 = await extractTotalAndDates(text);
  const total_plan_budget = typeof phase1?.total_plan_budget === 'number' && phase1.total_plan_budget > 0
    ? phase1.total_plan_budget
    : parseFloat(String(phase1?.total_plan_budget || '0').replace(/[$,]/g, '')) || null;
  const plan_dates = phase1?.plan_dates || null;

  const [phase2, fundReleaseRaw] = await Promise.all([
    extractBudgetsWithTotal(text, total_plan_budget),
    extractFundReleaseSchedule(text, plan_dates)
  ]);

  if (!phase2 || !Array.isArray(phase2.budgets)) {
    return {
      budgets: [],
      plan_dates,
      total_plan_budget: total_plan_budget > 0 ? total_plan_budget : null,
      fund_release_schedule: fundReleaseRaw
    };
  }

  let budgets = apply10and13Filter(normalizeBudgets(phase2.budgets), total_plan_budget);

  if (total_plan_budget != null && total_plan_budget > 0 && budgets.length > 0) {
    const sum = budgets.reduce((s, b) => s + b.amount, 0);
    const diff = Math.abs(sum - total_plan_budget) / total_plan_budget;
    if (diff > 0.01) {
      const retryResult = await extractBudgetsWithTotal(text, total_plan_budget, { budgets, sum });
      if (retryResult?.budgets?.length > 0) {
        const retryBudgets = apply10and13Filter(normalizeBudgets(retryResult.budgets), total_plan_budget);
        const retrySum = retryBudgets.reduce((s, b) => s + b.amount, 0);
        const retryDiff = Math.abs(retrySum - total_plan_budget) / total_plan_budget;
        if (retryDiff < diff) {
          budgets = retryBudgets;
        }
      }
    }
  }

  return {
    budgets,
    plan_dates,
    total_plan_budget: total_plan_budget > 0 ? total_plan_budget : null,
    fund_release_schedule: fundReleaseRaw
  };
}
