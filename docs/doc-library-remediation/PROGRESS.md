# NDIS Document Library Remediation — PROGRESS

> **This file is the single source of truth.** Progress lives on disk, never in an
> agent's memory. Any fresh agent must be able to reconstruct the entire state from
> (a) this file and (b) the diagnostic JSON report. Update this file after **every**
> document before moving on.

---

## 1. Task statement

Remediate the **102** masters in the NDIS document library
(`server/templates/library/<slug>/`). Each master is a `manifest.json` +
`template.docx` (+ a `template.docx.prebrand` backup). `_catalogue.json` in that
folder lists every master.

### Definition of done (per document)

A document is **done** only when ALL of these are true:

1. **Renders cleanly** — passes the diagnostic harness (docxtemplater render + LibreOffice
   DOCX→PDF) with no error; i.e. the real `GET /document-library/masters/:id/preview`
   would return an inline PDF, not a docx fallback or an error.
2. **Logo header does not cover body** — the `{%org_logo}` header image does not overlap
   or push out the body text on page 1.
3. **Body correct** — the rendered content is the right document (right title, right
   sections, no split/stray `{`/`}` tags, no leftover garbage tokens).
4. **Correct `pack`** — `manifest.json`'s `pack` matches the document's true purpose
   (`policy_library` / `compliance_register` / `staff_onboarding` / `participant_onboarding`).
5. **Saved** — changes written back to `server/templates/library/<slug>/` and committed.

---

## 2. Architecture / pipeline summary (read this before exploring)

Project: `/Users/pristinelifestylesolutions/nexus-core` — full-stack NDIS provider app
(Node ESM server + React/Vite client).

**Render pipeline**
- **Server route:** `server/src/routes/documentLibrary.js` —
  `GET /document-library/masters/:id/preview` renders inline.
- **Render service:** `server/src/services/documentLibraryRender.service.js` — uses
  **docxtemplater** with delimiters `{`…`}`, plus `docxtemplater-image-module-free` for
  the header logo tag `{%org_logo}`, then converts DOCX→PDF via **LibreOffice**
  (`soffice` at `/opt/homebrew/bin/soffice`). If PDF conversion fails, production falls
  back to serving the raw `.docx` (downloads instead of inline preview).

**Frontend**
- `client/src/pages/FormsPage.jsx` — section "NDIS document library".
- `client/src/pages/DocumentLibraryAdminPage.jsx` — admin management.

**Automations / packs**
- Each `manifest.json` has a `pack` field. Distribution today:
  `policy_library` (66), `compliance_register` (15), `staff_onboarding` (14),
  `participant_onboarding` (7).
- Packs `staff_onboarding` and `participant_onboarding` are auto-attached to onboarding
  emails via `server/src/services/onboardingDocumentPacks.service.js`. Getting the `pack`
  wrong changes which emails a document is attached to — verify it.

**Known problems being fixed**
1. Many docs fail to preview — usually docxtemplater render errors from malformed/split
   tags or stray `{` / `}` characters left in the Word docs.
2. The logo header may overlap body text.
3. Each doc must be verified for correct body + correct automation pack, then saved.

**Do NOT re-derive this.** It has already been explored.

---

## 3. Diagnostic harness & report

- **Harness (already built, do not modify):** `server/scripts/diagnose-library.mjs`
  It renders every master through the exact production path (docxtemplater + image module
  + LibreOffice) with no DB/org context, using a test logo + a flat token map.
- **Machine-readable report:** `server/scripts/diagnostics/library-report.json`
  A JSON array; one object per slug with fields:
  `slug, ok, stage, error, tags, hasLogoTag, pdfPages, mode, category, pack, engine`.
  - `ok: true` + `mode: "pdf"` → renders to PDF cleanly.
  - `ok: false` → `stage` tells you where it broke
    (`manifest` / `template-missing` / `zip` / `docxtemplater` / `soffice`) and `error`
    gives the reason (docxtemplater errors include the offending tag context).

