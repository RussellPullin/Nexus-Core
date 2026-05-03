import { isValidActiveProduct } from '@nexus-shared/tenantProduct.js';

/** Browser localStorage key for last Nexus Coordination vs Nexus Agency shell (dual-access users). */
export const NEXUS_PREFERRED_PRODUCT_KEY = 'nexus_preferred_product';

/** @returns {'coordination'|'agency'|null} */
export function readPreferredProductSurface() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const v = localStorage.getItem(NEXUS_PREFERRED_PRODUCT_KEY);
    return isValidActiveProduct(v) ? v : null;
  } catch {
    return null;
  }
}

/** @param {'coordination'|'agency'} surface */
export function writePreferredProductSurface(surface) {
  if (typeof localStorage === 'undefined') return;
  if (!isValidActiveProduct(surface)) return;
  try {
    localStorage.setItem(NEXUS_PREFERRED_PRODUCT_KEY, surface);
  } catch {
    /* quota / private mode */
  }
}

export function clearPreferredProductSurface() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(NEXUS_PREFERRED_PRODUCT_KEY);
  } catch {
    /* */
  }
}
