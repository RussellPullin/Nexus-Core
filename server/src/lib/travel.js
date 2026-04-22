/**
 * NDIS travel line item classification and matching utilities.
 * Supports: Provider travel non-labour (01_799, 04_799), Activity-based transport (590/591/…),
 * Participant Transport budget (02_051).
 */

/** Provider travel non-labour pattern: XX_799_ZZZZ_* */
const PROVIDER_TRAVEL_PATTERN = /^\d+_799_\d+_/;

/** Activity Based Transport (NDIS catalogue) — not provider travel 799. */
const ACTIVITY_TRANSPORT_PATTERNS = [
  /^04_590_\d+_/,
  /^04_591_\d+_/,
  /^04_592_\d+_/,
  /^04_821_\d+_/,
  /^07_501_\d+_/,
  /^08_590_\d+_/,
  /^09_590_\d+_/,
  /^09_591_\d+_/,
  /^10_590_\d+_/,
  /^11_590_\d+_/,
  /^13_590_\d+_/
];

/** Participant Transport budget */
const PARTICIPANT_TRANSPORT = '02_051_0108_1_1';

/**
 * Parse registration group from support item (format XX_YYY_ZZZZ_* where ZZZZ = registration group)
 * @param {string} supportItemNumber
 * @returns {string|null}
 */
export function parseRegistrationGroup(supportItemNumber) {
  if (!supportItemNumber || typeof supportItemNumber !== 'string') return null;
  const parts = supportItemNumber.trim().split('_');
  return parts.length >= 3 ? parts[2] : null;
}

/**
 * Check if a support item is provider travel non-labour (01_799, 04_799, etc.)
 * @param {string} supportItemNumber
 * @returns {boolean}
 */
export function isProviderTravelNonLabour(supportItemNumber) {
  return supportItemNumber && PROVIDER_TRAVEL_PATTERN.test(String(supportItemNumber).trim());
}

/**
 * Check if a support item is Activity Based Transport (vs provider travel 799)
 * @param {string} supportItemNumber
 * @returns {boolean}
 */
export function isActivityBasedTransport(supportItemNumber) {
  const s = String(supportItemNumber || '').trim();
  return ACTIVITY_TRANSPORT_PATTERNS.some((re) => re.test(s));
}

/**
 * Check if a support item is participant Transport budget (02_051)
 * @param {string} supportItemNumber
 * @returns {boolean}
 */
export function isParticipantTransport(supportItemNumber) {
  return String(supportItemNumber || '').trim() === PARTICIPANT_TRANSPORT;
}

/**
 * Check if a support item is any travel-related line item
 * @param {string} supportItemNumber
 * @returns {boolean}
 */
export function isTravelLineItem(supportItemNumber) {
  return (
    isProviderTravelNonLabour(supportItemNumber) ||
    isActivityBasedTransport(supportItemNumber) ||
    isParticipantTransport(supportItemNumber)
  );
}

/**
 * Get the travel type label for a support item
 * @param {string} supportItemNumber
 * @returns {string|null} 'provider_travel' | 'activity_transport' | 'participant_transport' | null
 */
export function getTravelType(supportItemNumber) {
  if (isProviderTravelNonLabour(supportItemNumber)) return 'provider_travel';
  if (isActivityBasedTransport(supportItemNumber)) return 'activity_transport';
  if (isParticipantTransport(supportItemNumber)) return 'participant_transport';
  return null;
}

/**
 * Find the matching provider travel (01_799/04_799) line item for a primary support.
 * The travel item must have the same registration group as the primary support.
 * @param {string} primarySupportItemNumber - e.g. 01_011_0107_1_1
 * @param {Array<{id: string, support_item_number: string, registration_group_number?: string}>} ndisItems
 * @returns {{id: string, support_item_number: string, description?: string} | null}
 */
export function getMatchingProviderTravelItem(primarySupportItemNumber, ndisItems) {
  const regGroup = parseRegistrationGroup(primarySupportItemNumber);
  if (!regGroup || !ndisItems || !Array.isArray(ndisItems)) return null;

  return ndisItems.find((item) => {
    if (!isProviderTravelNonLabour(item.support_item_number)) return false;
    const itemRegGroup = item.registration_group_number || parseRegistrationGroup(item.support_item_number);
    return itemRegGroup === regGroup;
  }) || null;
}
