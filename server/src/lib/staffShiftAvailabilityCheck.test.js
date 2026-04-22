import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkShiftAgainstStaffAvailability } from './staffShiftAvailabilityCheck.js';

const SYD = { kind: 'iana', zone: 'Australia/Sydney' };

describe('checkShiftAgainstStaffAvailability', () => {
  test('unknown when no availability configured', () => {
    const r = checkShiftAgainstStaffAvailability(null, '2026-04-20T10:00:00', '2026-04-20T12:00:00', SYD);
    assert.equal(r.status, 'unknown');
  });

  test('full shift inside one slot (Monday)', () => {
    const json = JSON.stringify({
      mon: [{ start: '09:00', end: '17:00' }],
    });
    const r = checkShiftAgainstStaffAvailability(json, '2026-04-20T10:00:00', '2026-04-20T12:00:00', SYD);
    // 2026-04-20 is Monday
    assert.equal(r.status, 'inside');
  });

  test('shift crosses gap between two slots', () => {
    const json = JSON.stringify({
      mon: [
        { start: '09:00', end: '12:00' },
        { start: '14:00', end: '17:00' },
      ],
    });
    const r = checkShiftAgainstStaffAvailability(json, '2026-04-20T11:00:00', '2026-04-20T15:00:00', SYD);
    assert.equal(r.status, 'outside');
  });

  test('shift in second slot only is inside', () => {
    const json = JSON.stringify({
      mon: [
        { start: '09:00', end: '12:00' },
        { start: '14:00', end: '17:00' },
      ],
    });
    const r = checkShiftAgainstStaffAvailability(json, '2026-04-20T14:30:00', '2026-04-20T16:00:00', SYD);
    assert.equal(r.status, 'inside');
  });

  test('day with no hours is outside', () => {
    const json = JSON.stringify({
      mon: [{ start: '09:00', end: '12:00' }],
      tue: [],
    });
    // Tuesday 10–12, no tue availability
    const r = checkShiftAgainstStaffAvailability(json, '2026-04-21T10:00:00', '2026-04-21T12:00:00', SYD);
    assert.equal(r.status, 'outside');
  });

  test('shift ending exactly at slot end is inside', () => {
    const json = JSON.stringify({
      mon: [{ start: '09:00', end: '12:00' }],
    });
    const r = checkShiftAgainstStaffAvailability(json, '2026-04-20T10:00:00', '2026-04-20T12:00:00', SYD);
    assert.equal(r.status, 'inside');
  });
});
