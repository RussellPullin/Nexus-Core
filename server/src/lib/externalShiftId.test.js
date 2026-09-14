import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isStableExternalShiftId, normalizeExternalShiftId } from './externalShiftId.js';

describe('externalShiftId', () => {
  test('rejects Excel row numbers', () => {
    assert.equal(isStableExternalShiftId('25'), false);
    assert.equal(isStableExternalShiftId('1'), false);
    assert.equal(isStableExternalShiftId('108'), false);
    assert.equal(normalizeExternalShiftId('25'), '');
  });

  test('accepts Shifter UUIDs', () => {
    const id = '1d477744-6d76-583b-9f98-32145e70868e';
    assert.equal(isStableExternalShiftId(id), true);
    assert.equal(normalizeExternalShiftId(id), id);
  });

  test('rejects empty values', () => {
    assert.equal(isStableExternalShiftId(''), false);
    assert.equal(isStableExternalShiftId(null), false);
    assert.equal(normalizeExternalShiftId('   '), '');
  });
});
