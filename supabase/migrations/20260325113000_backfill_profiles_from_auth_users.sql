-- Backfill profiles for auth users created before the profile trigger existed.
-- Safe to run multiple times.

INSERT INTO public.profiles (id, email, org_id, role, shifter_enabled)
SELECT
  au.id,
  COALESCE(NULLIF(trim(au.email), ''), ''),
  CASE
    WHEN COALESCE(au.raw_user_meta_data ->> 'org_id', au.raw_app_meta_data ->> 'org_id')
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN COALESCE(au.raw_user_meta_data ->> 'org_id', au.raw_app_meta_data ->> 'org_id')::uuid
    ELSE NULL
  END AS org_id,
  CASE
    WHEN COALESCE(au.raw_user_meta_data ->> 'org_id', au.raw_app_meta_data ->> 'org_id')
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN 'Support Worker'
    ELSE 'Admin'
  END AS role,
  false
FROM auth.users au
LEFT JOIN public.profiles p ON p.id = au.id
WHERE p.id IS NULL;
