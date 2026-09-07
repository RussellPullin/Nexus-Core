# Security Questionnaire Response Pack

**Version:** 0.1 Draft  
**Products:** Nexus Core, Shifter, Shifter Pro  
**How to use:** Copy answers into customer SIG/CAIQ/custom spreadsheets. Update bracketed fields before sending.  
**Rule:** Prefer accurate “No / In progress” over aspirational “Yes”.

---

## A. Company & scope

| # | Question | Answer |
|---|----------|--------|
| A1 | Legal entity | [LEGAL ENTITY NAME] trading as Nexus Core Solutions · ABN [ABN] |
| A2 | Products in scope | Nexus Core (web), Shifter (mobile), Shifter Pro (mobile) |
| A3 | Primary contact | nexuscoresolutions@outlook.com |
| A4 | Headquarters | Australia ([City/State]) |
| A5 | Number of staff with production access | [N] |
| A6 | Subprocessors | Published list at `/subprocessors` (Supabase, hosting, email, Expo/EAS, Apple IAP, optional customer connectors) |

## B. Certifications & assurance

| # | Question | Answer |
|---|----------|--------|
| B1 | SOC 2 Type II? | **Not yet.** Roadmap available; ISMS policies adopted. |
| B2 | ISO 27001? | **Not yet.** Policy pack aligns to ISMS practices. |
| B3 | Penetration test? | [Annual independent test scheduled / last completed DATE]. Summary under NDA. |
| B4 | Vulnerability scanning? | Dependency and periodic scanning per Vulnerability Management Policy. |
| B5 | Cyber insurance? | [Yes — certificate under NDA / In progress] |

## C. Data & privacy

| # | Question | Answer |
|---|----------|--------|
| C1 | Roles | Customer is APP entity for customer content; we process under DPA. |
| C2 | Privacy law | Privacy Act 1988 (Cth) / APPs. |
| C3 | DPA available? | Yes. |
| C4 | Sell personal information? | No. |
| C5 | Use customer content for ads / AI training? | **No** by default. |
| C6 | Data categories | Account data; participant/support records; staff compliance docs; shifts/notes/incidents; invoices; receipts; diagnostics. |
| C7 | Data residency | Australian hosting preferred for customer projects; confirm per deployment. Some subprocessors may process overseas — see list. |
| C8 | Retention | Per DPA / Data Retention Policy; customer export then delete on exit. |
| C9 | Individual rights | Access/correction via customer primarily; platform assists. |
| C10 | Breach notification | Without undue delay to customer; NDB assessment per Privacy Act. |

## D. Application security

| # | Question | Answer |
|---|----------|--------|
| D1 | Secure SDLC? | Yes — Secure SDLC Policy. |
| D2 | Auth | Email/password and/or organisation IdP where configured. |
| D3 | MFA | [Enforced for vendor prod admins; customer MFA [available/roadmap]] |
| D4 | RBAC | Organisation roles (admin/coordinator/staff as applicable). |
| D5 | Tenant isolation | Organisation-scoped access; dedicated projects/instances where deployed that way. |
| D6 | Encryption in transit | TLS. |
| D7 | Encryption at rest | Cloud-provider managed encryption. |
| D8 | Secrets management | Env/secret stores; not in source control. |
| D9 | Session management | Auth platform / app session controls. |
| D10 | File uploads | Receipts/documents stored in secured object storage; access controlled. |

## E. Operations

| # | Question | Answer |
|---|----------|--------|
| E1 | Hosting | Cloud (Supabase + application host). |
| E2 | Backups | Provider backups; restore tests per BCP/DR Policy. |
| E3 | RTO/RPO | Targets documented in BCP/DR Policy ([confirm numbers]). |
| E4 | Logging | Auth/admin/app logs; access restricted. |
| E5 | Incident response | Documented plan; tabletop [date]. |
| E6 | Change management | Source-controlled deploys; emergency change logging. |
| E7 | Status / uptime | SLA draft; [status page URL if any]. |

## F. Access & people

| # | Question | Answer |
|---|----------|--------|
| F1 | Background checks | [As permitted by AU law / role — state actual practice] |
| F2 | Confidentiality agreements | Yes for staff/contractors with access. |
| F3 | Security training | On join + annual. |
| F4 | Production access | Least privilege; MFA; quarterly review. |
| F5 | Support access to customer data | Ticketed/need-to-know; not for browsing. |
| F6 | Leavers | Access revoked within 24 hours. |

## G. Mobile (Shifter / Shifter Pro)

| # | Question | Answer |
|---|----------|--------|
| G1 | Offline storage | Yes — local device storage for field use. |
| G2 | Device security | Customer should require passcode/biometrics; enterprise MDM optional. |
| G3 | App distribution | Apple App Store. |
| G4 | Privacy nutrition labels | Maintained in App Store Connect. |
| G5 | Account deletion | Public instructions published. |
| G6 | Shifter Pro payments | Apple IAP and/or organisation billing. |

## H. Business continuity & exit

| # | Question | Answer |
|---|----------|--------|
| H1 | BCP/DR documented? | Yes. |
| H2 | Data export | Available via product export features / support-assisted export. |
| H3 | Deletion on termination | Per Customer Terms / DPA after wind-down. |
| H4 | Escrow | Not standard; discuss for strategic deals. |

## I. Compliance positioning (NDIS)

| # | Question | Answer |
|---|----------|--------|
| I1 | Are you an NDIS registered provider software certifier? | We provide **tools**; customers remain responsible for NDIS Quality and Safeguards compliance. |
| I2 | Do you supply policy templates? | Nexus Core includes a document library customers can use; templates do not replace their registration obligations. |
| I3 | Worker screening | Customer obligation; product can track document expiry when configured. |

---

## Cover email template

Subject: `Nexus Core Solutions — security diligence pack`

> Please find our Trust Center summary, DPA, subprocessors, and questionnaire responses for Nexus Core / Shifter / Shifter Pro.  
> We are not yet SOC 2 / ISO certified; we operate under documented ISMS policies and can share our assurance roadmap and pen-test summary under NDA.  
> Contact: nexuscoresolutions@outlook.com
