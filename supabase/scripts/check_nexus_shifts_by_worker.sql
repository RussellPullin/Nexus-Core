-- Check Nexus Supabase (this project) shifts for a worker — run in the Supabase SQL Editor.
--
-- How to use:
--   1) Edit the email pattern (and optional org) in section 1 (profiles) and in cfg in sections 2–3.
--   2) Run section 1, then 2, then 3; or only 2+3 with matching cfg.
--
-- Permissions: RLS may hide data for restricted roles. Use the SQL Editor as a project
-- admin, or a service_role connection, if you get empty results unexpectedly.
--
-- Note: The external Shifter/Excel "shiftId" (SQLite `shifts.shifter_shift_id`) is not
-- in the default Nexus `public.shifts` migrations. Section 0 lists your actual columns;
-- if `shifter_shift_id` (or similar) is absent here, use Nexus Core’s SQLite/backup
-- to confirm import linkage for that id.

-- ═══ 0) Optional: columns on public.shifts in this database ═══
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'shifts'
-- ORDER BY ordinal_position;

-- ═══ 1) Find profile (worker) and org (edit the ILIKE pattern) ═══
SELECT
  p.id   AS profile_id,
  p.email,
  p.org_id,
  p.role,
  p.shifter_enabled,
  o.name AS org_name
FROM public.profiles p
LEFT JOIN public.organizations o ON o.id = p.org_id
WHERE p.email IS NOT NULL
  AND p.email ILIKE '%shane%hayes%';

-- ═══ 2) Shifts for worker (param via CTE — edit literals in cfg) ═══
WITH cfg AS (
  SELECT
    '%shane%hayes%'::text AS email_pattern,
    NULL::uuid            AS only_org_id  -- e.g. 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid
),
prof AS (
  SELECT p.id AS profile_id, p.email, p.org_id, p.shifter_enabled
  FROM public.profiles p, cfg
  WHERE p.email IS NOT NULL
    AND p.email ILIKE cfg.email_pattern
)
SELECT
  s.id,
  s.staff_id,
  prof.email AS staff_email,
  s.org_id,
  o.name AS org_name,
  s.status,
  s.scheduled_start,
  s.scheduled_end,
  s.start_time,
  s.end_time,
  s.actual_start,
  s.actual_end,
  s.client_name,
  s.notes,
  s.updated_at
FROM public.shifts s
JOIN prof ON prof.profile_id = s.staff_id
LEFT JOIN public.organizations o ON o.id = s.org_id
CROSS JOIN cfg
WHERE (cfg.only_org_id IS NULL OR s.org_id = cfg.only_org_id)
ORDER BY COALESCE(s.start_time, s.scheduled_start, s.created_at) DESC
LIMIT 100;

-- ═══ 3) Status summary for the same email pattern and org filter ═══
WITH cfg AS (
  SELECT
    '%shane%hayes%'::text AS email_pattern,
    NULL::uuid            AS only_org_id
),
prof AS (
  SELECT p.id AS profile_id, p.email
  FROM public.profiles p, cfg
  WHERE p.email IS NOT NULL
    AND p.email ILIKE cfg.email_pattern
)
SELECT
  s.status,
  COUNT(*) AS n
FROM public.shifts s
JOIN prof ON prof.profile_id = s.staff_id
CROSS JOIN cfg
WHERE (cfg.only_org_id IS NULL OR s.org_id = cfg.only_org_id)
GROUP BY s.status
ORDER BY s.status;
