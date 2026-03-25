/**
 * Canonical feature keys for org_features (Supabase). Add keys here as you gate UI and APIs.
 * Labels are optional; used in the super-admin matrix UI.
 */
export const FEATURE_FLAG_KEYS = [
  { key: 'shifter_beta', label: 'Shifter (beta flows)' },
  { key: 'advanced_reporting', label: 'Advanced reporting' },
  { key: 'beta_invoicing', label: 'Beta invoicing' }
];

export function listFeatureFlagKeys() {
  return FEATURE_FLAG_KEYS.map((x) => x.key);
}

export function isKnownFeatureKey(key) {
  return listFeatureFlagKeys().includes(String(key || ''));
}
