/**
 * Nexus Coordination vs Nexus Agency — one tenant may enable either or both.
 * Shared by server and client (keep values in sync).
 */

export const PRODUCT_COORDINATION = 'coordination';
export const PRODUCT_AGENCY = 'agency';

/** @param {unknown} v */
export function isValidActiveProduct(v) {
  return v === PRODUCT_COORDINATION || v === PRODUCT_AGENCY;
}
