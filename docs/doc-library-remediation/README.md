# Doc Library Remediation — Checkpoint / Handoff System

This folder lets one very long task (remediating the 102-document NDIS library) survive
across many fresh agent sessions **without relying on any agent's memory**. All state is
on disk, so any agent — or human — can pick up exactly where the last one stopped.

## Files

- **`PROGRESS.md`** — the single source of truth. Task statement + definition of done,
  the architecture/pipeline summary (so nobody re-explores), a checklist table of all 102
  slugs with per-document status, a `NEXT:` pointer, and a session changelog.
- **`RESUME_PROMPT.md`** — a copy-paste prompt to drop into a brand-new agent to continue.
- **`README.md`** — this file.

## How the checkpoint system works

1. **Ground truth for rendering** = the diagnostic report at
   `server/scripts/diagnostics/library-report.json`, produced by
   `server/scripts/diagnose-library.mjs`. It renders every master through the real
   production pipeline (docxtemplater + logo image module + LibreOffice → PDF).
2. **Ground truth for review + intent** = `PROGRESS.md`. The report can tell you *whether
   a doc renders*, but only a reviewer records whether the logo overlaps the body, whether
   the body is correct, and whether the `pack` is right.
3. A resuming agent **regenerates the report**, reconciles it into `PROGRESS.md`, reads the
   `NEXT:` pointer, and works the first unfinished document.

## The one workflow rule

> **Update `PROGRESS.md` after every document before moving on** — set the row's status,
> move the `NEXT:` pointer, add a changelog line, and commit. Never start the next document
> until the current one is checkpointed. This is what makes context loss safe.

Keep the per-document loop **small and idempotent**: fix one doc, verify it via the harness,
check logo + body + pack, save, checkpoint, commit, then move on.

## Regenerating the diagnostic report

```bash
cd /Users/pristinelifestylesolutions/nexus-core/server
node scripts/diagnose-library.mjs                 # all 102
node scripts/diagnose-library.mjs <slug> [slug…]  # specific docs
```

## Guardrails

- Do **not** modify the diagnostic harness (`diagnose-library.mjs`) or the render service —
  they define ground truth.
- Only change `template.docx` / `manifest.json` under `server/templates/library/<slug>/`
  as part of the actual remediation work (that is the long task, not the handoff setup).
- If `library-report.json` is missing, generate it before trusting any render status.
