# Email relay (Azure Function)

Sends mail **on behalf of the logged-in user** using their OAuth token (Gmail API or Microsoft Graph). The CRM refreshes tokens and POSTs `provider`, `accessToken`, `to`, `subject`, `text`, `from`, and optional `attachments` to this function.

## Deploy order

1. Deploy this Function App (Node 18+).
2. Optionally set `API_KEY` in Function configuration; if set, the CRM must send the same value as header `x-api-key` (`AZURE_EMAIL_API_KEY` in CRM `.env`).
3. Set `AZURE_EMAIL_FUNCTION_URL` on the CRM server to your function URL (e.g. `https://<app>.azurewebsites.net/api/sendEmail`).
4. Configure Google and Microsoft OAuth apps on the CRM server (see project root `.env.example`), then each user connects email under **Settings**.

## Local run

```bash
npm install
func start
```

Copy `local.settings.json.example` to `local.settings.json` and fill in values (that file is gitignored). Add `API_KEY` if you want to test the key gate locally.

## Legacy

The previous app-only Graph (client secret) flow was removed. All sends use delegated user tokens from the CRM.