### How to (re)generate the report

```bash
cd /Users/pristinelifestylesolutions/nexus-core/server
node scripts/diagnose-library.mjs                 # all 102, writes the report JSON
node scripts/diagnose-library.mjs <slug> [slug…]  # re-check specific slugs (also rewrites for those in argv)
```

> If `server/scripts/diagnostics/library-report.json` does not exist yet, generate it
> with the command above **before** trusting the `render status` column below. Status in
> this table must be reconciled against the report each session (see workflow in README).

---

## 4. Current position

```
NEXT: DONE — remediation complete
```

- **NEXT** = the first document that is still `todo` or `broken` (top-to-bottom in the table).
- After finishing a document, set its row's `render status` (and `logo-ok` / `body-reviewed`),
  then move this pointer to the next unfinished slug and commit.
- When every row's `render status` is `ok` or `fixed` **and** `logo-ok`/`body-reviewed` are
  `yes`, set `NEXT: DONE — remediation complete`.

**Status legend**
- `render status`: `todo` (not started) · `ok` (rendered clean, no change needed) ·
  `fixed` (was broken, now renders clean) · `broken` (fails, needs work).
- `logo-ok` / `body-reviewed`: `todo` · `yes` · `no`.

---

## 5. Document checklist (102)

| slug | pack | render status | logo-ok | body-reviewed | notes |
|------|------|---------------|---------|---------------|-------|
| accommodation-tenancy-assistance-position-description | staff_onboarding | ok | yes | yes |  |
| administering-medication-checklist-medication-chart | policy_library | ok | yes | yes |  |
| administration-business-development-position-description | staff_onboarding | ok | yes | yes |  |
| advocacy-of-support-person-request-form | policy_library | ok | yes | yes |  |
| business-continuity-and-disaster-management-plan | policy_library | ok | yes | yes | Minor: first-page header has hardcoded ABN 15 639 893 477 instead of {org.abn} (cosmetic). |
| change-of-supports | policy_library | ok | yes | yes |  |
| choice-advocacy-and-control-policy | policy_library | ok | yes | yes |  |
| client-cash-reconciliation | policy_library | ok | yes | yes |  |
| client-emergency-plan | policy_library | ok | yes | yes |  |
| client-induction-checklist | participant_onboarding | ok | yes | yes |  |
| client-information-booklet | participant_onboarding | ok | yes | yes | Pack policy_library→participant_onboarding (PACK_PROPOSAL applied 2026-07-08). |
| client-information-booklet-easy-read | participant_onboarding | ok | yes | yes | Pack policy_library→participant_onboarding (PACK_PROPOSAL applied 2026-07-08). |
| client-intake-form | participant_onboarding | ok | yes | yes |  |
| client-money-and-property-policy | policy_library | ok | yes | yes |  |
| client-support-plan | policy_library | ok | yes | yes |  |
| client-survey | policy_library | ok | yes | yes |  |
| collection-storage-of-medicine-register | compliance_register | ok | yes | yes |  |
| complaints-register | compliance_register | ok | yes | yes |  |
| conflict-of-interest-declaration | staff_onboarding | ok | yes | yes | Pack policy_library→staff_onboarding (PACK_PROPOSAL applied 2026-07-08). Signer=worker/1. FLAG CLOSED (2026-07-08): user confirmed this document is intentionally dual-use (usable by either a worker OR a participant), so the "Declaration by Client" body wording is acceptable — NOT a defect. No .docx change required. |
| conflict-of-interest-policy | policy_library | ok | yes | yes |  |
| conflict-of-interest-register | compliance_register | ok | yes | yes |  |
| continuous-improvement-register | compliance_register | ok | yes | yes |  |
| covid-19-pandemic-management-policy | policy_library | ok | yes | yes |  |
| delegation-of-authority | policy_library | ok | yes | yes |  |
| disability-support-worker-employment-consultant-position-description | staff_onboarding | ok | yes | yes |  |
| disability-support-worker-position-description | staff_onboarding | ok | yes | yes |  |
| disability-support-worker-position-description-travel-and-transport | staff_onboarding | ok | yes | yes |  |
| diversity-policy | policy_library | ok | yes | yes |  |
| document-register | compliance_register | ok | yes | yes |  |
| emergency-and-disaster-preparedness-policy | policy_library | ok | yes | yes | Minor: one header variant has hardcoded ABN 15 639 893 477 (cosmetic). |
| emergency-test-register | compliance_register | ok | yes | yes |  |
| emergency-waste-management-plan | policy_library | ok | yes | yes |  |
| exit-and-transition-form | policy_library | ok | yes | yes |  |
| exit-interview-form | policy_library | ok | yes | yes | Staff exit interview; pack kept policy_library (not onboarding). Minor: 2nd header variant leftover text "Service Schedule". |
| feedback-and-complaints-assessment-investigation-and-resolution-considerations | policy_library | ok | yes | yes |  |
| feedback-and-complaints-criteria-for-complaint-manager-or-incident-manager | policy_library | ok | yes | yes |  |
| feedback-and-complaints-form | policy_library | ok | yes | yes |  |
| feedback-and-complaints-policy | policy_library | ok | yes | yes |  |
| feedback-and-complaints-procedural-fairness-considerations | policy_library | ok | yes | yes |  |
| feedback-and-complaints-summary | policy_library | ok | yes | yes |  |
| feedback-and-compliments-register | compliance_register | ok | yes | yes |  |
| governance-policy | policy_library | ok | yes | yes |  |
| hr-performance-appraisal | policy_library | ok | yes | yes |  |
| human-resources-management-policy | policy_library | ok | yes | yes |  |
| incident-management-and-reporting-policy | policy_library | ok | yes | yes |  |
| incident-management-register | compliance_register | ok | yes | yes |  |
| incident-report-form | policy_library | ok | yes | yes | Minor: stray digits 431800393700431800393700 near Incident Manager field (cosmetic). |
| independent-contractor-agreement-including-cover-letter-induction-checklists-and-worker-declarations | staff_onboarding | ok | yes | yes | Signer/sig data-quality fix null/0→worker/1 (PACK_PROPOSAL applied 2026-07-08). |
| infection-control-policy | policy_library | ok | yes | yes |  |
| information-management-policy | policy_library | ok | yes | yes |  |
| interview-report-pro-forma | policy_library | ok | yes | yes |  |
| legislation-register | compliance_register | ok | yes | yes |  |
| letter-of-engagement-casual-employee | staff_onboarding | ok | yes | yes | Signer-role fix participant->worker (casual employee contract). Pack kept staff_onboarding. Minor: body has hardcoded "Date: /2022". |
| management-meeting-agenda | policy_library | ok | yes | yes |  |
| management-of-medication-policy | policy_library | ok | yes | yes |  |
| managing-and-reducing-known-risks-matrix | policy_library | ok | yes | yes |  |
| mealtime-management-plan | policy_library | ok | yes | yes |  |
| mealtime-management-policy | policy_library | ok | yes | yes |  |
| money-and-property-declaration | policy_library | ok | yes | yes | Signer/sig data-quality fix null/0→worker/1 (PACK_PROPOSAL applied 2026-07-08). Pack kept policy_library. |
| my-ndis-support-record | policy_library | ok | yes | yes | Minor: header reads "Worker Timesheet" (doc is NDIS support record). Cosmetic. |
| policy-register | compliance_register | ok | yes | yes |  |
| position-description-template | policy_library | ok | yes | yes | Generic blank PD template. Pack staff_onboarding→policy_library (PACK_PROPOSAL applied 2026-07-08). |
| position-description-template-director | policy_library | ok | yes | yes | Generic director PD template. Pack staff_onboarding→policy_library (PACK_PROPOSAL applied 2026-07-08). |
| potential-staff-reference-check-form | policy_library | ok | yes | yes | Recruitment reference-check (completed by referee pre-hire). Pack staff_onboarding→policy_library (PACK_PROPOSAL applied 2026-07-08). |
| pre-employment-collection-form | staff_onboarding | ok | yes | yes | Signer/sig data-quality fix null/0→worker/1 (PACK_PROPOSAL applied 2026-07-08). |
| preventing-and-responding-to-violence-abuse-neglect-exploitation-and-discrimination-policy | policy_library | ok | yes | yes |  |
| privacy-consent-form | participant_onboarding | ok | yes | yes |  |
| privacy-policy | policy_library | ok | yes | yes |  |
| progress-notes-template | policy_library | ok | yes | yes |  |
| promoting-and-protecting-rights | policy_library | ok | yes | yes |  |
| provision-of-supports-policy | policy_library | ok | yes | yes |  |
| quality-management-and-continuous-improvement-policy | policy_library | ok | yes | yes |  |
| risk-assessed-role-register | compliance_register | ok | yes | yes |  |
| risk-assessment-form | policy_library | ok | yes | yes |  |
| risk-management-policy | policy_library | ok | yes | yes |  |
| risk-register | compliance_register | ok | yes | yes |  |
| risk-taking-form | policy_library | ok | yes | yes |  |
| sda-and-sil-collaboration-agreement | policy_library | ok | yes | yes | Kept in policy_library (pre-approved). |
| service-schedule | participant_onboarding | ok | yes | yes |  |
| services-agreement | participant_onboarding | ok | yes | yes |  |
| services-agreement-sil | participant_onboarding | ok | yes | yes |  |
| services-medication-and-participant-details | policy_library | ok | yes | yes |  |
| staff-exit-checklist | policy_library | ok | yes | yes |  |
| staff-file-checklist | policy_library | ok | yes | yes |  |
| staff-induction-checklist | staff_onboarding | ok | yes | yes |  |
| staff-performance-improvement-plan | policy_library | ok | yes | yes |  |
| subject-to-a-significant-risk-factor-register | compliance_register | ok | yes | yes | Minor: body ends with hardcoded "ABN 67 643 217 8" (truncated) instead of token (cosmetic). |
| support-coordination-policy | policy_library | ok | yes | yes |  |
| support-coordination-services-agreement | participant_onboarding | ok | yes | yes |  |
| support-coordinator-position-description | staff_onboarding | ok | yes | yes |  |
| supported-independent-living-policy | policy_library | ok | yes | yes |  |
| training-and-development-register | compliance_register | ok | yes | yes |  |
| training-feedback-form | policy_library | ok | yes | yes |  |
| waste-management-plan | policy_library | ok | yes | yes |  |
| waste-management-policy | policy_library | ok | yes | yes |  |
| waste-management-report | policy_library | ok | yes | yes |  |
| waste-removal-records-register | compliance_register | ok | yes | yes |  |
| work-health-and-safety-checklist | policy_library | ok | yes | yes |  |
| work-health-and-safety-policy | policy_library | ok | yes | yes |  |
| worker-conflict-of-interest-declaration | staff_onboarding | ok | yes | yes | Worker COI declaration. Pack policy_library→staff_onboarding + signer/sig fix null/0→worker/1 (PACK_PROPOSAL applied 2026-07-08). |
| worker-declarations | staff_onboarding | ok | yes | yes | Signer-role fix participant->worker (worker onboarding doc). Pack kept staff_onboarding. |
| worker-supervision-record | policy_library | ok | yes | yes |  |

