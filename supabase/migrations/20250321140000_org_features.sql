-- org_features: per-organisation feature flags for NexusCore / Shifter / etc.
-- FK targets public.organizations (see 20250321100000_organizations_profiles_org_shifter.sql).
-- If your tenant table is only public.organisations, point the FK below to that table instead.
--
-- RLS: authenticated users only see rows for their own org (profiles.org_id). Adjust the
-- policy if you link users to orgs differently. service_role bypasses RLS for admin tooling.

CREATE TABLE IF NOT EXISTS public.org_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_features_org_id_feature_key_unique UNIQUE (org_id, feature_key)
);

CREATE INDEX IF NOT EXISTS org_features_org_id_idx ON public.org_features (org_id);

COMMENT ON TABLE public.org_features IS 'Feature flags per organisation.';
COMMENT ON COLUMN public.org_features.feature_key IS 'Stable key, e.g. shifter, reporting, invoicing.';

ALTER TABLE public.org_features ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_features_select_same_org ON public.org_features;

CREATE POLICY org_features_select_same_org
  ON public.org_features
  FOR SELECT
  TO authenticated
  USING (
    org_id = (
      SELECT p.org_id
      FROM public.profiles p
      WHERE p.id = auth.uid()
    )
  );

-- Server-side admin: use service_role (bypasses RLS) for writes.
-- Optional: add INSERT/UPDATE policies for org admins if you manage flags from the client.

-- Returns true only when a row exists and enabled = true; missing or RLS-hidden row => false.
CREATE OR REPLACE FUNCTION public.is_org_feature_enabled (
  p_org_id uuid,
  p_feature_key text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT f.enabled
      FROM public.org_features f
      WHERE f.org_id = p_org_id
        AND f.feature_key = p_feature_key
    ),
    false
  );
$$;

COMMENT ON FUNCTION public.is_org_feature_enabled (uuid, text) IS
  'Feature flag lookup (respects RLS). Missing row or other org => false.';

GRANT SELECT ON public.org_features TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_org_feature_enabled (uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_org_feature_enabled (uuid, text) TO service_role;
