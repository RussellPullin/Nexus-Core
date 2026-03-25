# Nexus Core (NDIS shift scheduling)

A web app for scheduling staff shifts with a participant database, NDIS pricing, email/SMS, calendar export, and invoicing. **Each organisation runs its own instance** with its own hosting, database, Supabase project, and API keys. No deployment depends on the vendor’s laptop or private network.

## Vendor-managed clients (least work for the customer)

The long env list is **for whoever operates the server**, not for end users. To avoid burdening a new NDIS provider:

1. **You (Spring 2) provision everything** — Create their **Railway** (or other) service, **Supabase** project, volume, and **paste all variables** in the host dashboard. Generate a session secret with **`npm run deploy:gen-secret`**.
2. **They only receive** — The **app URL**, and an **invite / first admin account** (Supabase or your onboarding). They do **not** need GitHub, `.env` files, or API keys unless you choose self-hosting (below).
3. **Reuse your own infrastructure where it is acceptable** — The same **`AZURE_EMAIL_FUNCTION_URL`** (your Function App) and one **Google/Microsoft OAuth app** can serve many customers **if** you register every customer redirect URL (e.g. `https://<their-subdomain>.yourdomain.com/...`) in each provider console. **Supabase** is still usually **one project per customer** (data isolation) unless you later build true multi-tenant RLS in a single project.
4. **Per-customer values you almost always set for them** — `SESSION_SECRET`, `OAUTH_PUBLIC_URL`, `FRONTEND_ORIGIN`, `DATA_DIR`, `DATABASE_PATH`, `SUPABASE_*`, `VITE_SUPABASE_*`, and optional `COMPANY_NAME` defaults. They never type these.

Self-hosting (customer runs their own Railway) is optional; use the checklist in **`.env.example`** only in that case.

## Self-hosting (other organisations)

1. **Clone** this repository (or your fork). You do not need access to anyone else’s machine.
2. **Environment**
   - Copy **`.env.example`** → **`.env`** at the repo root (server + OAuth URLs, secrets, optional integrations).
   - Copy **`client/.env.example`** → **`client/.env`** (Supabase anon key and URL for the browser — Vite does not read the root `.env`).
3. **Supabase** — Create a dedicated Supabase project, run migrations under `supabase/migrations/`, and put URL/keys in `.env` and `client/.env` as documented in `.env.example`.
4. **Production**
   - Set **`NODE_ENV=production`** and build the SPA before or during deploy: **`npm run deploy:build`** (or your CI equivalent).
   - Start the API + static UI: **`npm run deploy:start`** (or `NODE_ENV=production npm run start:prod`).
   - Set a strong **`SESSION_SECRET`** (32+ characters); the server **refuses to start** in production without it.
   - Set **`OAUTH_PUBLIC_URL`** and **`FRONTEND_ORIGIN`** to your real public HTTPS URLs so OAuth and email links work.
5. **Persistent data** — Use a disk/volume for SQLite and uploads; set **`DATA_DIR`** and **`DATABASE_PATH`** as in `.env.example` (e.g. Railway volume at `/data`).
6. **Optional integrations** (each org configures its own): Azure email function, Twilio, Xero, Microsoft/Google OAuth, OneDrive Excel pull, Shifter Supabase, etc.

Secrets must never be committed. **`azure-email-function/local.settings.json`** is gitignored; use **`local.settings.json.example`**.

## Features

- **Client Database**: Participants with NDIS plans, contacts, goals, documents, case notes
- **Directory**: Organisations (plan managers, providers) and contacts
- **Staff Management**: Add staff with email/SMS notification preferences
- **NDIS Pricing**: Import CSV or add line items manually; link to shifts
- **Shift Scheduling**: Create shifts, attach NDIS line items, mark complete
- **Notifications**: Email (SMTP) and SMS (Twilio) when shifts are scheduled
- **Calendar**: ICS export for shifts
- **Invoicing**: Auto-generate NDIS-compliant invoices when shifts are completed

## Local development

1. **Node 20+** (see `package.json` `engines`).

2. Install dependencies:
   ```bash
   npm install
   cd client && npm install && cd ..
   ```

3. Copy **`.env.example`** → **`.env`** and **`client/.env.example`** → **`client/.env`**, then fill in values (see comments in those files). Email sending uses the Azure Function + OAuth flow described in `.env.example`, not classic `SMTP_*` in this repo.

4. Run the app:
   ```bash
   npm run dev
   ```
   This starts the API (default **3080** in the `server` script) and Vite (see **`client/vite.config.js`** for the dev port, often **5174**).

5. Open the URL Vite prints in the terminal (e.g. `http://localhost:5174`).

## Progress Notes App Integration

Shifts and progress notes from the mobile Progress Notes App can be pushed to this app when CRM integration is enabled.

1. Set `CRM_API_KEY` in `.env` (any secure random string).
2. In the Progress Notes App Admin screen, enable **Schedule Shift App Link** and enter:
   - **Webhook URL**: `https://your-domain.com/api/webhooks/progress-app` (or `http://localhost:3001/api/webhooks/progress-app` for local dev)
   - **API Key**: The same value as `CRM_API_KEY`
3. On each sync in the Progress Notes App, shift data is forwarded to this webhook. Matched participant/staff names create completed shifts; unmatched entries appear in Coordinator Tasks for manual linking.

## Project Structure

- `client/` - React + Vite frontend
- `server/` - Express API, SQLite database
- `database/schema.sql` - Database schema
- `data/` - SQLite DB file and uploads (created automatically)

## API Endpoints

- `GET/POST /api/participants` - Participants
- `GET/POST /api/organisations` - Organisations and contacts
- `GET/POST /api/staff` - Staff
- `GET/POST /api/shifts` - Shifts
- `GET/POST /api/ndis` - NDIS line items (POST /api/ndis/import for CSV)
- `GET /api/invoices` - Invoices
