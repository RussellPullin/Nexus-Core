-- NexusCore (this repo / primary Supabase): billing + cancellation sync fields.
-- Requires public.shifts from 20250321150000_public_shifts.sql (run migrations in order).
-- Apply the "Shifter" section separately on the Shifter Supabase project.

-- ---------------------------------------------------------------------------
-- NexusCore: public.shifts (cancellation + billing columns)
-- ---------------------------------------------------------------------------
ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS billing_action text,
  ADD COLUMN IF NOT EXISTS cancellation_escalate boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_synced_from text;

COMMENT ON COLUMN public.shifts.billing_action IS 'none | cancellation_fee | review';
COMMENT ON COLUMN public.shifts.cancellation_synced_from IS 'shifter | nexuscore when last cancellation was written by cross-app sync';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'shifts_billing_action_check'
  ) THEN
    ALTER TABLE public.shifts
      ADD CONSTRAINT shifts_billing_action_check
      CHECK (
        billing_action IS NULL
        OR billing_action IN ('none', 'cancellation_fee', 'review')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'shifts_cancellation_synced_from_check'
  ) THEN
    ALTER TABLE public.shifts
      ADD CONSTRAINT shifts_cancellation_synced_from_check
      CHECK (
        cancellation_synced_from IS NULL
        OR cancellation_synced_from IN ('shifter', 'nexuscore')
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- NexusCore: draft invoice lines for cancellation fees (sync-cancellation fn)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.draft_invoice_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id text NOT NULL,
  line_type text NOT NULL DEFAULT 'cancellation_fee',
  description text NOT NULL,
  quantity numeric NOT NULL DEFAULT 1,
  unit_amount numeric NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_draft_invoice_line_items_shift
  ON public.draft_invoice_line_items (shift_id);

CREATE INDEX IF NOT EXISTS idx_draft_invoice_line_items_type_status
  ON public.draft_invoice_line_items (line_type, status);

COMMENT ON TABLE public.draft_invoice_line_items IS 'Draft lines (e.g. short-notice cancellation fee) before batch billing';

-- ---------------------------------------------------------------------------
-- Shifter project (run this block only on Shifter Supabase SQL editor / migration)
-- ---------------------------------------------------------------------------
-- ALTER TABLE public.shifts
--   ADD COLUMN IF NOT EXISTS cancellation_reason text,
--   ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
--   ADD COLUMN IF NOT EXISTS cancellation_synced_from text;
--
-- DO $$
-- BEGIN
--   IF NOT EXISTS (
--     SELECT 1 FROM pg_constraint WHERE conname = 'shifter_shifts_cancellation_synced_from_check'
--   ) THEN
--     ALTER TABLE public.shifts
--       ADD CONSTRAINT shifter_shifts_cancellation_synced_from_check
--       CHECK (
--         cancellation_synced_from IS NULL
--         OR cancellation_synced_from IN ('shifter', 'nexuscore')
--       );
--   END IF;
-- END $$;
