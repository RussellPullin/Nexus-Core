# Org admin: local AI (Ollama on staff computers)

This page is for **organisation administrators** and **IT**. Technical staff runbook: [internal/ollama-deployed-nexus-runbook.md](../internal/ollama-deployed-nexus-runbook.md).

## What you are enabling

Staff run a small app (**Ollama**) on their own Windows or Mac. Their **browser** sends only the CSV header-mapping step to Ollama on that same machine — useful when your Nexus site is hosted in the cloud and you do not want to run models on the server.

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
4. **Settings → Ollama** → **Test** until it shows connected.

## Server AI vs this computer

- **This computer:** CSV AI mapping from the browser (when the feature is on).
- **API server:** Some other tools need Ollama (or another backend) on the **same network as the server**. That is configured by your host with `OLLAMA_BASE_URL`, not by staff PCs.

If something still fails, send staff the internal runbook link above or **Settings → Ollama** screenshots (no secrets in screenshots).

## Future (not in this release)

Per-organisation **cloud API keys** (OpenAI, Azure OpenAI, etc.) so each org pays its own vendor is a separate roadmap item and is not required for Ollama on staff computers.
