# NDIS Document Library — Automation (Pack) Proposal

> **APPLIED 2026-07-08** — User accepted this proposal in full. All 7 pack changes + 4 signer/sig data-quality fixes have been written to each `manifest.json` + `_catalogue.json` (manifest & catalogue verified consistent; harness re-run 102/102 render OK to PDF). One item remains open: the `conflict-of-interest-declaration` template.docx body still reads "Declaration by Client" (signer=worker) and needs human review — the `.docx` wording was intentionally not changed in this pass.

_Generated 2026-07-08. Proposal only — **no pack changes have been applied.** Approve or edit, then a follow-up pass will apply the accepted changes to each `manifest.json` + `_catalogue.json`._

## How packs map to automations

- `participant_onboarding` / `staff_onboarding` → **auto-attached to onboarding emails** (via `onboardingDocumentPacks.service.js`). Changing these changes what gets emailed.
- `policy_library` → in the library, **not** auto-emailed.
- `compliance_register` → registers/logs, internal only.

## Summary

| pack | current | proposed |
|------|---------|----------|
| participant_onboarding | 7 | 9 |
| staff_onboarding | 14 | 13 |
| policy_library | 66 | 65 |
| compliance_register | 15 | 15 |

**7 pack changes proposed** (3 high-confidence, 4 judgment calls).

### Recommended changes (high confidence)

- **client-information-booklet**: `policy_library` → `participant_onboarding` — Classic participant onboarding handout — should be emailed to new participants.
- **client-information-booklet-easy-read**: `policy_library` → `participant_onboarding` — Easy-read participant onboarding handout — email to new participants.
- **conflict-of-interest-declaration**: `policy_library` → `staff_onboarding` — Worker-signed declaration (signer=worker, 1 sig). Belongs in staff onboarding. NOTE: body text reads "Declaration by Client" — verify/repair body wording.

### Judgment calls (your decision)

- **position-description-template**: `staff_onboarding` → `policy_library` — Generic blank PD template. Currently staff_onboarding = emailed to every hire. A blank template is arguably library-only; the role-specific PDs cover onboarding.
- **position-description-template-director**: `staff_onboarding` → `policy_library` — Generic director PD template — same reasoning as position-description-template.
- **potential-staff-reference-check-form**: `staff_onboarding` → `policy_library` — Completed by a referee pre-hire, not by the new worker during onboarding. Arguably internal (library) rather than an onboarding-email doc.
- **worker-conflict-of-interest-declaration**: `policy_library` → `staff_onboarding` — Worker COI declaration — workers should sign at onboarding. Also a data-quality fix needed (signer=None, sig=0 → worker, 1). Possible duplicate of conflict-of-interest-declaration.

### Data-quality flags (signer / signature — independent of pack)

- **independent-contractor-agreement-including-cover-letter-induction-checklists-and-worker-declarations**: Contract in staff_onboarding but signer=None, sig=0. Should require a worker signature (signer=worker, sig>=1).
- **worker-conflict-of-interest-declaration**: signer=None, sig=0 on a declaration — should be signer=worker, sig=1.
- **money-and-property-declaration**: Contract "declaration" with signer=None, sig=0. If workers must sign, set signer=worker, sig=1.
- **pre-employment-collection-form**: Completed by the new worker — consider signer=worker, sig=1.

### Kept as-is by prior decision

- **sda-and-sil-collaboration-agreement**: stays in `policy_library` (used on its own when needed).

## Full mapping (all 102)

