import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBudgetsFromSupportCategoryBlocks,
  extractAmountFromCategoryBlock,
  mapKeyProximityLimit
} from './planPdfCategoryBlocks.js';

const CAT_NAMES = {
  '01': 'Assistance with Daily Life',
  '07': 'Support Coordination',
  '15': 'Improved Daily Living Skills'
};

describe('extractBudgetsFromSupportCategoryBlocks', () => {
  test('parses each Support Category block in order with last occurrence per cat', () => {
    const text = `
Support Category 01 Assistance with Daily Life
Some narrative about support coordination helping you with goals.
Your budget $2,500.00

Support Category 15 Improved Daily Living Skills
Your budget $45,000.00

Support Category 07 Support Coordination
Your budget $3,200.50
`;
    const rows = extractBudgetsFromSupportCategoryBlocks(text, CAT_NAMES, 100000);
    const byCat = Object.fromEntries(rows.map((r) => [r.category, r]));
    assert.equal(byCat['01'].amount, 2500);
    assert.equal(byCat['15'].amount, 45000);
    assert.equal(byCat['07'].amount, 3200.5);
  });

  test('extracts instalment rows inside a category block', () => {
    const text = `
Support Category 07 Support Coordination
Your budget $1,000
Fund release 01/07/2025 $250.00
01/10/2025 $250.00
`;
    const rows = extractBudgetsFromSupportCategoryBlocks(text, CAT_NAMES, 50000);
    const b7 = rows.find((r) => r.category === '07');
    assert.ok(b7.fund_releases);
    assert.equal(b7.fund_releases.length, 2);
  });
});

describe('extractAmountFromCategoryBlock', () => {
  test('ignores plan total when provided', () => {
    const block = 'Your budget $99,999.00\nTotal funded supports $99,999.00';
    const a = extractAmountFromCategoryBlock(block, 99999);
    assert.equal(a, 0);
  });
});

describe('mapKeyProximityLimit', () => {
  test('coordination keys use tight window', () => {
    assert.ok(mapKeyProximityLimit('support coordination', '07') < mapKeyProximityLimit('transport', '02'));
  });
});
