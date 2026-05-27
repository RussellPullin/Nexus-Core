/**
 * Dropbox Sign feature flag.
 *
 * Per-org runtime flag stored in provider_profiles.config_json.dropbox_sign_enabled
 * and surfaced via GET /api/onboarding/providers/:orgId/settings.
 *
 * The legacy VITE_NEXUS_CORE_DROPBOX_SIGN_ENABLED env var still acts as a global
 * fallback for development so existing .env files keep working.
 */
import { useEffect, useState } from 'react';
import { onboarding } from './api';
import { useAuth } from '../context/AuthContext';

export const NEXUS_CORE_DROPBOX_SIGN_ENV_FALLBACK =
  import.meta.env.VITE_NEXUS_CORE_DROPBOX_SIGN_ENABLED === 'true';

export const NEXUS_CORE_SIGN_COMING_SOON_TITLE =
  'Sign with Nexus Core is not enabled for this organisation. Ask an admin to turn it on under Forms → Onboarding settings (requires Dropbox Sign connected in Settings → Integrations).';

let cachedDropboxSignEnabled = NEXUS_CORE_DROPBOX_SIGN_ENV_FALLBACK;
let inflightOrgId = null;

/**
 * React hook returning whether Sign with Nexus Core is enabled for the current org.
 * Caches the result in module scope so multiple components share one fetch per session.
 *
 * Falls back to the legacy VITE_NEXUS_CORE_DROPBOX_SIGN_ENABLED flag if the API is unavailable.
 */
export function useDropboxSignEnabled() {
  const { user } = useAuth();
  const orgId = user?.org_id || null;
  const [enabled, setEnabled] = useState(cachedDropboxSignEnabled);

  useEffect(() => {
    if (!orgId) {
      setEnabled(NEXUS_CORE_DROPBOX_SIGN_ENV_FALLBACK);
      return undefined;
    }
    let cancelled = false;
    if (inflightOrgId === orgId) return undefined;
    inflightOrgId = orgId;
    onboarding
      .getProviderSettings(orgId)
      .then((data) => {
        if (cancelled) return;
        const next = Boolean(data?.config?.dropbox_sign_enabled) || NEXUS_CORE_DROPBOX_SIGN_ENV_FALLBACK;
        cachedDropboxSignEnabled = next;
        setEnabled(next);
      })
      .catch(() => {
        if (cancelled) return;
        setEnabled(NEXUS_CORE_DROPBOX_SIGN_ENV_FALLBACK);
      })
      .finally(() => {
        if (inflightOrgId === orgId) inflightOrgId = null;
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  return enabled;
}
