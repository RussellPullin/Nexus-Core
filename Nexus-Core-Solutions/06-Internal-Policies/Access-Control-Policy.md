# Access Control Policy

**Document ID:** POL-AC-001  
**Version:** 0.1 Draft  
**Effective date:** [INSERT DATE]  
**Owner:** [Security / Founder]  
**Review cycle:** Annual  

---

## 1. Purpose

Control who can access systems and data for Nexus Core Solutions products and infrastructure.

## 2. Principles

- Unique user identities (no shared admin logins where avoidable)  
- Least privilege  
- Separation of duties where practical (e.g. production break-glass)  
- MFA for production administrative access  
- Prompt revocation on role change or exit  

## 3. Access tiers

| Tier | Examples | Controls |
|------|----------|----------|
| Public | Marketing website | Standard hosting hardening |
| Customer user | Org staff in Nexus Core / apps | Org-administered roles |
| Customer admin | Org owner/admin | Strong auth; limited seats |
| Vendor support | Nexus staff viewing customer data | Ticketed, time-bound, logged |
| Production infra | Hosting, DB, secrets | MFA, minimal standing access |

## 4. Joiner / mover / leaver

1. **Joiner:** Access approved by owner; recorded in access list.  
2. **Mover:** Privileges adjusted within 7 days of role change.  
3. **Leaver:** All access revoked within **24 hours** of last day (immediate if high risk).  

## 5. Reviews

Quarterly review of production and admin access. Evidence stored in the private evidence vault.

## 6. Customer organisation access

Customers are responsible for provisioning and removing their own users. We provide tools and guidance; we do not manage customer workforce identity except when contracted for managed hosting.

## 7. Break-glass

Emergency credentials, if any, are sealed, monitored, and rotated after use.
