# Encryption & Cryptography Standard

**Document ID:** STD-ENC-001  
**Version:** 0.1 Draft  
**Effective date:** [INSERT DATE]  
**Owner:** [Engineering]  

---

## 1. Purpose

Define baseline cryptographic expectations for Nexus Core Solutions systems.

## 2. In transit

- TLS for all public HTTPS endpoints  
- Disable obsolete protocols/ciphers on services we control  

## 3. At rest

- Rely on managed cloud encryption for primary databases and object storage  
- Encrypt device disks for company laptops where available  

## 4. Secrets & credentials

- Store production secrets in host secret/env mechanisms, not git  
- Hash passwords with modern algorithms via auth platform defaults  
- Rotate credentials after suspected compromise  

## 5. Mobile

- Prefer platform secure storage for tokens  
- Protect offline databases with device-level security expectations communicated to customers  

## 6. Key management

Where we do not hold raw DEKs (provider-managed), document the provider’s responsibility. Avoid inventing custom crypto.
