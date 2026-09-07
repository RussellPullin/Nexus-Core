# App Store Privacy Labels — Shifter (worksheet)

**Bundle ID:** `com.pristinelifestylesolutions.shifter`  
**App Store ID:** `6760079491`  
**Privacy policy URL (set in App Store Connect):** `https://nexuscoresolutions.com.au/privacy/shifter` (publish draft first)

> Internal worksheet to align App Store Connect “App Privacy” answers with actual practices. Re-audit when SDKs change.

---

## Recommended declarations (review before submitting)

### Data linked to user identity

| Data type | Examples in Shifter | Purpose | Tracking? |
|-----------|---------------------|---------|-----------|
| Contact Info — Name | Profile name | App functionality | No |
| Contact Info — Email Address | Login email | App functionality | No |
| Identifiers — User ID | Auth user id | App functionality | No |
| User Content — Other User Content | Progress notes, incidents, shift details | App functionality | No |
| User Content — Photos or Videos | Receipt images | App functionality | No |
| Usage Data — Product Interaction | Feature use (if collected) | Analytics / App functionality | No (unless ad tracking added — do not) |

### Data not linked / diagnostics

| Data type | Purpose |
|-----------|---------|
| Diagnostics — Crash Data | App functionality / analytics |
| Diagnostics — Performance Data | App functionality / analytics |

### Permissions narrative (Review Notes)

- Camera / Photos: receipt capture only.
- No third-party advertising SDK intended.
- Offline storage of shift content on device.

### Current App Store listing gaps to fix

1. Confirm privacy nutrition labels match this worksheet (current public listing appears under-declared relative to notes/receipts).
2. Ensure Privacy Policy URL resolves to the Shifter-specific policy (not a “coming soon” CRM stub).
3. Add Account Deletion URL in App Privacy / support links.
