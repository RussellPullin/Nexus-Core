-- Ensure a public.profiles row exists for every auth.users row, and copy invite org_id from raw_user_meta_data.
-- Requires public.profiles (id uuid PK = auth.users.id), email, org_id, role, shifter_enabled per prior migrations.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  meta_org text;
  org_uuid uuid;
  profile_role text;
BEGIN
  meta_org := COALESCE(
    NEW.raw_user_meta_data ->> 'org_id',
    NEW.raw_app_meta_data ->> 'org_id'
  );
  org_uuid := NULL;
  IF meta_org IS NOT NULL
     AND meta_org ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    BEGIN
      org_uuid := meta_org::uuid;
    EXCEPTION
      WHEN OTHERS THEN
        org_uuid := NULL;
    END;
  END IF;

  profile_role := CASE
    WHEN org_uuid IS NOT NULL THEN 'Support Worker'
    ELSE 'Admin'
  END;

  INSERT INTO public.profiles (id, email, org_id, role, shifter_enabled)
  VALUES (
    NEW.id,
    COALESCE(NULLIF(trim(NEW.email), ''), ''),
    org_uuid,
    profile_role,
    false
  )
  ON CONFLICT (id) DO UPDATE SET
    email = COALESCE(NULLIF(EXCLUDED.email, ''), profiles.email),
    org_id = COALESCE(EXCLUDED.org_id, profiles.org_id),
    role = CASE
      WHEN EXCLUDED.org_id IS NOT NULL AND profiles.org_id IS NULL THEN EXCLUDED.role
      ELSE profiles.role
    END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE PROCEDURE public.handle_new_user();

COMMENT ON FUNCTION public.handle_new_user() IS
  'NexusCore: seed profiles; invited users get org_id + Support Worker; self-signup gets Admin until org is created in-app.';
