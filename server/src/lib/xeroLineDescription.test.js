import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatServiceDateForInvoice, buildXeroLineDescription } from './xeroLineDescription.js';

describe('formatServiceDateForInvoice', () => {
  test('formats YYYY-MM-DD as day Mon year without UTC shift', () => {
    assert.equal(formatServiceDateForInvoice('2026-09-15'), '15 Sep 2026');
    assert.equal(formatServiceDateForInvoice('2026-01-01'), '1 Jan 2026');
  });

  test('returns empty for missing or invalid values', () => {
    assert.equal(formatServiceDateForInvoice(null), '');
    assert.equal(formatServiceDateForInvoice(''), '');
    assert.equal(formatServiceDateForInvoice('not-a-date'), '');
  });
});

describe('buildXeroLineDescription', () => {
  test('puts service date and item number above the support name', () => {
    assert.equal(
      buildXeroLineDescription({
        support_item_number: '01_011_0107_1_1',
        description: 'Assistance With Self-Care Activities - Standard - Weekday Daytime',
        line_date: '2026-09-15',
      }),
      '15 Sep 2026 · 01_011_0107_1_1\nAssistance With Self-Care Activities - Standard - Weekday Daytime',
    );
  });

  test('omits placeholder item numbers and missing dates', () => {
    assert.equal(
      buildXeroLineDescription({
        support_item_number: '-',
        description: 'Support',
        line_date: null,
      }),
      'Support',
    );
    assert.equal(
      buildXeroLineDescription({
        support_item_number: '04_104_0125_6_1',
        description: 'Support Coordination',
        line_date: '2026-09-22',
      }),
      '22 Sep 2026 · 04_104_0125_6_1\nSupport Coordination',
    );
  });
});
