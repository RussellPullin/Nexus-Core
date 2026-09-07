# Enterprise Sales Readiness — Nexus Core Solutions

**Audience:** Founders / ops preparing for large disability providers, multi-site organisations, and procurement/security reviews  
**Status:** Working pack — policies are drafts until adopted, dated, and followed in practice  
**Related:** [Legal suite README](../README.md)

---

## What large buyers actually ask for

Enterprise procurement rarely wants “more marketing.” They want proof you can answer:

1. **Who are you contractually?** Legal entity, ABN, insurance, signing authority  
2. **How is our data protected?** Encryption, access control, hosting region, backups  
3. **Who can see participant data?** Your staff, subprocessors, support access  
4. **What happens when something goes wrong?** Incident / breach process, contacts, timelines  
5. **Can we contractually lock this in?** DPA, Customer Terms, SLA, subprocessors, audit rights  
6. **Are you certified?** SOC 2 / ISO 27001 — or a credible roadmap if not yet  
7. **Can we exit cleanly?** Export + deletion  

If you get “looked into,” reviewers compare **written policies** to **what you actually do**. Empty policies without operational habit are worse than honest “not yet / in progress” answers.

---

## Honest current posture (update as you mature)

| Capability | Typical enterprise ask | Current draft posture | Gap to close |
|------------|------------------------|----------------------|--------------|
| Public privacy & terms | Published, product-specific | Drafts in `docs/legal/` — site still incomplete | Publish + fix brand/entity |
| DPA + subprocessors | Signed DPA, live subprocessor list | Drafts exist | Lawyer review + publish |
| Information security policies | Formal ISMS policies | Drafts in `policies/` | Adopt, train, evidence |
| Security overview / FAQ | Shareable PDF or trust page | Drafts exist | Publish `/security` + FAQ |
| SOC 2 Type II | Common US/AU enterprise ask | **Not claimed** | Roadmap in this doc |
| ISO/IEC 27001 | Common AU enterprise ask | **Not claimed** | Roadmap in this doc |
| Pen test | Annual independent test | Document as planned | Commission + remediate |
| Cyber insurance | Certificate of currency | Obtain / record | Place policy |
| Data residency | AU hosting preference | Prefer AU Supabase projects | Confirm per customer |
| Staff access controls | MFA, least privilege, logging | Describe accurately | Enforce + evidence screenshots |
| Mobile / BYOD | Device controls for Shifter | Guidance in policies | MDM optional for enterprise |

**Do not tell buyers you are SOC 2 / ISO certified until an accredited auditor says so.**

---

## Pack map (enterprise layer)

| Folder | Purpose |
|--------|---------|
| [`policies/`](../policies/) | Internal ISMS-style policies you operate under |
| [`enterprise/`](./) | Buyer-facing trust materials + questionnaire answers |
| [`evidence/`](../evidence/) | Inventory of artefacts to collect for audits/RFPs |
| [`../internal/`](../internal/) | Breach response playbook |
| [`../company/`](../company/) + product folders | Customer-facing legal |

---

## 90-day enterprise readiness roadmap

### Days 1–14 — Make documents real

1. Confirm software contracting entity + ABN + privacy contact email  
2. Lawyer-review Customer Terms, DPA, Privacy policies  
3. Publish website legal routes (see [PUBLISHING-CHECKLIST](../PUBLISHING-CHECKLIST.md))  
4. Update App Store privacy / terms / account-deletion URLs  
5. Adopt the policy set (owner signs “Approved” block on each policy)  
6. Fill [Evidence Inventory](../evidence/EVIDENCE-INVENTORY.md) with real links/screenshots locations  

### Days 15–45 — Operationalise controls

1. Enforce MFA for all production admin access  
2. Document joiner/mover/leaver checklist; revoke access within 24h of exit  
3. Turn on/confirm backups; write restore test notes  
4. Create support access rule: production data only with ticket + customer consent where required  
5. Complete first tabletop of the [Data Breach Response Plan](../internal/data-breach-response-plan.md)  
6. Send [Security Questionnaire Pack](security-questionnaire-pack.md) answers with every serious enterprise opportunity  

### Days 45–90 — External assurance track

1. Commission vulnerability scan + scoped penetration test  
2. Place or confirm **cyber liability insurance**; store certificate  
3. Choose assurance path: **SOC 2 Type I → Type II** and/or **ISO 27001** (see below)  
4. Start collecting evidence continuously (tickets, access reviews, backup tests)  
5. Offer enterprise customers: AU data residency confirmation, DPA, security schedule, optional MSA redlines  

---

## Assurance path (pick one primary)

### Option A — SOC 2 Type II (often preferred by larger corporates)

- Engage a CPA firm / auditor familiar with SaaS  
- Define Trust Services Criteria in scope (Security minimum; add Availability/Confidentiality for NDIS data)  
- Type I (point in time) then Type II (3–12 month observation)  
- Budget: significant; plan months of evidence collection  

### Option B — ISO/IEC 27001

- Build ISMS around the policies in `policies/`  
- Statement of Applicability + internal audit + certification body  
- Strong brand signal in Australia  

### Option C — Bridging (sell now, certify later)

Until certified, give buyers:

- This readiness pack + signed DPA  
- Security overview + questionnaire responses  
- Pen test summary letter (when available)  
- Right to security questionnaire annually  
- Contractual breach notification timelines  

Many mid-market NDIS providers accept Option C if answers are complete and honest.

---

## Minimum “looked into” folder (keep offline + access-controlled)

Maintain a private vault (not public git) containing:

- Signed policy register (versions + approval dates)  
- Access review logs (quarterly)  
- Backup restore test records  
- Incident register (even if empty — with “no incidents” attestation)  
- Vendor due diligence notes for Supabase/hosting  
- Pen test report + remediation tracker  
- Insurance certificates  
- Training attendance (privacy + security)  
- Customer DPAs executed  

Use [Evidence Inventory](../evidence/EVIDENCE-INVENTORY.md) as the index. **Do not commit secrets, customer data, or pen-test full reports to this public repo.**

---

## Immediate sales enablement

When a large company asks “send your compliance docs,” share:

1. [Trust Center one-pager](trust-center.md)  
2. [Security Questionnaire Pack](security-questionnaire-pack.md)  
3. Public links: Privacy, DPA, Subprocessors, Security Overview, Customer Terms  
4. Optional: NDA first, then pen-test summary  

Internal only: full policies + evidence vault.
