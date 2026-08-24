import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickBestSameDayShiftMatch,
  preferDuplicateKeeper,
  shiftsAreSameVisit,
} from './progressNoteMatcher.js';

const day = {
  id: 'day',
  start_time: '2026-08-10T08:30:00',
  end_time: '2026-08-10T14:30:00',
};
const afternoonStub = {
  id: 'stub',
  start_time: '2026-08-10T16:00:00',
  end_time: '2026-08-10T17:00:00',
};
const evening = {
  id: 'evening',
  start_time: '2026-08-10T18:00:00',
  end_time: '2026-08-10T20:30:00',
};
const eveningRoster = {
  id: 'evening-roster',
  start_time: '2026-08-10T16:00:00',
  end_time: '2026-08-10T20:30:00',
};

describe('pickBestSameDayShiftMatch', () => {
  test('daytime completion matches morning roster, not evening that only touches at 18:00', () => {
    const match = pickBestSameDayShiftMatch([evening, afternoonStub, day], '08:00', '18:00');
    assert.equal(match?.id, 'day');
  });

  test('evening completion matches evening shift, not the daytime row', () => {
    const match = pickBestSameDayShiftMatch([day, afternoonStub, evening], '18:00', '20:30');
    assert.equal(match?.id, 'evening');
  });

  test('late start still merges into the same evening roster slot', () => {
    const match = pickBestSameDayShiftMatch([day, eveningRoster], '18:00', '20:30');
    assert.equal(match?.id, 'evening-roster');
  });

  test('returns null when no same-slot candidate exists', () => {
    const match = pickBestSameDayShiftMatch([evening], '08:00', '18:00');
    assert.equal(match, null);
  });
});

describe('shiftsAreSameVisit', () => {
  test('treats a 16:00–17:00 stub as the same visit as 16:00–20:30', () => {
    assert.equal(shiftsAreSameVisit(afternoonStub, eveningRoster), true);
  });

  test('treats two identical evening slots as the same visit', () => {
    const copy = { ...eveningRoster, id: 'copy' };
    assert.equal(shiftsAreSameVisit(eveningRoster, copy), true);
  });

  test('does not merge a morning visit into an evening visit with a gap', () => {
    assert.equal(shiftsAreSameVisit(day, eveningRoster), false);
  });

  test('does not merge a day shift that only touches evening at 18:00', () => {
    const longDay = { id: 'long-day', start_time: '2026-08-10T08:00:00', end_time: '2026-08-10T18:00:00' };
    assert.equal(shiftsAreSameVisit(longDay, evening), false);
  });
});

describe('preferDuplicateKeeper', () => {
  test('keeps the Shifter UUID row over an Excel numeric id copy', () => {
    const uuidRow = {
      id: 'uuid',
      status: 'completed',
      shifter_shift_id: '3746d797-1c52-57c6-b3dc-f5a0519e282b',
      start_time: '2026-08-17T16:00:00',
      end_time: '2026-08-17T20:30:00',
      notes: 'Pacific Fair',
    };
    const excelRow = {
      id: 'excel',
      status: 'completed',
      shifter_shift_id: '319',
      recurring_group_id: 'group',
      start_time: '2026-08-17T16:00:00',
      end_time: '2026-08-17T20:30:00',
      notes: 'Pacific Fair',
    };
    assert.equal(preferDuplicateKeeper(uuidRow, excelRow).id, 'uuid');
  });
});
