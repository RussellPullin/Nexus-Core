/**
 * When true, participant onboarding “Sign with Nexus Core” uses the server send-for-signature (Adobe) flow.
 * Set in client/.env: VITE_NEXUS_CORE_ADOBE_SIGN_ENABLED=true
 */
export const NEXUS_CORE_ADOBE_SIGN_ENABLED = import.meta.env.VITE_NEXUS_CORE_ADOBE_SIGN_ENABLED === 'true';

export const NEXUS_CORE_SIGN_COMING_SOON_TITLE =
  'Nexus Core e-sign via Adobe is being finalised. Download the document to sign offline or with your own tools for now.';
