# App Store Privacy Labels — Shifter Pro (worksheet)

**Bundle ID:** `com.pristinelifestylesolutions.shifterpro`  
**App Store ID:** `6776075460`  
**Privacy policy URL:** `https://nexuscoresolutions.com.au/privacy/shifter-pro`  
**Terms of Use (EULA) URL:** `https://nexuscoresolutions.com.au/terms/shifter-pro`

> Internal worksheet for App Store Connect. Broader than Shifter because of invoicing, participants, and financial features.

---

## Recommended declarations (review before submitting)

### Data linked to identity

| Data type | Examples | Purpose | Tracking? |
|-----------|----------|---------|-----------|
| Contact Info — Name / Email | Profile, login | App functionality | No |
| Identifiers — User ID | Auth id | App functionality | No |
| User Content — Other User Content | Notes, incidents, participant fields | App functionality | No |
| User Content — Photos or Videos | Receipts | App functionality | No |
| Financial Info — Other Financial Info | Invoice/P&L figures entered in-app | App functionality | No |
| Purchases — Purchase History | Subscription entitlement (via Apple) | App functionality | No |

### Diagnostics

Crash / performance data for stability — typically **not linked** for analytics SDKs if using stock Expo/Firebase-style crash reporting without advertising identity. Confirm SDK config.

### Subscription metadata for App Store Connect

Ensure the subscription group lists:

- Title, length, price
- Privacy Policy URL (required)
- Terms of Use (EULA) URL (required for auto-renewable subs)

### Gaps observed at research time

1. `privacyPolicyUrl` empty in iTunes lookup — set explicitly in App Store Connect.
2. Listing currently points at Apple Standard EULA — add custom Terms URL above.
3. Align nutrition labels with actual participant + financial data handling (likely under-declared if copied from a thinner app).
4. Add account deletion link.
