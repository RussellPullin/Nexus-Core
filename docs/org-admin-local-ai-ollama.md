# Org admin: local AI (Ollama on staff computers)

This page is for **organisation administrators** and **IT**. Technical staff runbook: [internal/ollama-deployed-nexus-runbook.md](../internal/ollama-deployed-nexus-runbook.md).

## Policy when this feature is on

If **AI: Ollama on staff computers** is enabled (`ai_staff_local_ollama`, or deployment-wide `AI_STAFF_LOCAL_OLLAMA=true`):

- **Each staff member** who wants AI in the browser must install and run **Ollama on that same computer** (Chrome or Edge recommended).
- **Signed-in staff work** (participant CSV AI mapping, plan PDF parsing with AI, intake form parsing with AI, plan manager statement with AI) **does not** use Ollama on the Nexus API server, even if the host has `OLLAMA_BASE_URL` set. The server skips those LLM calls so data stays on the device that runs the browser (except the normal upload of files to Nexus for processing).
- **Scheduled / API-key Excel sync** (`POST /api/sync/from-excel` with `CRM_API_KEY` and `org_id`) may still use **server-side** Ollama if your host configured `OLLAMA_BASE_URL`, because there is no browser in that job. That path is for automation only, not for a person’s laptop.

**Nexus does not install Ollama for you.** Each machine needs Ollama + one model + permission for your Nexus website to talk to localhost.

## Turn the feature on (choose one)

### A. Per organisation (Supabase)

A **super admin** opens Nexus → **Admin → Feature flags**, finds your organisation, and enables **AI: Ollama on staff computers** (`ai_staff_local_ollama`).

Use this when only some orgs on a shared Nexus should see the feature.

### B. Entire server (hosting provider)

Whoever runs the API sets environment variable:

`AI_STAFF_LOCAL_OLLAMA=true`

Then **every** organisation on that Nexus deployment gets the feature without a Supabase toggle.

Use this for a dedicated customer deployment where all orgs should have the same behaviour.

## What each staff member does (once per computer)

1. Install Ollama from [ollama.com](https://ollama.com) and pull a model (e.g. `llama3.2`).
2. Allow the Nexus website to talk to Ollama:
   - **Windows:** user env var `OLLAMA_ORIGINS` = your Nexus site URL (exact copy from Nexus **Settings → Ollama**).
   - **Mac:** run the `launchctl setenv OLLAMA_ORIGINS '…'` line shown in **Settings → Ollama**, then restart Ollama.
3. Open Nexus in **Chrome or Edge**.
4. **Settings → Ollama** → **Test** until it shows connected. The sidebar **AI** indicator is green only when this computer’s Ollama is OK (not when only the server has Ollama).

## Server AI vs this computer

- **This computer:** Required for staff-facing AI when the org uses per-device mode (see policy above).
- **API server:** Optional **only** for unattended jobs (e.g. cron calling the sync API with `CRM_API_KEY`). Staff should not rely on server Ollama for interactive AI when per-device mode is on.

If something still fails, send staff the internal runbook link above or **Settings → Ollama** screenshots (no secrets in screenshots).

## Future (not in this release)

Per-organisation **cloud API keys** (OpenAI, Azure OpenAI, etc.) so each org pays its own vendor is a separate roadmap item and is not required for Ollama on staff computers.