| slug | display name | current pack | proposed pack | signer | sig | notes |
|------|--------------|--------------|---------------|--------|-----|-------|
| accommodation-tenancy-assistance-position-description | Accommodation _ Tenancy Assistance Position Description | staff_onboarding | staff_onboarding | None | 0 |  |
| administering-medication-checklist-medication-chart | Administering Medication Checklist _ Medication Chart | policy_library | policy_library | None | 0 |  |
| administration-business-development-position-description | Administration _ Business Development Position Description | staff_onboarding | staff_onboarding | None | 0 |  |
| advocacy-of-support-person-request-form | Advocacy of Support Person Request Form | policy_library | policy_library | participant | 1 |  |
| business-continuity-and-disaster-management-plan | Business Continuity and Disaster Management Plan | policy_library | policy_library | None | 0 |  |
| change-of-supports | Change of Supports | policy_library | policy_library | participant | 1 |  |
| choice-advocacy-and-control-policy | Choice Advocacy and Control Policy | policy_library | policy_library | None | 0 |  |
| client-cash-reconciliation | Client Cash Reconciliation | policy_library | policy_library | None | 0 |  |
| client-emergency-plan | Client Emergency Plan | policy_library | policy_library | None | 0 |  |
| client-induction-checklist | Client Induction Checklist | participant_onboarding | participant_onboarding | None | 0 |  |
| client-information-booklet | Client Information Booklet | policy_library | participant_onboarding ⬅️ | None | 0 | **CHANGE (HIGH)**: Classic participant onboarding handout — should be emailed to new participants. |
| client-information-booklet-easy-read | Client Information Booklet (Easy Read) | policy_library | participant_onboarding ⬅️ | None | 0 | **CHANGE (HIGH)**: Easy-read participant onboarding handout — email to new participants. |
| client-intake-form | Client Intake Form | participant_onboarding | participant_onboarding | participant | 1 |  |
| client-money-and-property-policy | Client Money and Property Policy | policy_library | policy_library | None | 0 |  |
| client-support-plan | Client Support Plan | policy_library | policy_library | None | 0 |  |
| client-survey | Client Survey | policy_library | policy_library | None | 0 |  |
| collection-storage-of-medicine-register | Collection _ Storage of Medicine Register | compliance_register | compliance_register | None | 0 |  |
| complaints-register | Complaints Register | compliance_register | compliance_register | None | 0 |  |
| conflict-of-interest-declaration | Conflict of Interest Declaration | policy_library | staff_onboarding ⬅️ | worker | 1 | **CHANGE (HIGH)**: Worker-signed declaration (signer=worker, 1 sig). Belongs in staff onboarding. NOTE: body text reads "Declaration by Client" — verify/repair body wording. |
| conflict-of-interest-policy | Conflict of Interest Policy | policy_library | policy_library | None | 0 |  |
| conflict-of-interest-register | Conflict of Interest Register | compliance_register | compliance_register | None | 0 |  |
| continuous-improvement-register | Continuous Improvement Register | compliance_register | compliance_register | None | 0 |  |
| covid-19-pandemic-management-policy | COVID-19 Pandemic Management Policy | policy_library | policy_library | None | 0 |  |
| delegation-of-authority | Delegation of Authority | policy_library | policy_library | None | 0 |  |
| disability-support-worker-employment-consultant-position-description | Disability Support Worker (Employment Consultant) Position Description | staff_onboarding | staff_onboarding | None | 0 |  |
| disability-support-worker-position-description | Disability Support Worker Position Description | staff_onboarding | staff_onboarding | None | 0 |  |
| disability-support-worker-position-description-travel-and-transport | Disability Support Worker Position Description (Travel and Transport) | staff_onboarding | staff_onboarding | None | 0 |  |
| diversity-policy | Diversity Policy | policy_library | policy_library | None | 0 |  |
| document-register | Document Register | compliance_register | compliance_register | None | 0 |  |
| emergency-and-disaster-preparedness-policy | Emergency and Disaster Preparedness Policy | policy_library | policy_library | None | 0 |  |
| emergency-test-register | Emergency Test Register | compliance_register | compliance_register | None | 0 |  |
| emergency-waste-management-plan | Emergency Waste Management Plan | policy_library | policy_library | None | 0 |  |
| exit-and-transition-form | Exit and Transition Form | policy_library | policy_library | participant | 1 |  |
| exit-interview-form | Exit Interview Form | policy_library | policy_library | None | 0 |  |
| feedback-and-complaints-assessment-investigation-and-resolution-considerations | Feedback and Complaints Assessment, Investigation and Resolution Considerations | policy_library | policy_library | None | 0 |  |
| feedback-and-complaints-criteria-for-complaint-manager-or-incident-manager | Feedback and Complaints Criteria for Complaint Manager or Incident Manager | policy_library | policy_library | None | 0 |  |
| feedback-and-complaints-form | Feedback and Complaints Form | policy_library | policy_library | None | 0 |  |
| feedback-and-complaints-policy | Feedback and Complaints Policy | policy_library | policy_library | None | 0 |  |
| feedback-and-complaints-procedural-fairness-considerations | Feedback and Complaints Procedural Fairness Considerations | policy_library | policy_library | None | 0 |  |
| feedback-and-complaints-summary | Feedback and Complaints Summary | policy_library | policy_library | None | 0 |  |
| feedback-and-compliments-register | Feedback and Compliments Register | compliance_register | compliance_register | None | 0 |  |
| governance-policy | Governance Policy | policy_library | policy_library | None | 0 |  |
| hr-performance-appraisal | HR Performance Appraisal | policy_library | policy_library | None | 0 |  |
| human-resources-management-policy | Human Resources Management Policy | policy_library | policy_library | None | 0 |  |
| incident-management-and-reporting-policy | Incident Management and Reporting Policy | policy_library | policy_library | None | 0 |  |
| incident-management-register | Incident Management Register | compliance_register | compliance_register | None | 0 |  |
| incident-report-form | Incident Report Form | policy_library | policy_library | None | 0 |  |
| independent-contractor-agreement-including-cover-letter-induction-checklists-and-worker-declarations | Independent Contractor Agreement (including cover letter, induction checklists and worker declarations) | staff_onboarding | staff_onboarding | None | 0 | DATA-QUALITY: Contract in staff_onboarding but signer=None, sig=0. Should require a worker signature (signer=worker, sig>=1). |
| infection-control-policy | Infection Control Policy | policy_library | policy_library | None | 0 |  |
| information-management-policy | Information Management Policy | policy_library | policy_library | None | 0 |  |
| interview-report-pro-forma | Interview Report Pro Forma | policy_library | policy_library | None | 0 |  |
| legislation-register | Legislation Register | compliance_register | compliance_register | None | 0 |  |
| letter-of-engagement-casual-employee | Letter of Engagement Casual Employee | staff_onboarding | staff_onboarding | worker | 2 |  |
| management-meeting-agenda | Management Meeting Agenda | policy_library | policy_library | None | 0 |  |
| management-of-medication-policy | Management of Medication Policy | policy_library | policy_library | None | 0 |  |
| managing-and-reducing-known-risks-matrix | Managing and Reducing Known Risks Matrix | policy_library | policy_library | None | 0 |  |
| mealtime-management-plan | Mealtime Management Plan | policy_library | policy_library | None | 0 |  |
| mealtime-management-policy | Mealtime Management Policy | policy_library | policy_library | None | 0 |  |
| money-and-property-declaration | Money and Property Declaration | policy_library | policy_library | None | 0 | DATA-QUALITY: Contract "declaration" with signer=None, sig=0. If workers must sign, set signer=worker, sig=1. |
| my-ndis-support-record | My NDIS Support Record | policy_library | policy_library | None | 0 |  |
| policy-register | Policy Register | compliance_register | compliance_register | None | 0 |  |
| position-description-template | Position Description Template | staff_onboarding | policy_library ⬅️ | None | 0 | **CHANGE (MEDIUM)**: Generic blank PD template. Currently staff_onboarding = emailed to every hire. A blank template is arguably library-only; the role-specific PDs cover onboarding. |
| position-description-template-director | Position Description Template Director | staff_onboarding | policy_library ⬅️ | None | 0 | **CHANGE (MEDIUM)**: Generic director PD template — same reasoning as position-description-template. |
| potential-staff-reference-check-form | Potential Staff Reference Check Form | staff_onboarding | policy_library ⬅️ | None | 0 | **CHANGE (MEDIUM)**: Completed by a referee pre-hire, not by the new worker during onboarding. Arguably internal (library) rather than an onboarding-email doc. |
| pre-employment-collection-form | Pre Employment Collection Form | staff_onboarding | staff_onboarding | None | 0 | DATA-QUALITY: Completed by the new worker — consider signer=worker, sig=1. |
| preventing-and-responding-to-violence-abuse-neglect-exploitation-and-discrimination-policy | Preventing and Responding to Violence, Abuse, Neglect, Exploitation and Discrimination Policy | policy_library | policy_library | None | 0 |  |
| privacy-consent-form | Privacy Consent Form | participant_onboarding | participant_onboarding | participant | 1 |  |
| privacy-policy | Privacy Policy | policy_library | policy_library | None | 0 |  |
| progress-notes-template | Progress Notes Template | policy_library | policy_library | None | 0 |  |
| promoting-and-protecting-rights | Promoting and Protecting Rights | policy_library | policy_library | None | 0 |  |
| provision-of-supports-policy | Provision of Supports Policy | policy_library | policy_library | None | 0 |  |
| quality-management-and-continuous-improvement-policy | Quality Management and Continuous Improvement Policy | policy_library | policy_library | None | 0 |  |
| risk-assessed-role-register | Risk Assessed Role Register | compliance_register | compliance_register | None | 0 |  |
| risk-assessment-form | Risk Assessment Form | policy_library | policy_library | None | 0 |  |
| risk-management-policy | Risk Management Policy | policy_library | policy_library | None | 0 |  |
| risk-register | Risk Register | compliance_register | compliance_register | None | 0 |  |
| risk-taking-form | Risk Taking Form | policy_library | policy_library | None | 0 |  |
| sda-and-sil-collaboration-agreement | SDA and SIL Collaboration Agreement | policy_library | policy_library | participant | 2 |  |
| service-schedule | Service Schedule | participant_onboarding | participant_onboarding | None | 0 |  |
| services-agreement | Services Agreement | participant_onboarding | participant_onboarding | participant | 2 |  |
| services-agreement-sil | Services Agreement (SIL) | participant_onboarding | participant_onboarding | participant | 2 |  |
| services-medication-and-participant-details | Services Medication and Participant Details | policy_library | policy_library | None | 0 |  |
| staff-exit-checklist | Staff Exit Checklist | policy_library | policy_library | None | 0 |  |
| staff-file-checklist | Staff File Checklist | policy_library | policy_library | None | 0 |  |
| staff-induction-checklist | Staff Induction Checklist | staff_onboarding | staff_onboarding | None | 0 |  |
| staff-performance-improvement-plan | Staff Performance Improvement Plan | policy_library | policy_library | None | 0 |  |
| subject-to-a-significant-risk-factor-register | Subject to a Significant Risk Factor Register | compliance_register | compliance_register | None | 0 |  |
| support-coordination-policy | Support Coordination Policy | policy_library | policy_library | None | 0 |  |
| support-coordination-services-agreement | Support Coordination Services Agreement | participant_onboarding | participant_onboarding | participant | 2 |  |
| support-coordinator-position-description | Support Coordinator Position Description | staff_onboarding | staff_onboarding | None | 0 |  |
| supported-independent-living-policy | Supported Independent Living Policy | policy_library | policy_library | None | 0 |  |
| training-and-development-register | Training and Development Register | compliance_register | compliance_register | None | 0 |  |
| training-feedback-form | Training Feedback Form | policy_library | policy_library | None | 0 |  |
| waste-management-plan | Waste Management Plan | policy_library | policy_library | None | 0 |  |
| waste-management-policy | Waste Management Policy | policy_library | policy_library | None | 0 |  |
| waste-management-report | Waste Management Report | policy_library | policy_library | None | 0 |  |
| waste-removal-records-register | Waste Removal Records Register | compliance_register | compliance_register | None | 0 |  |
| work-health-and-safety-checklist | Work Health and Safety Checklist | policy_library | policy_library | None | 0 |  |
| work-health-and-safety-policy | Work Health and Safety Policy | policy_library | policy_library | None | 0 |  |
| worker-conflict-of-interest-declaration | Worker Conflict of Interest Declaration | policy_library | staff_onboarding ⬅️ | None | 0 | **CHANGE (MEDIUM)**: Worker COI declaration — workers should sign at onboarding. Also a data-quality fix needed (signer=None, sig=0 → worker, 1). Possible duplicate of conflict-of-interest-declaration. \| DATA-QUALITY: signer=None, sig=0 on a declaration — should be signer=worker, sig=1. |
| worker-declarations | Worker Declarations | staff_onboarding | staff_onboarding | worker | 1 |  |
| worker-supervision-record | Worker Supervision Record | policy_library | policy_library | None | 0 |  |
