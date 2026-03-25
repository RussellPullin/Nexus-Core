/**
 * NDIS travel line item classification and matching (client-side).
 * Mirrors server/src/lib/travel.js for validation and suggestions.
 */

const PROVIDER_TRAVEL_PATTERN = /^\d+_799_\d+_/;
const ACTIVITY_TRANSPORT_590 = /^04_590_\d+_/;
const ACTIVITY_TRANSPORT_591 = /^04_591_\d+_/;
const PARTICIPANT_TRANSPORT = '02_051_0108_1_1';

export function parseRegistrationGroup(supportItemNumber) {
  if (!supportItemNumber || typeof supportItemNumber !== 'string') return null;
  const parts = supportItemNumber.trim().split('_');
  return parts.length >= 3 ? parts[2] : null;
}

export function isProviderTravelNonLabour(supportItemNumber) {
  return supportItemNumber && PROVIDER_TRAVEL_PATTERN.test(String(supportItemNumber).trim());
}

export function isActivityBasedTransport(supportItemNumber) {
  const s = String(supportItemNumber || '').trim();
  return ACTIVITY_TRANSPORT_590.test(s) || ACTIVITY_TRANSPORT_591.test(s);
}

export function isParticipantTransport(supportItemNumber) {
  return String(supportItemNumber || '').trim() === PARTICIPANT_TRANSPORT;
}

export function isTravelLineItem(supportItemNumber) {
  return (
    isProviderTravelNonLabour(supportItemNumber) ||
    isActivityBasedTransport(supportItemNumber) ||
    isParticipantTransport(supportItemNumber)
  );
}

export function getTravelType(supportItemNumber) {
  if (isProviderTravelNonLabour(supportItemNumber)) return 'provider_travel';
  if (isActivityBasedTransport(supportItemNumber)) return 'activity_transport';
  if (isParticipantTransport(supportItemNumber)) return 'participant_transport';
  return null;
}

/**
 * Find the matching provider travel (01_799/04_799) line item for a primary support.
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

/**
 * Get primary (non-travel) supports from line items.
 */
export function getPrimarySupports(lineItems, ndisItems) {
  if (!lineItems || !ndisItems) return [];
  return lineItems
    .map((li) => ndisItems.find((n) => n.id === li.ndis_line_item_id))
    .filter((item) => item && !isTravelLineItem(item.support_item_number));
}

/**
 * Validate: if adding provider travel, check that a matching primary support exists.
 * Returns { valid: boolean, message?: string }
 */
export function validateProviderTravel(lineItems, newTravelItem, ndisItems) {
  if (!newTravelItem || !isProviderTravelNonLabour(newTravelItem.support_item_number)) return { valid: true };
  const travelRegGroup = newTravelItem.registration_group_number || parseRegistrationGroup(newTravelItem.support_item_number);
  if (!travelRegGroup) return { valid: true };

  const primaries = getPrimarySupports(lineItems, ndisItems);
  const hasMatching = primaries.some((p) => {
    const pReg = p.registration_group_number || parseRegistrationGroup(p.support_item_number);
    return pReg === travelRegGroup;
  });

  if (!hasMatching) {
    return {
      valid: false,
      message: `Provider travel (${newTravelItem.support_item_number}) must match a primary support's registration group. Add a primary support first (e.g. Daily Personal Activities for 0107).`
    };
  }
  return { valid: true };
}