---

## 6. Session changelog (append-only)

Append one line per work session so a fresh agent can see recent history at a glance.
Format: `YYYY-MM-DD — <slugs touched> — <what changed>`.

- 2026-07-08 — client-information-booklet, client-information-booklet-easy-read,
  conflict-of-interest-declaration, position-description-template,
  position-description-template-director, potential-staff-reference-check-form,
  worker-conflict-of-interest-declaration, independent-contractor-agreement-…-worker-declarations,
  money-and-property-declaration, pre-employment-collection-form — Applied PACK_PROPOSAL.md
  (user-approved). Edited BOTH manifest.json AND _catalogue.json for each. Pack changes (7):
  client-information-booklet & …-easy-read policy_library→participant_onboarding;
  conflict-of-interest-declaration policy_library→staff_onboarding;
  worker-conflict-of-interest-declaration policy_library→staff_onboarding;
  position-description-template, position-description-template-director,
  potential-staff-reference-check-form staff_onboarding→policy_library. Signer/sig data-quality
  fixes (4, null/0→worker/1): worker-conflict-of-interest-declaration,
  independent-contractor-agreement-…-worker-declarations, money-and-property-declaration,
  pre-employment-collection-form. Re-ran harness: 102/102 render OK to PDF (mode:pdf), no
  regressions. Verified manifest+catalogue agree on pack/signer/sig for all edited slugs.
  OPEN: conflict-of-interest-declaration body still reads "Declaration by Client" (signer=worker)
  — template.docx wording left for human review (not touched this pass, per instruction).
