/**
 * Neutral wording for Nexus-provided templates (no third-party org names).
 * Org-uploaded custom forms keep their own branding.
 */

const GENERIC_PROVIDER = 'The service provider';

/**
 * @param {{ tradingName?: string, trading_name?: string, legalName?: string, legal_name?: string, name?: string } | null | undefined} org
 */
export function providerDisplayName(org) {
  const trading = String(org?.tradingName || org?.trading_name || org?.name || '').trim();
  if (trading) return trading;
  const legal = String(org?.legalName || org?.legal_name || '').trim();
  if (legal) return legal;
  return GENERIC_PROVIDER;
}

/**
 * @param {{ tradingName?: string, trading_name?: string, legalName?: string, legal_name?: string } | null | undefined} org
 */
export function providerLegalPhrase(org) {
  const trading = String(org?.tradingName || org?.trading_name || '').trim();
  const legal = String(org?.legalName || org?.legal_name || '').trim();
  if (legal && trading && legal.toLowerCase() !== trading.toLowerCase()) {
    return `${legal} (${trading})`;
  }
  return providerDisplayName(org);
}

export function privacyPolicyPhrase(org) {
  const name = providerLegalPhrase(org);
  return `${name} Privacy and Dignity Policy`;
}
