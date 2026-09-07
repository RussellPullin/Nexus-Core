# Security Overview — Nexus Core Solutions

**Effective date:** [INSERT DATE]  
**Audience:** Customers and prospects evaluating Nexus Core, Shifter, and Shifter Pro  

> Draft public summary. Not a penetration-test report or certification claim. Do not claim ISO/SOC unless independently certified.

---

## 1. Purpose

This overview describes how we protect customer and end-user data across the Nexus Core Solutions product suite.

## 2. Architecture (high level)

| Layer | Approach |
|-------|----------|
| Nexus Core web app | Authenticated SPA + API; organisation-scoped data |
| Shifter / Shifter Pro | Mobile apps with local offline storage and sync to organisation backends |
| Identity | Email/password and/or organisation identity providers (e.g. Microsoft Entra) where configured |
| Data stores | Managed cloud database/auth/storage (Supabase) and application hosts |

## 3. Controls we aim to maintain

1. **Encryption in transit** — HTTPS/TLS for web and API traffic.
2. **Encryption at rest** — provider-managed encryption for primary data stores.
3. **Access control** — role-based permissions within organisations; least privilege for staff admin access.
4. **Secrets management** — production secrets stored in host environment configuration, not in source control.
5. **Tenant isolation** — organisation-scoped data access patterns (per-customer projects/instances where deployed that way).
6. **Logging & monitoring** — operational logs for troubleshooting and security investigation.
7. **Backup & recovery** — backups per hosting/database provider configuration (document RPO/RTO in customer-facing SLA when finalised).
8. **Vulnerability practices** — dependency updates and responsible disclosure intake via email.

## 4. Customer shared responsibility

Customers are responsible for:

- user provisioning and timely offboarding;
- device security for mobile workers;
- accuracy of participant and billing data entered;
- their own NDIS, privacy, and employment compliance;
- configuring optional integrations (OAuth, OneDrive, Xero, SMS) securely.

## 5. Incident response

Suspected personal information breaches are handled under our [Data Breach Response Plan](../internal/data-breach-response-plan.md) and applicable Notifiable Data Breaches (NDB) scheme obligations.

## 6. Employee access

Nexus Core Solutions personnel access production data only when necessary for support, security, or operations, under confidentiality obligations.

## 7. Questions / questionnaires

Security questionnaires: nexuscoresolutions@outlook.com  
Subject: `Security review`
