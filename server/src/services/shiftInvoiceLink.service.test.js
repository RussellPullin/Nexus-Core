import { describe, test, expect } from 'vitest';
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
    expect(
      shiftImportIdentityMatches(shift, {
        participantId: 'p1',
        staffId: 's1',
        startDateTime: '2026-07-06 15:00:00',
      }),
    ).toBe(true);
    expect(
      shiftImportIdentityMatches(shift, {
        participantId: 'p2',
        staffId: 's1',
        startDateTime: '2026-07-06T15:00:00',
      }),
    ).toBe(false);
    expect(
      shiftImportIdentityMatches(shift, {
        participantId: 'p1',
        staffId: 's1',
        startDateTime: '2026-06-25T15:00:00',
      }),
    ).toBe(false);
  });

  test('canImportMergeIntoShift blocks billed shift when identity differs', () => {
    const billed = {
      participant_id: 'ruby',
      staff_id: 'lorraine',
      start_time: '2026-06-25T15:00:00',
      billing_invoice_id: 'inv-1',
    };
    expect(
      canImportMergeIntoShift(billed, {
        participantId: 'tanya',
        staffId: 'lorraine',
        startDateTime: '2026-07-06T15:00:00',
      }),
    ).toBe(false);
    expect(
      canImportMergeIntoShift(billed, {
        participantId: 'ruby',
        staffId: 'lorraine',
        startDateTime: '2026-06-25T15:00:00',
      }),
    ).toBe(true);
  });

  test('canImportMergeIntoShift allows unbilled shift merge', () => {
    const open = {
      participant_id: 'p1',
      staff_id: 's1',
      start_time: '2026-07-06T15:00:00',
      billing_invoice_id: null,
    };
    expect(
      canImportMergeIntoShift(open, {
        participantId: 'p2',
        staffId: 's1',
        startDateTime: '2026-07-07T15:00:00',
      }),
    ).toBe(true);
  });
});
