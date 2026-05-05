/**
 * Merge deterministic PDF metadata with LLM phase-1 metadata for parse-plan responses.
 */

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * @param {{ total_plan_budget?: number|null, plan_dates?: { start_date?: string|null, end_date?: string|null }|null }|null} deterministic
 * @param {{ total_plan_budget?: number|null, plan_dates?: { start_date?: string|null, end_date?: string|null }|null }|null} aiResult
 * @returns {{ total_plan_budget: number|null, plan_dates: { start_date: string|null, end_date: string|null }, merge_warnings: string[] }}
 */
export function mergeParsePlanMetadata(deterministic, aiResult) {
  const merge_warnings = [];
  const detT = numOrNull(deterministic?.total_plan_budget);
  const aiT = numOrNull(aiResult?.total_plan_budget);

  let total_plan_budget = null;
  if (detT != null && aiT != null) {
    const rel = Math.abs(detT - aiT) / Math.max(detT, aiT);
    total_plan_budget = detT;
    if (rel > 0.005) {
      merge_warnings.push(
        `Document regex total ($${detT.toLocaleString()}) differs from AI-estimated total ($${aiT.toLocaleString()}). Using regex total for validation.`
      );
    }
  } else if (detT != null) {
    total_plan_budget = detT;
  } else if (aiT != null) {
    total_plan_budget = aiT;
  }

  const dPd = deterministic?.plan_dates || null;
  const aPd = aiResult?.plan_dates || null;

  const pickStart = () => {
    const dS = dPd?.start_date || null;
    const aS = aPd?.start_date || null;
    if (dS && aS && dS !== aS) {
      merge_warnings.push('Plan start date differs between text heuristics and AI; using text heuristics.');
      return dS;
    }
    return dS || aS || null;
  };
  const pickEnd = () => {
    const dE = dPd?.end_date || null;
    const aE = aPd?.end_date || null;
    if (dE && aE && dE !== aE) {
      merge_warnings.push('Plan end date differs between text heuristics and AI; using text heuristics.');
      return dE;
    }
    return dE || aE || null;
  };

  const plan_dates = {
    start_date: pickStart(),
    end_date: pickEnd()
  };

  return { total_plan_budget, plan_dates, merge_warnings };
}

/**
 * Prefer LLM fund release when it has releases and acceptable confidence; else deterministic.
 * @param {object|null} llmSchedule
 * @param {object|null} deterministicSchedule
 */
export function pickFundReleaseSchedule(llmSchedule, deterministicSchedule) {
  const llmRel = llmSchedule && Array.isArray(llmSchedule.releases) ? llmSchedule.releases : [];
  const llmOk =
    llmRel.length > 0 &&
    (llmSchedule.confidence === 'high' || llmSchedule.confidence === 'medium');
  if (llmOk) return llmSchedule;

  const detRel = deterministicSchedule && Array.isArray(deterministicSchedule.releases)
    ? deterministicSchedule.releases
    : [];
  if (detRel.length > 0) return deterministicSchedule;

  return llmSchedule || deterministicSchedule || null;
}
