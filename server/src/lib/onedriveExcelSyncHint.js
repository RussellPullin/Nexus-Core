/**
 * Shared user-facing strings for OneDrive Excel pull (avoid duplicating long hints across routes/services).
 */

/** When org has no delegated token and app-only Graph credentials are not configured. */
export const ONEDRIVE_EXCEL_DELEGATED_OR_ENV_HINT =
  'Connect Microsoft OneDrive in Settings for your organisation (same account as the Progress Notes Excel file), or set on the API server: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, ONEDRIVE_ADMIN_USER_ID (Microsoft 365 sign-in email / UPN of the file owner), and optionally ONEDRIVE_EXCEL_PATH. With SHIFTER_SUPABASE_URL set, configure per-org path or sharing link in Shifter (public.organizations or profiles). See repo root .env.example and supabase/shifter-migrations.';

/** When Excel pull runs without organisation context and app-only env is incomplete. */
export const ONEDRIVE_EXCEL_APP_ONLY_REQUIRED_HINT =
  'ONEDRIVE_ADMIN_USER_ID (or ADMIN_USER_ID) is required: set the OneDrive owner’s Microsoft 365 sign-in email (UPN) in .env. Also required: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET. Optional: ONEDRIVE_EXCEL_PATH (default Progress Notes App/master progress notes.xlsx), or configure path in Shifter when SHIFTER_* env is set. See .env.example.';

/** Appended separately so API responses are not two copies of the same paragraph. */
export const ONEDRIVE_EXCEL_SHIFTER_404_FALLBACK_NOTE =
  'If the workbook is missing but shifts exist in Shifter, sync falls back to Shifter when OneDrive returns 404.';
