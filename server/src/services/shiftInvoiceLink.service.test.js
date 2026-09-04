import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  shiftImportIdentityMatches,
  canImportMergeIntoShift,
} from './shiftInvoiceLink.service.js';

describe('shiftInvoiceLink.service', () => {
  test('shiftImportIdentityMatches requires same participant, staff, and day', () => {
    const shift = {
      participant_id: 'p1',
      staff_id: 's1',
      start_time: '2026-07-06T15:00:00',
    };
    assert.equal(
      shiftImportIdentityMatches(shift, {
        participantId: 'p1',
        staffId: 's1',
        startDateTime: '2026-07-06 15:00:00',
      }),
      true,
    );
    assert.equal(
      shiftImportIdentityMatches(shift, {
        participantId: 'p2',
        staffId: 's1',
        startDateTime: '2026-07-06T15:00:00',
      }),
      false,
    );
    assert.equal(
      shiftImportIdentityMatches(shift, {
        participantId: 'p1',
        staffId: 's1',
        startDateTime: '2026-06-25T15:00:00',
      }),
      false,
    );
  });

  test('canImportMergeIntoShift blocks billed shift when identity differs', () => {
    const billed = {
      participant_id: 'samuel',
      staff_id: 'lorraine',
      start_time: '2026-03-20T12:00:00',
      billing_invoice_id: 'inv-1',
    };
    assert.equal(
      canImportMergeIntoShift(billed, {
        participantId: 'tanya',
        staffId: 'lorraine',
        startDateTime: '2026-09-03T12:00:00',
      }),
      false,
    );
    assert.equal(
      canImportMergeIntoShift(billed, {
        participantId: 'samuel',
        staffId: 'lorraine',
        startDateTime: '2026-03-20T12:00:00',
      }),
      true,
    );
  });

  test('canImportMergeIntoShift allows unbilled shift merge', () => {
    const open = {
      participant_id: 'p1',
      staff_id: 's1',
      start_time: '2026-07-06T15:00:00',
      billing_invoice_id: null,
    };
    assert.equal(
      canImportMergeIntoShift(open, {
        participantId: 'p2',
        staffId: 's1',
        startDateTime: '2026-07-07T15:00:00',
      }),
      true,
    );
  });
});
