/**
 * Nexus Coordination vs Nexus Agency — one tenant may enable either or both.
 * Shared by server and client (keep values in sync).
 *
 * Shared-core discipline: participant/staff/financial behaviour lives in one implementation;
 * Coordination vs Agency differ by shell (nav, labels, guards), not duplicate domain logic.
 */

export const PRODUCT_COORDINATION = 'coordination';
export const PRODUCT_AGENCY = 'agency';

/** @param {unknown} v */
export function isValidActiveProduct(v) {
  return v === PRODUCT_COORDINATION || v === PRODUCT_AGENCY;
}
