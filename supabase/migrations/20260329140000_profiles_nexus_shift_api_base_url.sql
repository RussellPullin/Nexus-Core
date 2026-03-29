-- Public API origin for shift webhook + Excel sync URLs (shown in Settings).
-- Set on an Org Admin profile row in Supabase (Table editor → profiles → your admin user by email).
-- Example value: https://nexus-core-crm.fly.dev (no trailing slash).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS nexus_shift_api_base_url text;

COMMENT ON COLUMN public.profiles.nexus_shift_api_base_url IS
  'Optional. When set on an Admin profile for the org, Settings uses this origin for shift webhook/sync URLs. Overrides server env fallbacks.';
