-- NexusCore Supabase: canonical org rows + profile membership.
-- Must run before 20250321140000_org_features.sql (FK to organizations).
--
-- Align with Shifter by using the SAME uuid for public.organizations.id in both projects,
-- or set shifter_organization_id to Shifter's organizations.id when they differ.

CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.organizations IS
  'NexusCore tenant. Match Shifter: use the same id in both Supabase projects, or set shifter_organization_id.';

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS shifter_organization_id uuid;

COMMENT ON COLUMN public.organizations.shifter_organization_id IS
  'Optional. public.organizations.id from the Shifter Supabase project when it differs from this row id; NULL means ids are intended to match.';

CREATE UNIQUE INDEX IF NOT EXISTS organizations_shifter_organization_id_key
  ON public.organizations (shifter_organization_id)
  WHERE shifter_organization_id IS NOT NULL;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS org_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'profiles_org_id_fkey'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES public.organizations (id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS profiles_org_id_idx ON public.profiles (org_id);

COMMENT ON COLUMN public.profiles.org_id IS
  'Organisation for RLS (e.g. org_features) and alignment with Nexus SQLite users.org_id / Shifter org.';
