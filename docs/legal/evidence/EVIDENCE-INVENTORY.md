# Evidence Inventory — Audit / RFP Artefacts

**Purpose:** Index what enterprise buyers and auditors ask for, and where the real evidence lives.  
**Rule:** Store sensitive artefacts in a private vault (Drive/1Password/etc.). This file tracks *existence*, not secrets.

| # | Artefact | Buyer/auditor asks | Status | Location / owner | Last reviewed |
|---|----------|--------------------|--------|------------------|---------------|
| 1 | Privacy Policy (published) | “Link to privacy policy” | Draft in repo | Marketing site `/privacy` | |
| 2 | Product privacy pages | App Store / CRM diligence | Draft | `/privacy/*` | |
| 3 | Customer Terms / MSA | Legal review | Draft | `/terms/nexus-core` | |
| 4 | Signed DPA template | Procurement | Draft | `/dpa` | |
| 5 | Subprocessor list | Privacy / security | Draft | `/subprocessors` | |
| 6 | Security overview | Security questionnaire | Draft | `/security` | |
| 7 | Acceptable Use Policy | Contract schedule | Draft | `/aup` | |
| 8 | SLA | IT ops | Draft | docs/legal/nexus-core | |
| 9 | Information Security Policy | ISMS / SOC2 | Draft | docs/legal/policies | |
| 10 | Access Control Policy | Access reviews | Draft | docs/legal/policies | |
| 11 | Incident / Breach plan | NDB readiness | Draft | docs/legal/internal | |
| 12 | BCP / DR plan | Resilience | Draft | docs/legal/policies | |
| 13 | Data retention & disposal | Privacy | Draft | docs/legal/policies | |
| 14 | Secure SDLC policy | AppSec | Draft | docs/legal/policies | |
| 15 | Vulnerability mgmt policy | Patching | Draft | docs/legal/policies | |
| 16 | Vendor risk policy | Fourth parties | Draft | docs/legal/policies | |
| 17 | HR security / leavers | People controls | Draft | docs/legal/policies | |
| 18 | Encryption standard | Crypto | Draft | docs/legal/policies | |
| 19 | Logging & monitoring | Detection | Draft | docs/legal/policies | |
| 20 | Change management | Stability | Draft | docs/legal/policies | |
| 21 | Asset inventory | Scope | To create | Private vault | |
| 22 | Production access list | Least privilege | To create | Private vault | |
| 23 | MFA evidence screenshots | Identity | To create | Private vault | |
| 24 | Quarterly access review log | SOC2 CC6 | To create | Private vault | |
| 25 | Backup config + restore test | Availability | To create | Private vault | |
| 26 | Incident register | History | To create | Private vault | |
| 27 | Breach tabletop minutes | Preparedness | To create | Private vault | |
| 28 | Vulnerability scan results | AppSec | To create | Private vault | |
| 29 | Pen test report + remediations | Assurance | To create | Private vault | |
| 30 | Subprocessor due-diligence notes | Vendor risk | To create | Private vault | |
| 31 | Cyber insurance certificate | Risk transfer | To create | Private vault | |
| 32 | Public liability / PI insurance | Procurement | To create | Private vault | |
| 33 | Security awareness training log | People | To create | Private vault | |
| 34 | Customer data residency confirmation | AU hosting | To create | Per-tenant runbook | |
| 35 | Data export/deletion runbook | Exit | To create | Private vault | |
| 36 | SOC 2 report | Certification | Not started | — | |
| 37 | ISO 27001 certificate | Certification | Not started | — | |
| 38 | Network / architecture diagram | Diligence | To create (sanitised) | Private + optional public | |
| 39 | Responsible disclosure contact | Vulnerability reports | Draft email | security@ / outlook | |
| 40 | Executed customer DPAs | Contract evidence | Ongoing | Private vault | |

### How to use

1. Before each enterprise RFP, update **Status** and **Last reviewed**.  
2. Never paste passwords, customer participant data, or full pen-test findings into git.  
3. Assign an owner for each “To create” row within 30 days of adopting this pack.
