-- NexusCore: shifter_enabled + role as text with allowed labels.
-- PostgreSQL blocks ALTER COLUMN ... TYPE on profiles.role while any RLS policy
-- expression still depends on that column. Drop those policies first, then recreate
-- them here (or paste your originals with enum casts removed and text literals updated).
--
-- Find other policies that reference profiles / role (add matching DROP POLICY lines
-- above the ALTER if this migration still fails):
--   SELECT c.relname AS table_name,
--          p.polname,
--          pg_get_expr(p.polqual, p.polrelid) AS using_expr,
--          pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr
--   FROM pg_policy p
--   JOIN pg_class c ON c.oid = p.polrelid
--   JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'public'
--     AND (
--       coalesce(pg_get_expr(p.polqual, p.polrelid), '') ILIKE '%profiles%'
--       AND coalesce(pg_get_expr(p.polqual, p.polrelid), '') ILIKE '%role%'
--       OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ILIKE '%profiles%'
--       AND coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ILIKE '%role%'
--     );
--
-- Discover enum labels (adjust CASE map in step 4 if needed):
--   SELECT enumlabel FROM pg_enum e
--   JOIN pg_type t ON t.oid = e.enumtypid
--   WHERE t.typname = 'user_role' ORDER BY enumsortorder;

-- ---------------------------------------------------------------------------
-- 1) shifter_enabled (idempotent)
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS shifter_enabled boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2) role — add as text only when the column does not exist yet
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'profiles'
      AND c.column_name = 'role'
  ) THEN
    ALTER TABLE public.profiles ADD COLUMN role text;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Drop RLS policies that depend on profiles.role (required before ALTER TYPE)
--    Add more DROP POLICY lines here if the query above lists additional policies.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can do all on app_shifts" ON public.app_shifts;

-- ---------------------------------------------------------------------------
-- 4) If role is still enum user_role, convert to text and map to display labels
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'profiles'
      AND c.column_name = 'role'
      AND c.udt_name = 'user_role'
  ) THEN
    ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
    ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_allowed;

    ALTER TABLE public.profiles
      ALTER COLUMN role TYPE text
      USING (
        CASE role::text
          WHEN 'support_worker' THEN 'Support Worker'
          WHEN 'team_leader' THEN 'Team Leader'
          WHEN 'coordinator' THEN 'Coordinator'
          WHEN 'admin' THEN 'Admin'
          WHEN 'manager' THEN 'Manager'
          WHEN 'Support Worker' THEN 'Support Worker'
          WHEN 'Team Leader' THEN 'Team Leader'
          WHEN 'Coordinator' THEN 'Coordinator'
          WHEN 'Admin' THEN 'Admin'
          WHEN 'Manager' THEN 'Manager'
          ELSE role::text
        END
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5) Text CHECK + normalize values outside allow-list
--    profiles.role is NOT NULL in your schema: never assign NULL here.
--    Change the default below if another label fits legacy users better.
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_allowed;

UPDATE public.profiles
SET role = 'Support Worker'
WHERE role IS NULL
   OR role NOT IN (
    'Support Worker',
    'Team Leader',
    'Coordinator',
    'Admin',
    'Manager'
  );

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_allowed CHECK (
    role IN (
      'Support Worker',
      'Team Leader',
      'Coordinator',
      'Admin',
      'Manager'
    )
  );

COMMENT ON COLUMN public.profiles.shifter_enabled IS 'When true, user is included in shifter workflows.';
COMMENT ON COLUMN public.profiles.role IS 'Staff role; one of the five allowed labels (NOT NULL).';

-- ---------------------------------------------------------------------------
-- 6) Recreate policies dropped in step 3 (edit TO / expressions to match your app)
--    Typical change: profiles.role = 'admin'::user_role  →  profiles.role = 'Admin'
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can do all on app_shifts" ON public.app_shifts;

CREATE POLICY "Admins can do all on app_shifts"
ON public.app_shifts
AS PERMISSIVE
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE profiles.id = auth.uid()
      AND profiles.role = 'Admin'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE profiles.id = auth.uid()
      AND profiles.role = 'Admin'
  )
);

-- Optional: DROP TYPE IF EXISTS public.user_role;  -- only after confirming no column uses it
