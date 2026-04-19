-- Shifter Supabase project only. Optional reference migration if the column was added manually.
-- Nexus reads IANA ids from the first existing column among: timezone, time_zone, iana_timezone.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS timezone text;

COMMENT ON COLUMN public.organizations.timezone IS
  'IANA timezone for interpreting naive shift times from Nexus (e.g. Australia/Sydney).';
