# Internal runbook: Ollama on a staff PC with deployed (HTTPS) Nexus

Use this when Nexus runs in the cloud (e.g. Fly) and staff use **Chrome or Edge** on Windows or Mac. Safari often blocks local-network calls.

## What works after setup

- **Browser → Ollama on this PC** for participant CSV column mapping (and related flows that send `llm_column_mapping_json` from the client).
- This does **not** give the cloud API access to Ollama on the laptop. Server-only features (some PDF/Excel AI) still need `OLLAMA_BASE_URL` reachable **from the API server**, or a future cloud LLM integration.

## Preconditions

1. Org has **AI: Ollama on staff computers** enabled in Supabase `org_features`, **or** the server has `AI_STAFF_LOCAL_OLLAMA=true` (all orgs).
2. Ollama installed; at least one model pulled, e.g. `ollama pull llama3.2`.

## One-time per PC (HTTPS Nexus)

### Value for `OLLAMA_ORIGINS`

Must include the **exact** site origin staff use in the browser, for example `https://crm.example.com` (no trailing slash). Staff can copy it from **Settings → Ollama → “Address to use in Ollama (copy exactly)”**.

### Windows (user environment variable)

1. Quit Ollama completely (system tray → Quit).
2. Start → search **environment variables** → **Edit environment variables for your account**.
3. User variables → **New** → Name: `OLLAMA_ORIGINS` → Value: paste the Nexus origin → OK.
4. Start Ollama again.
5. Nexus → **Settings → Ollama** → leave URL `http://127.0.0.1:11434` unless IT says otherwise → **Save** → **Test** → expect “Connected”.

### Mac

1. Quit Ollama (menu bar llama icon → Quit Ollama).
2. Terminal:

   `launchctl setenv OLLAMA_ORIGINS 'https://your-nexus-origin'`

   (Use the same origin string as in Settings.)

3. Open Ollama again. Note: may need repeating after full logout/reboot; plist or shell profile can make it persistent — coordinate with IT if required.

## Verification checklist

| Step | Pass? |
|------|--------|
| Settings → Ollama → **Test** shows Connected and at least one model | |
| Sidebar **AI** hover tooltip mentions “This computer: Ollama OK” | |
| Participants → Import CSV → enable AI → **Parse & Preview** shows “AI mapped columns” for a messy CSV | |

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Probe fails immediately on HTTPS | `OLLAMA_ORIGINS` missing/wrong; Ollama not restarted after setting it |
| Works in HTTP dev but not production | Origin must match production URL exactly (www vs non-www, correct scheme) |
| Intermittent / “blocked” in Safari | Use Chrome or Edge (Private Network Access / localhost policy) |
| `127.0.0.1` vs `localhost` | Try the other in Settings URL; client retries both |
| Feature disabled in Settings | Org flag off and `AI_STAFF_LOCAL_OLLAMA` not true — enable in Feature flags or env |

## References in repo

- Client probe: `client/src/lib/localOllama.js`
- Settings UI: `client/src/pages/SettingsPage.jsx`
- Server flag merge: `server/src/services/orgFeatures.service.js`
- AI status API: `GET /api/ai/status` in `server/src/index.js`
