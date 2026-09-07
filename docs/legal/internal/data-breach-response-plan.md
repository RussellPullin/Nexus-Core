# Data Breach Response Plan (Internal) — Nexus Core Solutions

**Classification:** Internal  
**Effective date:** [INSERT DATE]  
**Owner:** [Privacy / Security lead — NAME]  
**Related law:** Privacy Act 1988 (Cth) — Notifiable Data Breaches (NDB) scheme  

> Internal playbook. Not for public website publication without redaction.

---

## 1. Purpose

Provide a clear process to identify, contain, assess, and notify eligible data breaches affecting Nexus Core, Shifter, Shifter Pro, or company systems.

## 2. What is a suspected breach?

Any unauthorised access, disclosure, loss, or similar incident involving personal information, including:

- compromised admin credentials;
- misdirected exports/emails containing participant or staff data;
- ransomware or database exposure;
- employee or contractor unauthorised snooping;
- lost/stolen devices with offline Shifter data (assess likelihood of access).

## 3. Immediate response (0–24 hours)

1. **Log the incident** — time detected, reporter, systems affected, known data types.
2. **Assemble response roles** — technical lead, privacy lead, communications, legal advisor (external if needed).
3. **Contain** — rotate credentials, revoke tokens, isolate hosts, disable compromised integrations.
4. **Preserve evidence** — logs, access records; avoid destructive “cleanup” before capture.
5. **Stop ongoing leakage**.

## 4. Assessment (as soon as practicable; target ≤ 30 days for NDB assessment)

Assess whether:

- there is unauthorised access/disclosure or loss; and
- it is likely to result in **serious harm** to individuals.

Document the assessment even if you conclude notification is not required.

## 5. Notification

If an **eligible data breach**:

1. Notify the **OAIC** as required.
2. Notify **affected individuals** (or publish if direct notice impracticable) with recommended steps.
3. Notify **affected customer organisations** promptly (they may have their own NDIS/privacy duties).
4. Coordinate App Store / hosting provider notices only if required.

## 6. Customer communication template (outline)

- What happened (high level)
- What data categories may be involved
- What we have done
- What customers/individuals should do
- Contact for questions

## 7. Post-incident

- Root cause analysis
- Remediation tickets
- Update subprocessors / controls if needed
- Lessons learned within 14 days of closure

## 8. Contacts

| Role | Contact |
|------|---------|
| Privacy / incident intake | nexuscoresolutions@outlook.com |
| OAIC | https://www.oaic.gov.au |
| Legal counsel | [INSERT] |
| Hosting / Supabase support | [INSERT] |

## 9. Testing

Tabletop exercise at least annually; after major architecture changes.
