# Logging & Monitoring Policy

**Document ID:** POL-LOG-001  
**Version:** 0.1 Draft  
**Effective date:** [INSERT DATE]  
**Owner:** [Engineering / Ops]  

---

## 1. Purpose

Ensure security-relevant activity can be detected and investigated.

## 2. What we log (targets)

- Authentication successes/failures where available  
- Administrative configuration changes  
- Application errors and crash diagnostics  
- Infrastructure/deploy events  

Avoid writing sensitive participant note bodies into verbose debug logs in production.

## 3. Protection

Logs are access-restricted. Retention follows the Data Retention Policy.

## 4. Monitoring

Review alerts for anomalous admin access and service outages. Escalate suspected personal information incidents to the Data Breach Response Plan.
