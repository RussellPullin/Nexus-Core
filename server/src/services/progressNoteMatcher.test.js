import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pickBestSameDayShiftMatch } from './progressNoteMatcher.js';

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
