import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePlanExtraction, CANONICAL_CATEGORY_NAMES } from './planReconciler.js';
import { mergeParsePlanMetadata, pickFundReleaseSchedule } from './planMerge.js';
import { extractFundReleaseScheduleFromPdfText } from '../../utils/planFundReleaseExtract.js';

describe('mergeParsePlanMetadata', () => {
  test('prefers deterministic total when both present', () => {
    const r = mergeParsePlanMetadata(
      { total_plan_budget: 100000, plan_dates: { start_date: '2024-01-01', end_date: '2025-01-01' } },
      { total_plan_budget: 100100, plan_dates: { start_date: '2024-01-01', end_date: '2025-01-01' } }
    );
    assert.equal(r.total_plan_budget, 100000);
    assert.equal(r.plan_dates.start_date, '2024-01-01');
  });

  test('uses AI total when deterministic missing', () => {
    const r = mergeParsePlanMetadata({ total_plan_budget: null, plan_dates: null }, { total_plan_budget: 50000, plan_dates: { start_date: '2024-06-01', end_date: null } });
    assert.equal(r.total_plan_budget, 50000);
    assert.equal(r.plan_dates.start_date, '2024-06-01');
  });
});

describe('pickFundReleaseSchedule', () => {
  test('prefers LLM when confidence medium and releases present', () => {
    const llm = { releases: [{ scheduled_date: '2024-03-01', amount: 100 }], confidence: 'medium' };
    const det = { releases: [{ scheduled_date: '2024-01-01', amount: 50 }], confidence: 'medium' };
    assert.equal(pickFundReleaseSchedule(llm, det), llm);
  });

  test('falls back to deterministic when LLM empty', () => {
    const det = { releases: [{ scheduled_date: '2024-01-01', amount: 50 }], confidence: 'medium' };
    assert.equal(pickFundReleaseSchedule({ releases: [], confidence: 'high' }, det), det);
  });
});

describe('extractFundReleaseScheduleFromPdfText', () => {
  test('extracts d/m/y rows after section header', () => {
    const text = `Some intro\nFunding schedule\n15/07/2024  $10,000.00\n16/10/2024 $10,000.50`;
    const sch = extractFundReleaseScheduleFromPdfText(text);
    assert.ok(sch);
    assert.equal(sch.releases.length, 2);
    assert.equal(sch.releases[0].scheduled_date, '2024-07-15');
    assert.equal(sch.releases[0].amount, 10000);
    assert.equal(sch.releases[1].amount, 10000.5);
  });

  test('returns null when no schedule section', () => {
    assert.equal(extractFundReleaseScheduleFromPdfText('No money here $500'), null);
  });
});

