import { db } from '../db/index.js';
import {
  PRODUCT_AGENCY,
  PRODUCT_COORDINATION,
  isValidActiveProduct
} from '../../../shared/tenantProduct.js';

/** @returns {{ coordination_enabled: number, agency_enabled: number } | null} */
export function getTenantAnchorFlags(orgId) {
  if (!orgId) return null;
  const row = db
    .prepare(
      `
    SELECT coordination_enabled, agency_enabled
    FROM organisations
    WHERE id = ? AND owner_org_id IS NOT NULL AND id = owner_org_id
  `
    )
    .get(orgId);
  if (!row) return null;
  return {
    coordination_enabled: row.coordination_enabled == null ? 0 : Number(row.coordination_enabled) ? 1 : 0,
    agency_enabled: row.agency_enabled == null ? 1 : Number(row.agency_enabled) ? 1 : 0
  };
}

/**
 * @param {unknown} body
 * @returns {{ coordination_enabled: number, agency_enabled: number }}
 */
export function normalizeOrgProductSelectionFromBody(body) {
  const c = body?.coordination_enabled;
  const a = body?.agency_enabled;
  const truthy = (x) => x === true || x === 1 || x === '1' || String(x).toLowerCase() === 'true';
  let coord = truthy(c);
  let ag = truthy(a);
  if (c === undefined && a === undefined) {
    coord = false;
    ag = true;
  }
  if (!coord && !ag) {
    const err = new Error('Select at least one product: Nexus Coordination and/or Nexus Agency.');
    err.code = 'VALIDATION';
    throw err;
  }
  return { coordination_enabled: coord ? 1 : 0, agency_enabled: ag ? 1 : 0 };
}

/**
 * @param {{ org_id?: string|null, coordination_access?: unknown, agency_access?: unknown }} userRow
 */
export function getUserProductAccess(userRow) {
  const ca =
    userRow?.coordination_access == null ? 1 : Number(userRow.coordination_access) ? 1 : 0;
  const aa = userRow?.agency_access == null ? 1 : Number(userRow.agency_access) ? 1 : 0;
  return { coordination_access: ca, agency_access: aa };
}

/**
 * Effective shells this user may open (org flags ∧ user access).
 */
export function computeEffectiveProducts(orgFlags, userAccess) {
  if (!orgFlags) {
    return {
      can_coordination: false,
      can_agency: true
    };
  }
  return {
    can_coordination: Boolean(orgFlags.coordination_enabled && userAccess.coordination_access),
    can_agency: Boolean(orgFlags.agency_enabled && userAccess.agency_access)
  };
}

/**
 * @param {{ can_coordination: boolean, can_agency: boolean }} effective
 * @param {string|null|undefined} sessionProduct
 */
export function resolveDefaultActiveProduct(effective, sessionProduct) {
  if (isValidActiveProduct(sessionProduct)) {
    if (sessionProduct === PRODUCT_COORDINATION && effective.can_coordination) return PRODUCT_COORDINATION;
    if (sessionProduct === PRODUCT_AGENCY && effective.can_agency) return PRODUCT_AGENCY;
  }
  if (effective.can_agency && !effective.can_coordination) return PRODUCT_AGENCY;
  if (effective.can_coordination && !effective.can_agency) return PRODUCT_COORDINATION;
  if (effective.can_agency) return PRODUCT_AGENCY;
  return PRODUCT_COORDINATION;
}

/**
 * @param {import('express').Request} req
 * @param {{ org_id?: string|null, coordination_access?: unknown, agency_access?: unknown }} userRow
 */
export function ensureSessionActiveProduct(req, userRow) {
  const orgFlags = getTenantAnchorFlags(userRow?.org_id || null);
  const userAccess = getUserProductAccess(userRow);
  const effective = computeEffectiveProducts(orgFlags, userAccess);
  const next = resolveDefaultActiveProduct(effective, req.session?.active_product);
  if (!req.session) return next;
  req.session.active_product = next;
  return next;
}

/**
 * @param {import('express').Request} req
 * @param {{ org_id?: string|null, coordination_access?: unknown, agency_access?: unknown }} userRow
 */
export function assertAgencyShellAccess(req, userRow) {
  const orgFlags = getTenantAnchorFlags(userRow?.org_id || null);
  const userAccess = getUserProductAccess(userRow);
  const effective = computeEffectiveProducts(orgFlags, userAccess);
  if (!effective.can_agency) {
    const err = new Error('Nexus Agency is not enabled for your organisation or your account.');
    err.code = 'AGENCY_SHELL_DENIED';
    throw err;
  }
  const ap = req.session?.active_product;
  if (ap !== PRODUCT_AGENCY) {
    const err = new Error('Switch to Nexus Agency to use this feature.');
    err.code = 'WRONG_ACTIVE_PRODUCT';
    throw err;
  }
}

export function tenantProductPayloadForUser(req, userRow) {
  const orgFlags = getTenantAnchorFlags(userRow?.org_id || null);
  const userAccess = getUserProductAccess(userRow);
  const effective = computeEffectiveProducts(orgFlags, userAccess);
  const active_product = ensureSessionActiveProduct(req, userRow);
  return {
    coordination_enabled: orgFlags ? !!orgFlags.coordination_enabled : false,
    agency_enabled: orgFlags ? !!orgFlags.agency_enabled : true,
    coordination_access: !!userAccess.coordination_access,
    agency_access: !!userAccess.agency_access,
    can_use_coordination: effective.can_coordination,
    can_use_agency: effective.can_agency,
    active_product
  };
}
