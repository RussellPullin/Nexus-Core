# Publishing checklist — Legal pack

Use this after legal review of `docs/legal/`.

## Before publish

- [ ] Confirm contracting **legal entity name**, ABN, registered address
- [ ] Replace all `[LEGAL ENTITY NAME]`, `[ABN]`, `[INSERT DATE]`, `[INSERT]` placeholders
- [ ] Decide branded privacy email (replace outlook address if desired)
- [ ] Confirm live subprocessors + regions in `company/subprocessors.md`
- [ ] Confirm analytics/cookies actually used on the marketing site
- [ ] Lawyer review: Customer Terms, DPA, Privacy policies, Shifter Pro IAP terms

## Marketing site routes

- [ ] `/privacy` ← company hub
- [ ] `/privacy/nexus-core`, `/privacy/shifter`, `/privacy/shifter-pro`
- [ ] `/terms`, `/terms/nexus-core`, `/terms/shifter`, `/terms/shifter-pro`
- [ ] `/dpa`, `/security`, `/cookies`, `/subprocessors`, `/aup`
- [ ] `/legal/account-deletion`
- [ ] Footer links on all pages
- [ ] Remove “Pristine Lifestyle Solutions” operator text from live `/privacy`

## App Store Connect

### Shifter (`6760079491`)

- [ ] Privacy Policy URL → `/privacy/shifter`
- [ ] Account deletion information URL → `/legal/account-deletion`
- [ ] Refresh App Privacy nutrition labels using worksheet

### Shifter Pro (`6776075460`)

- [ ] Privacy Policy URL → `/privacy/shifter-pro`
- [ ] Terms of Use (EULA) URL → `/terms/shifter-pro`
- [ ] Account deletion URL → `/legal/account-deletion`
- [ ] Subscription metadata privacy + terms URLs
- [ ] Refresh App Privacy nutrition labels using worksheet

## Customer ops

- [ ] Attach DPA + Customer Terms to trial/paid signup flow
- [ ] Store executed agreements
- [ ] Schedule annual review reminder
