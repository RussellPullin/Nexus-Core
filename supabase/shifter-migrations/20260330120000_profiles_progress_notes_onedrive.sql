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
