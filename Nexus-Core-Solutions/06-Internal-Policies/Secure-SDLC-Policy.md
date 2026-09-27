# Secure Development Lifecycle (SDLC) Policy

**Document ID:** POL-SDLC-001  
**Version:** 0.1 Draft  
**Effective date:** [INSERT DATE]  
**Owner:** [Engineering lead]  

---

## 1. Purpose

Reduce security defects in Nexus Core, Shifter, Shifter Pro, and related services.

## 2. Requirements

1. Source code stored in controlled repositories with access restrictions.  
2. Secrets never committed; use environment configuration and secret stores.  
3. Dependencies kept reasonably current; known critical CVEs addressed promptly.  
4. Changes reviewed before production deploy where more than one person is available; solo founders document self-review checklist.  
5. Authentication, authorisation, and tenant isolation considered for every feature touching customer data.  
6. Input validation and safe handling of uploads (receipts, documents).  
7. Error messages do not leak secrets.  
8. Security-relevant bugs tracked to closure.

## 3. Environments

Prefer separation of development and production data. Do not use real participant data in local/dev without explicit justification and safeguards.

## 4. Mobile apps

Store offline data carefully; minimise sensitive caching; follow platform secure-storage guidance for tokens.

## 5. Third-party code / AI assistance

Code suggestions (including AI) are reviewed before merge; license and secret-leak checks remain human responsibilities.
