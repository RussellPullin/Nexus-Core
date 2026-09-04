import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLibrarySignaturePackets,
  resolveLibrarySignatureMode
} from './libraryDocumentSignature.service.js';

function master(id, signatureCount) {
  return { id, slug: id, display_name: id, manifest: { signature_count: signatureCount } };
}

describe('staff onboarding signature packets', () => {
  test('staff onboarding always uses packet mode', () => {
    assert.equal(resolveLibrarySignatureMode('staff_onboarding', 'hybrid'), 'packet');
    assert.equal(resolveLibrarySignatureMode('staff_onboarding', 'separate'), 'packet');
    assert.equal(resolveLibrarySignatureMode('staff_onboarding', 'packet'), 'packet');
  });

  test('participant onboarding keeps the configured mode', () => {
    assert.equal(resolveLibrarySignatureMode('participant_onboarding', 'hybrid'), 'hybrid');
    assert.equal(resolveLibrarySignatureMode('participant_onboarding', 'separate'), 'separate');
    assert.equal(resolveLibrarySignatureMode('participant_onboarding', null), 'hybrid');
  });

  test('packet mode puts every form in one envelope', () => {
    const packets = computeLibrarySignaturePackets(
      [master('a', 2), master('b', 1), master('c', 2)],
      'packet'
    );
    assert.equal(packets.length, 1);
    assert.equal(packets[0].length, 3);
  });

  test('hybrid mode still splits multi-signer forms for participants', () => {
    const packets = computeLibrarySignaturePackets([master('a', 2), master('b', 1), master('c', 2)], 'hybrid');
    assert.equal(packets.length, 3);
    assert.deepEqual(
      packets.map((p) => p.map((m) => m.id)),
      [['b'], ['a'], ['c']]
    );
  });
});
