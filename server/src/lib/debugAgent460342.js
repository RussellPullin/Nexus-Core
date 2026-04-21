/**
 * Debug-mode NDJSON ingest (session 460342). Do not log secrets or PII.
 */
export function agentDebugIngest460342(payload) {
  fetch('http://127.0.0.1:7339/ingest/6f75df5b-6483-4dc8-b6b9-c6a62b783bb9', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '460342' },
    body: JSON.stringify({
      sessionId: '460342',
      timestamp: Date.now(),
      ...payload,
    }),
  }).catch(() => {});
}
