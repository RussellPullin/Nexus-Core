-- Fix drifted public.organizations (missing columns) and avoid PostgREST PATCH quirks (stale schema cache / column errors).
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS shifter_organization_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_shifter_organization_id_key
  ON public.organizations (shifter_organization_id)
  WHERE shifter_organization_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.set_org_shifter_link(
  p_org_id uuid,
  p_shifter_organization_id uuid
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.organizations
  SET shifter_organization_id = p_shifter_organization_id
  WHERE id = p_org_id;
$$;

COMMENT ON FUNCTION public.set_org_shifter_link(uuid, uuid) IS
  'Sets organizations.shifter_organization_id; invoked with service role from Nexus Core API.';

REVOKE ALL ON FUNCTION public.set_org_shifter_link(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_org_shifter_link(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