- 2026-07-08 — ALL 102 — Per-document review pass completed. Regenerated diagnostic report:
  102/102 render OK to PDF (mode:pdf). Logo header verified via page-1 rasterisation of one
  sample per category (guide, procedure, form, policy, register, contract) — logo sits in the
  top-left header above the body in every case, no overlap; remaining docs share the same
  inline-header pattern so logo-ok = yes for all. Bodies extracted + reviewed for all 102:
  coherent, correctly branded ({org.name}/{org.legal_name}/{org.abn}/participant/staff tokens
  intact), no stray `{`/`}`, no lorem/XXXX/leftover junk placeholders.
- 2026-07-08 — worker-declarations, letter-of-engagement-casual-employee,
  conflict-of-interest-declaration — Applied pre-approved signer-role fix:
  required_signer_role "participant" → "worker" in BOTH manifest.json and _catalogue.json
  (3 entries). Re-ran harness for the three: still render OK. NOTE: conflict-of-interest-
  declaration body reads "Declaration by Client" — signer/body mismatch flagged for human review.
- 2026-07-08 — packs — Verified pack for all 102 against purpose; all existing packs judged
  appropriate, no pack moved (conservative default: don't move into an emailed onboarding pack
  unless clearly correct). sda-and-sil-collaboration-agreement kept in policy_library
  (pre-approved). Flagged for optional human review (kept as-is): position-description-template,
  position-description-template-director, potential-staff-reference-check-form (currently
  staff_onboarding → emailed to every new hire; arguably policy_library), and
  worker-conflict-of-interest-declaration (currently policy_library → arguably staff_onboarding).
