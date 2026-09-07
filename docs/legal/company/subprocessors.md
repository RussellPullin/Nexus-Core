# Subprocessor List — Nexus Core Solutions

**Effective date:** [INSERT DATE]  
**Last reviewed:** [INSERT DATE]  
**Related:** [Privacy Policy](privacy-policy.md), [Data Processing Addendum](../nexus-core/data-processing-addendum.md)

> Draft. Confirm regions and exact products in use before publishing. Notify customers of material changes as required by your DPA.

We use the following third-party subprocessors to help deliver Nexus Core, Shifter, and Shifter Pro:

| Subprocessor | Purpose | Typical data | Primary region (confirm) | Products |
|--------------|---------|--------------|--------------------------|----------|
| **Supabase** | Database, auth, storage, edge functions | Account, org, shift, note, and related app data | Australia (preferred) / as configured per project | Nexus Core, Shifter, Shifter Pro |
| **Microsoft Azure** | Email/API functions, optional Entra sign-in | Auth tokens, email content for notifications | As configured | Nexus Core, Shifter (where enabled) |
| **Expo / EAS** | Mobile build & update delivery | Device/install metadata; not customer clinical content by default | As configured by Expo | Shifter, Shifter Pro |
| **Apple App Store** | Distribution & in-app purchases (Shifter Pro) | Apple ID purchase receipts (handled by Apple) | Apple regions | Shifter Pro |
| **Hosting provider** (e.g. Railway / Fly.io — confirm live stack) | Application hosting for Nexus Core | Application data in transit/at rest on hosts | Confirm | Nexus Core |
| **Email delivery** (e.g. Resend / SendGrid — confirm) | Transactional email | Email addresses, invite content | Confirm | Nexus Core, Shifter invites |
| **Microsoft OneDrive** (customer-optional) | Customer-directed Excel sync | Shift exports if customer enables | Customer’s Microsoft tenant | Shifter / integrations |
| **Xero** (customer-optional) | Accounting sync if enabled | Invoice-related data | Confirm | Nexus Core (optional) |
| **Twilio** (customer-optional) | SMS notifications if enabled | Phone numbers, SMS content | Confirm | Nexus Core (optional) |

### Notes

1. **Customer-controlled connectors** (OneDrive, Xero, Microsoft/Google OAuth) process data under the customer’s own accounts; those vendors are not Nexus Core Solutions subprocessors for that data in the same way as our infrastructure.
2. We will update this page when we add or replace material subprocessors.
3. Customers requiring advance notice of changes should rely on the notice provisions in the [DPA](../nexus-core/data-processing-addendum.md).

### Contact

nexuscoresolutions@outlook.com — Subject: `Subprocessors`
