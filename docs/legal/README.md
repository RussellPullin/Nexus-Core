# Nexus Core Solutions — Legal & Compliance Document Suite

> **Status:** Draft pack for legal review (not legal advice).  
> **Last researched:** 7 September 2026  
> **Publish targets:** [nexuscoresolutions.com.au](https://nexuscoresolutions.com.au/), App Store listings, customer contracts.

This folder holds the **vendor / SaaS** forms and policies Nexus Core Solutions needs. It is separate from the in-app **NDIS provider document library** (`server/templates/library/`), which customers use for their own NDIS Quality and Safeguards obligations.

---

## Research summary (what each product is)

| Product | What it is | Users | Data sensitivity | Distribution |
|---------|------------|-------|------------------|--------------|
| **Nexus Core** | Web CRM for coordinators/admin — scheduling, participants, NDIS budgets, invoicing, onboarding, compliance registers | Provider office staff | High — NDIS participant health/support records, staff HR docs, invoices | SaaS web (`app.nexuscore.io`) |
| **Shifter** | Mobile field app — shifts, progress notes, incidents, receipts; syncs to Nexus Core | Support workers | High — participant notes, incidents, receipt images | App Store (`com.pristinelifestylesolutions.shifter`) |
| **Shifter Pro** | Advanced mobile — Shifter features + participant/staff management, invoicing, batch billing, P&L, NDIS catalogue | Managers / independent workers | Very high — billing, financials, participant records on device | App Store (`com.pristinelifestylesolutions.shifterpro`); Apple IAP subscription |
| **Nexus Core Solutions** | Software brand / company operating the ecosystem | Prospects, customers, website visitors | Contact + billing + support data | Website, email (`nexuscoresolutions@outlook.com`) |

### Entity / branding notes (resolve before publishing)

| Signal | Current value | Action |
|--------|---------------|--------|
| Website brand | Nexus Core Solutions | Keep as trading name |
| Support email | nexuscoresolutions@outlook.com | Prefer a branded domain mailbox when ready |
| Published Shifter privacy draft | **Pristine Lifestyle Solutions** / info@pristinelifestylesolutions.com.au | Replace with confirmed legal entity + Nexus Core Solutions contact |
| App Store seller | Russell Pullin | Align seller/legal name with company entity if desired |
| Bundle IDs | `com.pristinelifestylesolutions.*` | Historical; no immediate change required for policies |
| Related NDIS provider | Spring2Health Pty Ltd t/a Pristine Lifestyle Solutions — ABN **71 665 820 986** | Confirm whether this entity (or another) is the **software** contracting party |

**Placeholder used in drafts:** `[LEGAL ENTITY NAME]` and `[ABN]` until you confirm the contracting entity for SaaS sales.

---

## What already exists vs gaps

| Item | Status (as of research) |
|------|-------------------------|
| Website `/privacy` | Partial — Nexus Core “coming soon”; Shifter draft under old brand; no Shifter Pro section |
| Website `/terms`, `/dpa`, `/security`, `/cookies`, `/subprocessors`, `/account-deletion` | **Missing (404)** |
| Shifter App Store privacy URL | Points at incomplete `/privacy` |
| Shifter Pro Terms | Apple Standard EULA only |
| Shifter Pro Privacy URL field | Not set in App Store lookup (`privacyPolicyUrl: None`) — listing text links `/privacy` |
| Account deletion instructions (Apple) | **Missing** public page |
| Customer SaaS agreement / DPA | **Missing** |
| In-app NDIS policy library for *customer* providers | Exists (102 docs) — not a substitute for vendor legal pages |

---

## Required forms & documents matrix

### A. Nexus Core Solutions (company / website)

| Document | Why required | Priority | Draft location |
|----------|--------------|----------|----------------|
| Master Privacy Policy (hub + website) | Privacy Act 1988 (Cth) / APPs; website + trial signup | P0 | [`company/privacy-policy.md`](company/privacy-policy.md) |
| Website Terms of Use | Website/demo/trial use; IP; liability | P0 | [`company/website-terms.md`](company/website-terms.md) |
| Cookie / tracking notice | Transparent collection if analytics/cookies used | P1 | [`company/cookie-notice.md`](company/cookie-notice.md) |
| Acceptable Use Policy | Shared across products; abuse / misuse | P1 | [`company/acceptable-use-policy.md`](company/acceptable-use-policy.md) |
| Subprocessor list | Transparency for APP 8 / customer DPAs | P0 | [`company/subprocessors.md`](company/subprocessors.md) |
| Security overview (public) | Sales trust; answers security questionnaires | P1 | [`company/security-overview.md`](company/security-overview.md) |
| APP 5 collection notice (short) | Required when collecting personal information | P0 | [`company/collection-notice.md`](company/collection-notice.md) |
| Data breach response plan | Privacy Act NDB scheme readiness | P1 | [`internal/data-breach-response-plan.md`](internal/data-breach-response-plan.md) |

### B. Nexus Core (web CRM)

| Document | Why required | Priority | Draft location |
|----------|--------------|----------|----------------|
| Product Privacy Policy | Account holders + role as processor of customer content | P0 | [`nexus-core/privacy-policy.md`](nexus-core/privacy-policy.md) |
| Customer Terms of Service (SaaS) | Subscription, fees, trials, liability, ACL | P0 | [`nexus-core/customer-terms.md`](nexus-core/customer-terms.md) |
| Data Processing Addendum | B2B processing of participant/staff data for providers | P0 | [`nexus-core/data-processing-addendum.md`](nexus-core/data-processing-addendum.md) |
| Service Level Agreement | Uptime expectations (optional but sales-expected) | P2 | [`nexus-core/service-level-agreement.md`](nexus-core/service-level-agreement.md) |

### C. Shifter (mobile)

| Document | Why required | Priority | Draft location |
|----------|--------------|----------|----------------|
| Privacy Policy | App Store + Privacy Act; update brand/entity | P0 | [`shifter/privacy-policy.md`](shifter/privacy-policy.md) |
| Terms of Use | End-user licence for workers | P0 | [`shifter/terms-of-use.md`](shifter/terms-of-use.md) |
| Account deletion instructions | Apple App Store Guideline 5.1.1(v) | P0 | [`shifter/account-deletion.md`](shifter/account-deletion.md) |
| App Privacy Labels worksheet | App Store Connect nutrition labels | P1 | [`shifter/app-privacy-labels.md`](shifter/app-privacy-labels.md) |

### D. Shifter Pro (mobile + IAP)

| Document | Why required | Priority | Draft location |
|----------|--------------|----------|----------------|
| Privacy Policy | Broader data (invoicing, P&L, participants) | P0 | [`shifter-pro/privacy-policy.md`](shifter-pro/privacy-policy.md) |
| Terms of Use (incl. subscription) | Apple requires functional Terms link for auto-renewable IAP | P0 | [`shifter-pro/terms-of-use.md`](shifter-pro/terms-of-use.md) |
| Account deletion instructions | Apple requirement | P0 | [`shifter-pro/account-deletion.md`](shifter-pro/account-deletion.md) |
| App Privacy Labels worksheet | Extra categories vs Shifter | P1 | [`shifter-pro/app-privacy-labels.md`](shifter-pro/app-privacy-labels.md) |

### E. Enterprise sales readiness (large-company diligence)

Large buyers ask for policies, questionnaire answers, and evidence — not only public privacy pages. See **[`enterprise/README.md`](enterprise/README.md)** for the roadmap.

| Document | Why required | Priority | Draft location |
|----------|--------------|----------|----------------|
| Enterprise readiness roadmap | What to do in 90 days to sell to large orgs | P0 | [`enterprise/README.md`](enterprise/README.md) |
| Trust Center one-pager | First attachment for security reviews | P0 | [`enterprise/trust-center.md`](enterprise/trust-center.md) |
| Security questionnaire pack | Pre-answered SIG/CAIQ-style questions | P0 | [`enterprise/security-questionnaire-pack.md`](enterprise/security-questionnaire-pack.md) |
| Controls mapping (SOC 2 / ISO) | Bridging artefact until certified | P1 | [`enterprise/controls-mapping.md`](enterprise/controls-mapping.md) |
| Enterprise deal checklist | Pre-signature gate | P1 | [`enterprise/deal-checklist.md`](enterprise/deal-checklist.md) |
| ISMS policy set | Access, SDLC, vulns, BCP/DR, retention, vendors, HR, crypto, logging, change | P0 | [`policies/`](policies/) |
| Policy register | Adoption tracking | P0 | [`policies/POLICY-REGISTER.md`](policies/POLICY-REGISTER.md) |
| Evidence inventory | Private vault index for audits | P0 | [`evidence/EVIDENCE-INVENTORY.md`](evidence/EVIDENCE-INVENTORY.md) |
| PIA / DPIA template | Before new sensitive-data features | P1 | [`policies/pia-dpia-template.md`](policies/pia-dpia-template.md) |

**Do not claim SOC 2 or ISO 27001 until an auditor certifies you.** The pack supports honest “aligned practices + roadmap” answers.

### F. Not in this pack (customer NDIS provider obligations)

Customer organisations still need their own NDIS policies/registers (services agreements, incident management, worker screening, etc.). Those live in the **document library** shipped inside Nexus Core — see `docs/doc-library-remediation/`. Do not conflate vendor SaaS legal pages with provider registration evidence.

---

## Suggested website routes

Publish (or copy) drafts to the marketing site as:

| Route | Content |
|-------|---------|
| `/privacy` | Company hub linking product sections |
| `/privacy/nexus-core` | Nexus Core privacy |
| `/privacy/shifter` | Shifter privacy |
| `/privacy/shifter-pro` | Shifter Pro privacy |
| `/terms` | Website terms + links to product terms |
| `/terms/nexus-core` | Customer SaaS terms |
| `/terms/shifter` | Shifter ToU |
| `/terms/shifter-pro` | Shifter Pro ToU (+ IAP) |
| `/dpa` | Data Processing Addendum |
| `/security` | Security overview (+ link to Trust Center summary) |
| `/cookies` | Cookie notice |
| `/subprocessors` | Subprocessor list |
| `/legal/account-deletion` | Combined account deletion for both apps |
| `/aup` | Acceptable Use Policy |
| `/trust` (optional) | Public Trust Center one-pager |

App Store Connect:

- Shifter & Shifter Pro → Privacy Policy URL → `/privacy/shifter` and `/privacy/shifter-pro`
- Shifter Pro → Terms of Use (EULA) URL → `/terms/shifter-pro` (custom EULA recommended over Standard EULA alone)

---

## How to use these drafts

1. Confirm **legal entity**, ABN, registered address, and privacy contact email.
2. Have an Australian privacy/commercial lawyer review (especially DPA, SaaS terms, health/disability data handling).
3. Align App Store seller name and privacy URLs.
4. Publish to the marketing site; keep this folder as source of truth until the site repo owns the HTML.
5. For enterprise deals: follow [`enterprise/README.md`](enterprise/README.md), adopt policies in `policies/`, and fill the private [`evidence/EVIDENCE-INVENTORY.md`](evidence/EVIDENCE-INVENTORY.md).
6. Review annually or when subprocessors / products change.

---

## File index

```
docs/legal/
  README.md                          ← this matrix
  PUBLISHING-CHECKLIST.md
  company/                           ← public legal pages
  nexus-core/                        ← SaaS terms, DPA, privacy, SLA
  shifter/ · shifter-pro/            ← app privacy, ToU, deletion, labels
  internal/                          ← breach response playbook
  enterprise/                        ← trust center, questionnaire, deal checklist
  policies/                          ← ISMS-style internal policies
  evidence/                          ← audit artefact index (not secrets)
```