describe('reconcilePlanExtraction', () => {
  const text = `
Total funded supports $30,000
Core supports
Assistance with Daily Life: $10,000
Transport: $5,000
Consumables: $5,000
Capacity building
Support Coordination: $10,000
`;

  function ev(catLine) {
    return { evidence_quote: catLine, support_narrative: '', line_item_numbers: [] };
  }

  test('LLM set wins when sum matches merged total better than deterministic', () => {
    const det = [
      { category: '01', name: 'X', amount: 9999 },
      { category: '02', name: 'Y', amount: 5000 },
      { category: '03', name: 'Z', amount: 5000 },
      { category: '07', name: 'SC', amount: 10000 }
    ];
    const llm = [
      { category: '01', name: 'Wrong', amount: 10000, ...ev('Assistance with Daily Life: $10,000') },
      { category: '02', name: 'T', amount: 5000, ...ev('Transport: $5,000') },
      { category: '03', name: 'C', amount: 5000, ...ev('Consumables: $5,000') },
      { category: '07', name: 'SC', amount: 10000, ...ev('Support Coordination: $10,000') }
    ];
    const { budgets } = reconcilePlanExtraction({
      text,
      deterministicBudgets: det,
      llmBudgets: llm,
      allowLlmOnly: false,
      mergedTotalPlanBudget: 30000
    });
    assert.equal(budgets.length, 4);
    const b1 = budgets.find((b) => b.category === '01');
    assert.equal(b1.amount, 10000);
    assert.equal(b1.name, CANONICAL_CATEGORY_NAMES['01']);
    assert.equal(b1.source, 'llm');
  });

  test('supplements missing category from LLM when deterministic partial', () => {
    const det = [
      { category: '01', name: 'X', amount: 10000 },
      { category: '02', name: 'Y', amount: 5000 }
    ];
    const llm = [
      { category: '01', name: 'A', amount: 10000, ...ev('Assistance with Daily Life: $10,000') },
      { category: '02', name: 'B', amount: 5000, ...ev('Transport: $5,000') },
      { category: '03', name: 'C', amount: 5000, ...ev('Consumables: $5,000') },
      { category: '07', name: 'SC', amount: 10000, ...ev('Support Coordination: $10,000') }
    ];
    const { budgets } = reconcilePlanExtraction({
      text,
      deterministicBudgets: det,
      llmBudgets: llm,
      allowLlmOnly: false,
      mergedTotalPlanBudget: 30000
    });
    assert.equal(budgets.length, 4);
    const b3 = budgets.find((b) => b.category === '03');
    assert.ok(b3);
    assert.equal(b3.amount, 5000);
    assert.equal(b3.name, CANONICAL_CATEGORY_NAMES['03']);
  });

  test('allowLlmOnly uses full LLM list', () => {
    const llm = [
      { category: '01', name: 'A', amount: 10000, ...ev('Assistance with Daily Life: $10,000') },
      { category: '07', name: 'SC', amount: 10000, ...ev('Support Coordination: $10,000') }
    ];
    const { budgets } = reconcilePlanExtraction({
      text,
      deterministicBudgets: [],
      llmBudgets: llm,
      allowLlmOnly: true,
      mergedTotalPlanBudget: 20000
    });
    assert.equal(budgets.length, 2);
    assert.equal(budgets.every((b) => b.source === 'llm'), true);
  });

  test('supplements category 15 from Improved Daily Living evidence', () => {
    const planText = `
Total funded supports $45,000
Capacity building supports
Improved Daily Living
(CB Daily Activity): $45,000
`;
    const llm = [
      {
        category: '15',
        name: 'Improved Daily Living',
        amount: 45000,
        ...ev('Improved Daily Living (CB Daily Activity): $45,000')
      }
    ];
    const { budgets, dropped } = reconcilePlanExtraction({
      text: planText,
      deterministicBudgets: [],
      llmBudgets: llm,
      allowLlmOnly: true,
      mergedTotalPlanBudget: 45000
    });
    assert.equal(dropped.length, 0);
    assert.equal(budgets.length, 1);
    assert.equal(budgets[0].category, '15');
    assert.equal(budgets[0].name, CANONICAL_CATEGORY_NAMES['15']);
  });

  test('does not add AI category 15 when deterministic core already matches total', () => {
    const planText = `
Total funded supports $10,000
Core supports
Assistance with Daily Life: $10,000

Capacity building supports
Improved Daily Living: $10,000
`;
    const llm = [
      {
        category: '15',
        name: 'Improved Daily Living',
        amount: 10000,
        ...ev('Improved Daily Living: $10,000')
      }
    ];
    const { budgets, dropped } = reconcilePlanExtraction({
      text: planText,
      deterministicBudgets: [
        { category: '01', name: 'Assistance with Daily Life', amount: 10000 }
      ],
      llmBudgets: llm,
      allowLlmOnly: false,
      mergedTotalPlanBudget: 10000
    });
    assert.equal(budgets.length, 1);
    assert.equal(budgets[0].category, '01');
    assert.equal(dropped[0]?.reason, 'llm_missing_category_would_worsen_total_match');
  });
});
