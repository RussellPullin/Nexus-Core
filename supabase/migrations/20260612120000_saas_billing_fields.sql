-- SaaS billing fields for Nexus Core organisations.
-- Tracks subscription status, trial, Xero contact/invoice, and peak user counts.

-- 1. Billing columns on organizations
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trialing';
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ DEFAULT (now() + interval '14 days');
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS billing_anchor_date TIMESTAMPTZ;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS billing_email TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_subscription_status_check'
  ) THEN
    ALTER TABLE public.organizations ADD CONSTRAINT organizations_subscription_status_check
      CHECK (subscription_status IN ('trialing', 'active', 'past_due', 'cancelled'));
  END IF;
END $$;

-- Backfill trial_ends_at for existing orgs
UPDATE public.organizations
SET trial_ends_at = COALESCE(created_at, now()) + interval '14 days'
WHERE trial_ends_at IS NULL;

COMMENT ON COLUMN public.organizations.subscription_status IS 'trialing | active | past_due | cancelled';
COMMENT ON COLUMN public.organizations.trial_ends_at IS '14-day free trial from org creation';
COMMENT ON COLUMN public.organizations.billing_anchor_date IS 'Set to trial_ends_at when first invoice created; never changes';
COMMENT ON COLUMN public.organizations.subscription_expires_at IS 'Next billing due date';
COMMENT ON COLUMN public.organizations.locked_at IS 'When org was locked due to overdue/cancellation';
COMMENT ON COLUMN public.organizations.billing_email IS 'Where invoices are emailed for this org';

-- 2. Peak user count per billing period
CREATE TABLE IF NOT EXISTS public.org_user_peak_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  billing_period_start TIMESTAMPTZ NOT NULL,
  billing_period_end TIMESTAMPTZ NOT NULL,
  peak_user_count INTEGER NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (org_id, billing_period_start)
);

CREATE INDEX IF NOT EXISTS idx_nc_org_user_peak_org_id ON public.org_user_peak_counts(org_id);
CREATE INDEX IF NOT EXISTS idx_nc_org_user_peak_period ON public.org_user_peak_counts(org_id, billing_period_start, billing_period_end);

-- RLS: only service role
ALTER TABLE public.org_user_peak_counts ENABLE ROW LEVEL SECURITY;
