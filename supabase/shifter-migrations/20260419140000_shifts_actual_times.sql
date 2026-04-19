-- Shifter Supabase only. Worker UI often shows actual_start/actual_end for completed shifts.
-- Safe if columns already exist.

ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS actual_start timestamptz;

ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS actual_end timestamptz;

COMMENT ON COLUMN public.shifts.actual_start IS 'Mirrored from Nexus public.shifts when status is completed.';
COMMENT ON COLUMN public.shifts.actual_end IS 'Mirrored from Nexus public.shifts when status is completed.';