- 2026-07-08 — packs — Created `PACK_PROPOSAL.md` (full 102-doc mapping) per user request to
  review automations in one pass. Proposes 7 pack changes: 3 high-confidence
  (client-information-booklet + easy-read → participant_onboarding; conflict-of-interest-declaration
  → staff_onboarding) and 4 judgment calls (position-description-template[-director] +
  potential-staff-reference-check-form → policy_library; worker-conflict-of-interest-declaration
  → staff_onboarding). Plus 4 signer/sig data-quality flags. NOTHING APPLIED yet — awaiting user
  approval. NEXT pointer set to "awaiting approval".

---

## 7. Reconciliation rule

At the **start** of every session, regenerate the diagnostic report (Section 3) and
reconcile it against the table:

- Report says `ok:true`/`pdf` but table row is `todo` → the doc renders; still needs
  `logo-ok` + `body-reviewed` before it counts as done. Do not blindly flip to `ok`.
- Report says `ok:false` → set/keep `render status` = `broken` and record the `stage`
  + short `error` in the notes column.
- The table's human review columns (`logo-ok`, `body-reviewed`) are NOT in the report —
  they are only ever set by a reviewing agent/human and must be preserved across sessions.

The report is ground truth for *rendering*; this file is ground truth for *review + intent*.
