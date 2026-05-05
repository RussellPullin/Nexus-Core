const VALID_CATEGORIES = new Set([
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15'
]);
const STATED_SUPPORT_RE = /\bstated\s+(?:support|supports|item|items)\b/i;

const CORE_CATS = new Set(['01', '02', '03', '04']);
const CAPITAL_CATS = new Set(['05', '06']);
const CAPACITY_CATS = new Set(['07', '08', '09', '10', '11', '12', '13', '14', '15']);

/** Official NDIS support category titles (aligned with parsePlanFromPdfText catNames). */
export const CANONICAL_CATEGORY_NAMES = {
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

function toCategory(value) {
  const raw = String(value || '').replace(/\D/g, '').slice(0, 2);
  return raw.padStart(2, '0');
}

function toAmount(value) {
  const n = typeof value === 'number'
    ? value
    : parseFloat(String(value || '').replace(/[$,]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100) / 100;
}

function findSectionAt(textLower, pos) {
  const lastCore = Math.max(
    textLower.lastIndexOf('total core supports', pos),
    textLower.lastIndexOf('core supports funding', pos),
    textLower.lastIndexOf('flexible core', pos),
    textLower.lastIndexOf('core supports', pos)
  );
  const lastCapBuild = Math.max(
    textLower.lastIndexOf('total capacity building', pos),
    textLower.lastIndexOf('capacity building supports', pos),
    textLower.lastIndexOf('capacity building', pos)
  );
  const lastCapital = Math.max(
    textLower.lastIndexOf('capital supports', pos),
    textLower.lastIndexOf('your capital supports', pos),
    textLower.lastIndexOf('capital funding', pos)
  );
  const best = Math.max(lastCore, lastCapBuild, lastCapital);
  if (best < 0) return null;
  if (best === lastCapital) return 'capital';
  if (best === lastCapBuild) return 'capacity';
  return 'core';
}

function sectionAllows(section, category) {
  if (section === 'core') return CORE_CATS.has(category);
  if (section === 'capital') return CAPITAL_CATS.has(category);
  if (section === 'capacity') return CAPACITY_CATS.has(category);
  return VALID_CATEGORIES.has(category);
}

function isStatedSupportBudget(raw) {
  const text = `${raw?.name || ''} ${raw?.support_narrative || ''} ${raw?.evidence_quote || ''}`;
  return STATED_SUPPORT_RE.test(text);
}

function normalizeDeterministicBudgets(budgets) {
  return (Array.isArray(budgets) ? budgets : [])
    .map((b) => {
      const category = toCategory(b.category);
      const amount = toAmount(b.amount);
      if (!VALID_CATEGORIES.has(category) || amount <= 0) return null;
      return {
        ...b,
        category,
        amount,
        name: CANONICAL_CATEGORY_NAMES[category] || b.name || `Category ${category}`,
        source: 'deterministic',
        validation_status: 'verified',
        validation_reason: null
      };
    })
    .filter(Boolean);
}

function withCanonicalName(b) {
  const cat = toCategory(b.category);
  return {
    ...b,
    category: cat,
    name: CANONICAL_CATEGORY_NAMES[cat] || b.name || `Category ${cat}`
  };
}

/**
 * @param {string} textLower
 * @param {object} raw
 * @param {Array<{ category: string, reason: string }>} dropped
 * @returns {{ category: string, amount: number, evidence: string, raw: object }|null}
 */
function tryValidateLlmRow(textLower, raw, dropped) {
  const category = toCategory(raw?.category);
  const amount = toAmount(raw?.amount);
  const evidence = String(raw?.evidence_quote || '').trim();
  const evidenceLower = evidence.toLowerCase();

  if (!VALID_CATEGORIES.has(category) || amount <= 0) {
    dropped.push({ category, reason: 'invalid_category_or_amount' });
    return null;
  }

  if (!evidence || evidence.length < 6) {
    dropped.push({ category, reason: 'missing_evidence_quote' });
    return null;
  }

  const evidencePos = textLower.indexOf(evidenceLower);
  if (evidencePos < 0) {
    dropped.push({ category, reason: 'evidence_not_found_in_document' });
    return null;
  }

  const section = findSectionAt(textLower, evidencePos);
  const coordinationEvidence =
    category === '07' &&
    /\bsupport coordination\b|\bcoordination of supports\b|\bspecialist support coordination\b/i.test(evidenceLower);
  if (!coordinationEvidence && !sectionAllows(section, category)) {
    dropped.push({ category, reason: `category_not_allowed_in_${section || 'unknown'}_section` });
    return null;
  }

  return { category, amount, evidence, raw };
}

function buildLlmBudgetOutput(row, opts) {
  const { category, amount, evidence, raw } = row;
  const statedSupport = isStatedSupportBudget(raw);
  return withCanonicalName({
    category,
    name: CANONICAL_CATEGORY_NAMES[category] || raw?.name || `Category ${category}`,
    amount,
    line_item_numbers: Array.isArray(raw?.line_item_numbers) ? raw.line_item_numbers : [],
    support_narrative: typeof raw?.support_narrative === 'string' ? raw.support_narrative.trim() : '',
    evidence_quote: evidence,
    is_stated_support: statedSupport,
    auto_budgeted: statedSupport,
    source: opts.source,
    validation_status: opts.validation_status,
    validation_reason: opts.validation_reason ?? null
  });
}

/**
 * @param {object} params
 * @param {string} params.text
 * @param {Array} params.deterministicBudgets
 * @param {Array} params.llmBudgets
 * @param {boolean} [params.allowLlmOnly]
 * @param {number|null} [params.mergedTotalPlanBudget]
 */
export function reconcilePlanExtraction({
  text,
  deterministicBudgets,
  llmBudgets,
  allowLlmOnly = false,
  mergedTotalPlanBudget = null
}) {
  const textLower = String(text || '').toLowerCase();
  const dropped = [];
  const normalizedDeterministic = normalizeDeterministicBudgets(deterministicBudgets);

  const validatedRows = [];
  const aiList = Array.isArray(llmBudgets) ? llmBudgets : [];
  for (const raw of aiList) {
    const v = tryValidateLlmRow(textLower, raw, dropped);
    if (v) validatedRows.push(v);
  }

  const llmByCat = new Map();
  for (const row of validatedRows) {
    if (!llmByCat.has(row.category)) llmByCat.set(row.category, row);
  }
  const llmUnique = Array.from(llmByCat.values());

  const sumDet = normalizedDeterministic.reduce((s, b) => s + b.amount, 0);
  const sumLlm = llmUnique.reduce((s, b) => s + b.amount, 0);
  const total =
    mergedTotalPlanBudget != null && mergedTotalPlanBudget > 0 ? mergedTotalPlanBudget : null;

  const errDet = total != null ? Math.abs(sumDet - total) : null;
  const errLlm = total != null ? Math.abs(sumLlm - total) : null;

  let useFullLlm = false;
  if (llmUnique.length > 0) {
    if (normalizedDeterministic.length === 0 && allowLlmOnly) {
      useFullLlm = true;
    } else if (total != null && normalizedDeterministic.length > 0 && errLlm != null && errDet != null) {
      if (errLlm < errDet) useFullLlm = true;
    }
  }

  if (useFullLlm) {
    const relErr = total != null && total > 0 ? errLlm / total : 1;
    const verified = relErr <= 0.0001;
    const budgets = llmUnique.map((row) =>
      buildLlmBudgetOutput(row, {
        source: 'llm',
        validation_status: verified ? 'verified' : 'needs_review',
        validation_reason: verified ? null : 'llm_set_sum_tolerance'
      })
    );
    return { budgets, dropped };
  }

  const merged = [];
  const byCategory = new Map();

  for (const b of normalizedDeterministic) {
    byCategory.set(b.category, { ...b });
    merged.push(byCategory.get(b.category));
  }

  for (const row of llmUnique) {
    const { category, amount, evidence, raw } = row;
    const existing = byCategory.get(category);

    if (!existing) {
      const statedSupport = isStatedSupportBudget(raw);
      const next = withCanonicalName({
        category,
        name: CANONICAL_CATEGORY_NAMES[category] || raw?.name || `Category ${category}`,
        amount,
        line_item_numbers: Array.isArray(raw?.line_item_numbers) ? raw.line_item_numbers : [],
        support_narrative: typeof raw?.support_narrative === 'string' ? raw.support_narrative.trim() : '',
        evidence_quote: evidence,
        is_stated_support: statedSupport,
        auto_budgeted: statedSupport,
        source: 'merged',
        validation_status: 'needs_review',
        validation_reason: 'supplemented_from_llm_missing_category'
      });
      byCategory.set(category, next);
      merged.push(next);
      continue;
    }

    if (Math.abs(existing.amount - amount) > 0.01) {
      const preferLlmAmount =
        total != null &&
        errLlm != null &&
        errDet != null &&
        errLlm < errDet &&
        errDet > Math.max(1, total * 0.005) &&
        Math.abs(existing.amount - amount) / Math.max(existing.amount, amount) > 0.02;

      if (preferLlmAmount) {
        existing.amount = amount;
        existing.validation_status = 'needs_review';
        existing.validation_reason = 'llm_amount_preferred_for_total_fit';
        existing.evidence_quote = evidence;
        existing.source = 'merged';
      } else {
        existing.validation_status = 'needs_review';
        existing.validation_reason = `llm_amount_differs (${existing.amount} vs ${amount})`;
        existing.evidence_quote = evidence;
        existing.source = 'merged';
      }
    } else if (!existing.evidence_quote) {
      existing.evidence_quote = evidence;
      existing.source = 'merged';
    }
  }

  const budgets = merged.map((b) => withCanonicalName(b));
  return { budgets, dropped };
}
