-- Run this migration on the Shifter Supabase project only (not the Nexus Core Supabase project).
-- Nexus Core reads these columns when pulling shifts from OneDrive (Sync from Excel).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS progress_notes_onedrive_path text,
  ADD COLUMN IF NOT EXISTS progress_notes_folder text,
  ADD COLUMN IF NOT EXISTS progress_notes_filename text;

COMMENT ON COLUMN public.profiles.progress_notes_onedrive_path IS
  'Full path from OneDrive root to the Progress Notes / shifts workbook, e.g. Progress Notes App/master progress notes.xlsx. When set, overrides folder + filename.';

COMMENT ON COLUMN public.profiles.progress_notes_folder IS
  'Folder path under OneDrive root (no leading/trailing slash), used with progress_notes_filename when progress_notes_onedrive_path is null.';

COMMENT ON COLUMN public.profiles.progress_notes_filename IS
  'Workbook file name; combined with progress_notes_folder when progress_notes_onedrive_path is null.';

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS progress_notes_onedrive_sharing_url text;

COMMENT ON COLUMN public.profiles.progress_notes_onedrive_sharing_url IS
  'Optional Microsoft "Copy link" URL to the workbook; Nexus can open the file via Graph shares API when path-based lookup fails.';

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS progress_notes_onedrive_path text,
  ADD COLUMN IF NOT EXISTS progress_notes_folder text,
  ADD COLUMN IF NOT EXISTS progress_notes_filename text,
  ADD COLUMN IF NOT EXISTS progress_notes_onedrive_sharing_url text;

COMMENT ON COLUMN public.organizations.progress_notes_onedrive_path IS
  'Per-org default path to the Progress Notes workbook under the connected OneDrive (same as profiles columns).';

COMMENT ON COLUMN public.organizations.progress_notes_onedrive_sharing_url IS
  'Per-org sharing link to the workbook (optional alternative to path).';
