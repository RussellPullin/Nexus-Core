# RESUME_PROMPT

> **STATUS (2026-07-08): remediation COMPLETE.** All 102 documents reviewed — render OK,
> logo-ok, body-reviewed, packs verified. `PROGRESS.md` shows `NEXT: DONE`. There is nothing
> left to resume. This prompt is retained only so a future agent can re-run the loop if a
> regression is introduced (STEP 1 will re-detect any newly-broken doc). A few non-blocking
> items were flagged for optional human review — see the `FLAG:` notes in the PROGRESS.md table.

Copy everything inside the fenced block below into a brand-new agent to continue the
NDIS document-library remediation. It is self-contained and assumes zero prior memory.

```text
You are resuming a long, multi-session task: remediating the NDIS document library in
/Users/pristinelifestylesolutions/nexus-core. Do NOT trust any memory or chat history —
all state lives on disk. Follow this exactly.

STEP 0 — Load state
1. Open and fully read: nexus-core/docs/doc-library-remediation/PROGRESS.md
2. Read its "Architecture / pipeline summary" section so you do NOT re-explore the codebase.
3. Read nexus-core/docs/doc-library-remediation/README.md for the workflow rule.

STEP 1 — Refresh ground-truth status
4. Regenerate the diagnostic report:
      cd /Users/pristinelifestylesolutions/nexus-core/server
      node scripts/diagnose-library.mjs
   This writes server/scripts/diagnostics/library-report.json (JSON array; one object per
   slug with: slug, ok, stage, error, hasLogoTag, pdfPages, mode, pack, ...).
   Do NOT modify diagnose-library.mjs or any template.docx / manifest.json / render service
   as part of this refresh step.
5. Reconcile the report against the checklist table in PROGRESS.md following the
   "Reconciliation rule" section: mark failing docs as `broken` (record stage + error in
   notes); leave passing-but-unreviewed docs as-is until a human/you reviews logo + body.

STEP 2 — Find where to work
6. Read the "NEXT:" pointer in PROGRESS.md. If it says "DONE", stop and report completion.
   Otherwise work the first document whose `render status` is `todo` or `broken`
   (top-to-bottom in the table).

STEP 3 — Per-document fix loop (keep it small + idempotent)
   For the current slug (folder: server/templates/library/<slug>/):
   a. Look at its entry in library-report.json to see why it fails (if it fails).
   b. Fix the template.docx so it renders cleanly (common cause: malformed/split
      docxtemplater tags or stray { / } characters in the Word XML). Preserve the
      {%org_logo} header tag and the {token} placeholders. A template.docx.prebrand
      backup exists if you need to compare.
   c. Re-run: node scripts/diagnose-library.mjs <slug>   and confirm ok:true / mode:"pdf".
   d. Verify the logo header does not cover the body text (check page 1 of the rendered PDF).
   e. Verify the body is the correct document (right title/sections, no stray tags).
   f. Verify manifest.json "pack" is correct:
      policy_library | compliance_register | staff_onboarding | participant_onboarding.
      (staff_onboarding + participant_onboarding auto-attach to onboarding emails via
      server/src/services/onboardingDocumentPacks.service.js — get it right.)
   g. Save changes back into server/templates/library/<slug>/.

STEP 4 — Checkpoint (CRITICAL — do this after EVERY document, before the next one)
   h. Update PROGRESS.md for this slug's row: set `render status` (ok/fixed/broken),
      `logo-ok` (yes/no), `body-reviewed` (yes/no), and any `notes`.
   i. Move the "NEXT:" pointer to the next unfinished slug.
   j. Add a one-line entry to the "Session changelog" section.
   k. Commit: git add -A && git commit -m "doc-library: <slug> (<status>)"
   Never advance to the next document until PROGRESS.md is updated and committed.
   This is what makes context loss safe.

STEP 5 — Context-limit safety
   If you feel you are approaching your context limit, or before ending your session:
   - Make sure PROGRESS.md is fully updated + committed.
   - Regenerate a fresh copy of this resume prompt at
     nexus-core/docs/doc-library-remediation/RESUME_PROMPT.md if anything about the
     workflow, paths, or harness has changed, so the next agent inherits accurate steps.
   - Then stop and report the current NEXT: pointer.

Repeat STEP 2 → STEP 4 until PROGRESS.md shows NEXT: DONE.
```
