import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { comparePayPeriodOptions, comparePaySummaryRows, payPeriodIso } from '../../../shared/payPeriodOrder.js';

describe('payPeriodIso', () => {
  test('converts dd/mm/yyyy to yyyy-mm-dd', () => {
    assert.equal(payPeriodIso('14/10/2026'), '2026-10-14');
    assert.equal(payPeriodIso('1/3/2026'), '2026-03-01');
    assert.equal(payPeriodIso('2026-09-28'), '2026-09-28');
  });
});

describe('pay period sequence', () => {
  test('orders fortnights by calendar date, newest first', () => {
    const periods = [
      { periodStart: '28/09/2026', periodEnd: '11/10/2026' },
      { periodStart: '14/09/2026', periodEnd: '27/09/2026' },
      { periodStart: '12/10/2026', periodEnd: '25/10/2026' },
    ];
    const ordered = [...periods].sort(comparePayPeriodOptions).map((p) => p.periodStart);
    assert.deepEqual(ordered, ['12/10/2026', '28/09/2026', '14/09/2026']);
  });

  test('keeps the same period together and sorts staff by name', () => {
    const rows = [
      { staffName: 'Zara', periodStart: '14/09/2026', periodEnd: '27/09/2026' },
      { staffName: 'Amy', periodStart: '12/10/2026', periodEnd: '25/10/2026' },
      { staffName: 'Ben', periodStart: '14/09/2026', periodEnd: '27/09/2026' },
    ];
    const ordered = [...rows].sort(comparePaySummaryRows).map((r) => `${r.periodStart} ${r.staffName}`);
    assert.deepEqual(ordered, ['12/10/2026 Amy', '14/09/2026 Ben', '14/09/2026 Zara']);
  });
});
