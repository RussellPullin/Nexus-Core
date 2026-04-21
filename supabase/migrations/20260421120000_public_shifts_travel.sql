-- Add travel fields to NexusCore Supabase public.shifts so downstream systems
-- (e.g. Shifter) can bill correctly when travel is recorded in progress notes.

ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS travel_km double precision,
  ADD COLUMN IF NOT EXISTS travel_time_minutes integer;

