import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { libraryDocumentAction } from './libraryDocumentUse.service.js';

describe('libraryDocumentAction', () => {
  test('a signature form is used for a participant', () => {
    assert.equal(
      libraryDocumentAction({ category: 'contract', signature_count: 3 }),
      'use_signature'
    );
  });

  test('a form without a signature is still used for a participant', () => {
    assert.equal(libraryDocumentAction({ category: 'form', signature_count: 0 }), 'use_form');
  });

  test('a policy is sent', () => {
    assert.equal(
      libraryDocumentAction({ category: 'policy', manifest: { signature_count: 0 } }),
      'send'
    );
  });
});
