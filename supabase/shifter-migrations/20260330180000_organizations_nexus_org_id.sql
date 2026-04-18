/*
  Shifter Supabase project only. Nexus "Link to Shifter" writes this so the worker knows which Nexus org each row is.
  Progress / Schedule Shift should POST: { "org_id": "<this uuid>", "shifts": [ ... ] } using the deployment-wide CRM_API_KEY.
*/

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS nexus_org_id uuid;

COMMENT ON COLUMN public.organizations.nexus_org_id IS
  'Nexus Core public.organizations.id. Same CRM_API_KEY for all orgs on one Nexus host; org_id in JSON scopes shifts.';
