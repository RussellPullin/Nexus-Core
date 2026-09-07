# Business Continuity & Disaster Recovery Policy

**Document ID:** POL-BCDR-001  
**Version:** 0.1 Draft  
**Effective date:** [INSERT DATE]  
**Owner:** [Operations]  

---

## 1. Purpose

Maintain critical services (Nexus Core, supporting APIs, mobile backends) through disruption and recover customer data within defined objectives.

## 2. Critical services

| Service | RTO (target) | RPO (target) |
|---------|--------------|--------------|
| Nexus Core production app | [24] hours | [24] hours |
| Auth / database | [24] hours | [24] hours |
| Marketing website | [72] hours | Best effort |
| Mobile App Store availability | N/A (Apple) | N/A |

*Replace bracketed targets after measuring real backup cadence.*

## 3. Strategies

- Use managed cloud databases with automated backups  
- Document restore steps in the private runbook  
- Keep infrastructure-as-config / deploy scripts recoverable  
- Maintain secondary communication channel (email/phone) if primary status page unavailable  

## 4. Testing

Perform a backup restore test at least **semi-annually**. Record date, success/failure, and fixes in the evidence vault.

## 5. Crisis communication

Notify affected customers of prolonged outages via email. For personal information breaches, follow the Data Breach Response Plan (NDB).
