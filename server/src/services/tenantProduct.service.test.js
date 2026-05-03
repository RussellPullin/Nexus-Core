import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCT_AGENCY,
  PRODUCT_COORDINATION
} from '../../../shared/tenantProduct.js';
import {
  computeEffectiveProducts,
  getUserProductAccess,
  normalizeOrgProductSelectionFromBody,
  resolveDefaultActiveProduct
} from './tenantProduct.service.js';

describe('tenantProduct.service (shared core / dual shell)', () => {
  test('computeEffectiveProducts respects org ∧ user flags', () => {
    const e = computeEffectiveProducts(
      { coordination_enabled: 1, agency_enabled: 1 },
      { coordination_access: 1, agency_access: 0 }
    );
    assert.equal(e.can_coordination, true);
    assert.equal(e.can_agency, false);
  });

  test('computeEffectiveProducts when org missing defaults agency-only', () => {
    const e = computeEffectiveProducts(null, { coordination_access: 1, agency_access: 1 });
    assert.equal(e.can_coordination, false);
    assert.equal(e.can_agency, true);
  });

  test('resolveDefaultActiveProduct keeps valid session product when allowed', () => {
    const eff = { can_coordination: true, can_agency: true };
    assert.equal(
      resolveDefaultActiveProduct(eff, PRODUCT_COORDINATION),
      PRODUCT_COORDINATION
    );
    assert.equal(resolveDefaultActiveProduct(eff, PRODUCT_AGENCY), PRODUCT_AGENCY);
  });

  test('resolveDefaultActiveProduct ignores session product when not allowed', () => {
    const eff = { can_coordination: true, can_agency: false };
    assert.equal(resolveDefaultActiveProduct(eff, PRODUCT_AGENCY), PRODUCT_COORDINATION);
  });

  test('normalizeOrgProductSelectionFromBody defaults to agency when body omits both', () => {
    const p = normalizeOrgProductSelectionFromBody({});
    assert.equal(p.agency_enabled, 1);
    assert.equal(p.coordination_enabled, 0);
  });

  test('getUserProductAccess treats null columns as allow both', () => {
    const a = getUserProductAccess({});
    assert.equal(a.coordination_access, 1);
    assert.equal(a.agency_access, 1);
  });
});
