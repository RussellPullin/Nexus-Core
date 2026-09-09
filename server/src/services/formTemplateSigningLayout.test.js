import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  inferSigner,
  inferAppliesWhen,
  suggestSigningLayoutFromPdf
} from './formTemplateSigningLayout.service.js';

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), '../../templates/library');

describe('inferSigner for tokenised NDIS masters', () => {
  test('provider execution block p_sig / p_name / p_date is org', () => {
    assert.equal(inferSigner('', 'participant_onboarding', 'p_sig'), 'org');
    assert.equal(inferSigner('', 'participant_onboarding', 'p_name'), 'org');
    assert.equal(inferSigner('', 'participant_onboarding', 'p_date'), 'org');
  });

  test('staff declaration s_sig is org', () => {
    assert.equal(inferSigner('', 'participant_onboarding', 's_sig'), 'org');
    assert.equal(inferSigner('', 'participant_onboarding', 's_name'), 'org');
  });

  test('client and representative blocks are not org', () => {
    assert.equal(inferSigner('', 'participant_onboarding', 'cs_sig'), 'participant');
    assert.equal(inferSigner('', 'participant_onboarding', 'c_sig'), 'participant');
    assert.equal(inferSigner('', 'participant_onboarding', 'a_sig'), 'participant');
    assert.equal(inferSigner('', 'participant_onboarding', 'rep_sig'), 'participant');
    assert.equal(inferSigner('', 'participant_onboarding', 'rs_sig'), 'participant');
  });

  test('plan manager pm_name is not treated as the provider signature block', () => {
    assert.equal(inferSigner('', 'participant_onboarding', 'pm_name'), 'participant');
  });
});

describe('inferAppliesWhen', () => {
  test('tags client vs guardian signature blocks', () => {
    assert.equal(inferAppliesWhen('cs_sig'), 'participant');
    assert.equal(inferAppliesWhen('c_name'), 'participant');
    assert.equal(inferAppliesWhen('a_sig'), 'participant');
    assert.equal(inferAppliesWhen('rs_sig'), 'guardian');
    assert.equal(inferAppliesWhen('rep_sig'), 'guardian');
    assert.equal(inferAppliesWhen('b_name'), 'guardian');
    assert.equal(inferAppliesWhen('c_first'), null);
  });
});

describe('suggestSigningLayoutFromPdf on onboarding masters', () => {
  test('services agreement uses the provider p_sig box, not a fallback overlay', async () => {
    const pdf = readFileSync(join(templatesDir, 'services-agreement/template.pdf'));
    const layout = await suggestSigningLayoutFromPdf(pdf, {}, 'participant_onboarding');
    const pSig = layout.fields.find((f) => f.api_id === 'p_sig' || f.merge_key === 'p_sig');
    const csSig = layout.fields.find((f) => f.api_id === 'cs_sig' || f.merge_key === 'cs_sig');
    assert.ok(pSig, 'p_sig field present');
    assert.equal(pSig.signer, 'org');
    assert.equal(pSig.page, 5);
    assert.ok(csSig);
    assert.equal(csSig.signer, 'participant');
    assert.equal(layout.fields.some((f) => f.merge_key === 'org_signature'), false);
  });

  test('service schedule provider signature is on page 1', async () => {
    const pdf = readFileSync(join(templatesDir, 'service-schedule/template.pdf'));
    const layout = await suggestSigningLayoutFromPdf(pdf, {}, 'participant_onboarding');
    const pSig = layout.fields.find((f) => f.api_id === 'p_sig' || f.merge_key === 'p_sig');
    assert.ok(pSig);
    assert.equal(pSig.signer, 'org');
    assert.equal(pSig.page, 1);
  });

  test('privacy consent includes support-team checkboxes', async () => {
    const pdf = readFileSync(join(templatesDir, 'privacy-consent-form/template.pdf'));
    const layout = await suggestSigningLayoutFromPdf(pdf, {}, 'participant_onboarding');
    const tp = layout.fields.filter((f) => f.type === 'checkbox' && String(f.api_id || f.merge_key).startsWith('tp_'));
    assert.ok(tp.length >= 10, `expected tp_* checkboxes, got ${tp.length}`);
    const sSig = layout.fields.find((f) => f.api_id === 's_sig' || f.merge_key === 's_sig');
    assert.equal(sSig?.signer, 'org');
  });
});
