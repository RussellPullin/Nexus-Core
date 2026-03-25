const VALID_CATEGORIES = new Set([
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15'
]);
const STATED_SUPPORT_RE = /\bstated\s+(?:support|supports|item|items)\b/i;

const CORE_CATS = new Set(['01', '02', '03', '04']);
const CAPITAL_CATS = new Set(['05', '06']);
const CAPACITY_CATS = new Set(['07', '08', '09', '10', '11', '12', '13', '14', '15']);

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
    textLower.lastIndexOf('core supports', pos)
  );
  const lastCapBuild = Math.max(
    textLower.lastIndexOf('total capacity building', pos),
    textLower.lastIndexOf('capacity building supports', pos),
    textLower.lastIndexOf('capacity building', pos)
  );
  const lastCapital = Math.max(
    textLower.lastIndexOf('capital supports', pos),
    textLower.lastIndexOf('assistive technology', pos),
    textLower.lastIndexOf('home modifications', pos)
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
        source: 'deterministic',
        validation_status: 'verified',
        validation_reason: null
      };
    })
    .filter(Boolean);
}

export function reconcilePlanExtraction({ text, deterministicBudgets, llmBudgets, allowLlmOnly = false }) {
  const textLower = String(text || '').toLowerCase();
  const merged = [];
  const byCategory = new Map();
  const dropped = [];
  const normalizedDeterministic = normalizeDeterministicBudgets(deterministicBudgets);
  const llmOnlyAllowed = !!allowLlmOnly && normalizedDeterministic.length === 0;

  for (const b of normalizedDeterministic) {
    byCategory.set(b.category, b);
    merged.push(b);
  }

  const aiList = Array.isArray(llmBudgets) ? llmBudgets : [];
  for (const raw of aiList) {
    const category = toCategory(raw?.category);
    const amount = toAmount(raw?.amount);
    const evidence = String(raw?.evidence_quote || '').trim();
    const evidenceLower = evidence.toLowerCase();

    if (!VALID_CATEGORIES.has(category) || amount <= 0) {
      dropped.push({ category, reason: 'invalid_category_or_amount' });
      continue;
    }

    if (!evidence || evidence.length < 6) {
      dropped.push({ category, reason: 'missing_evidence_quote' });
      continue;
    }

    const evidencePos = textLower.indexOf(evidenceLower);
    if (evidencePos < 0) {
      dropped.push({ category, reason: 'evidence_not_found_in_document' });
      continue;
    }

    const section = findSectionAt(textLower, evidencePos);
    if (!sectionAllows(section, category)) {
      dropped.push({ category, reason: `category_not_allowed_in_${section || 'unknown'}_section` });
      continue;
    }

    const existing = byCategory.get(category);
    if (!existing) {
      if (!llmOnlyAllowed) {
        dropped.push({ category, reason: 'llm_only_category_not_allowed' });
        continue;
      }
      const statedSupport = isStatedSupportBudget(raw);
      const next = {
        category,
        name: raw?.name || `Category ${category}`,
        amount,
        line_item_numbers: Array.isArray(raw?.line_item_numbers) ? raw.line_item_numbers : [],
        support_narrative: raw?.support_narrative || '',
        evidence_quote: evidence,
        is_stated_support: statedSupport,
        auto_budgeted: statedSupport,
        source: 'llm',
        validation_status: 'needs_review',
        validation_reason: 'llm_only_match'
      };
      byCategory.set(category, next);
      merged.push(next);
      continue;
    }

    // Keep deterministic amount as authority; mark for review if LLM disagrees.
    if (Math.abs(existing.amount - amount) > 0.01) {
      existing.validation_status = 'needs_review';
      existing.validation_reason = `llm_amount_differs (${existing.amount} vs ${amount})`;
      existing.evidence_quote = evidence;
      existing.source = 'merged';
    } else if (!existing.evidence_quote) {
      existing.evidence_quote = evidence;
      existing.source = 'merged';
    }
  }

  return { budgets: merged, dropped };
}

