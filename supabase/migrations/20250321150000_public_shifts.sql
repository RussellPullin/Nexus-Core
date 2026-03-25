-- NexusCore Supabase: public.shifts (Nexus-side rows for Shifter webhooks / sync).
-- Must run before 20250322100000_shift_cancellation_sync.sql (ALTER TABLE public.shifts).
--
-- Shifter uses a separate shifts table (e.g. with nexuscore_shift_id); create that in the Shifter project.
-- This matches SQLite shifts in database/schema.sql and edge functions:
-- push-shift-to-shifter, sync-cancellation, sync-completed-shift.

CREATE TABLE IF NOT EXISTS public.shifts (
  id text PRIMARY KEY,
  participant_id text,
  staff_id text,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  start_time timestamptz,
  end_time timestamptz,
  actual_start timestamptz,
  actual_end timestamptz,
  client text,
  client_name text,
  client_id text,
  org text,
  org_id uuid REFERENCES public.organizations (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'scheduled',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shifts_staff_id_idx ON public.shifts (staff_id);
CREATE INDEX IF NOT EXISTS shifts_status_idx ON public.shifts (status);
CREATE INDEX IF NOT EXISTS shifts_org_id_idx ON public.shifts (org_id);

COMMENT ON TABLE public.shifts IS
  'NexusCore shifts (Postgres); IDs align with SQLite shifts.id for cross-system sync.';
