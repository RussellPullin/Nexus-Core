const DEFAULT_BASE = 'http://127.0.0.1:11434';

function withTimeout(ms) {
  return AbortSignal.timeout(ms);
}

/** Alternate loopback host if one form is blocked (127.0.0.1 vs localhost). */
function alternateLoopbackBase(base) {
  const b = String(base).replace(/\/$/, '');
  if (b.includes('127.0.0.1')) return b.replace('127.0.0.1', 'localhost');
  if (b.includes('localhost')) return b.replace('localhost', '127.0.0.1');
  return null;
}

/**
 * HTTPS pages calling http://127.0.0.1: Chromium needs targetAddressSpace (Local Network Access).
 * @param {AbortSignal} signal
 * @param {boolean} useTargetAddressSpace
 */
function tagsFetchInit(signal, useTargetAddressSpace) {
  /** @type {RequestInit & { targetAddressSpace?: string }} */
  const init = { method: 'GET', signal };
  if (useTargetAddressSpace) init.targetAddressSpace = 'local';
  return init;
}

async function fetchTagsJson(baseUrl, useTargetAddressSpace) {
  const base = String(baseUrl).replace(/\/$/, '');
  const signal = withTimeout(6000);
  const init = tagsFetchInit(signal, useTargetAddressSpace);
  const res = await fetch(`${base}/api/tags`, init);
  if (!res.ok) return null;
  return res.json();
}

/**
 * Try several strategies: targetAddressSpace on/off, 127.0.0.1 vs localhost.
 */
async function probeTagsWithRetries(primaryBase) {
  const bases = [primaryBase];
  const alt = alternateLoopbackBase(primaryBase);
  if (alt && alt !== primaryBase) bases.push(alt);

  for (const base of bases) {
    for (const useTs of [true, false]) {
      try {
        const data = await fetchTagsJson(base, useTs);
        if (data && typeof data === 'object') {
          const models = Array.isArray(data?.models) ? data.models : [];
          return { ok: true, models };
        }
      } catch {
        /* next */
      }
    }
  }
  return null;
}

export function resolveLocalOllamaBaseUrl(user) {
  const u = user?.ollama_local_base_url;
  if (u && String(u).trim()) return String(u).trim().replace(/\/$/, '');
  return DEFAULT_BASE;
}

/**
 * Probe Ollama from the browser. Set OLLAMA_ORIGINS on the Ollama host to include your Nexus site URL.
 * @param {string} [baseUrl]
 * @returns {Promise<{ ok: boolean, models?: { name: string }[], error?: string }>}
 */
export async function probeLocalOllama(baseUrl = DEFAULT_BASE) {
  const primary = String(baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  try {
    const result = await probeTagsWithRetries(primary);
    if (result?.ok) {
      return { ok: true, models: result.models };
    }
    const originHint =
      typeof window !== 'undefined' && window.location?.origin
        ? ` Paste this exact value into OLLAMA_ORIGINS (then restart Ollama): ${window.location.origin}`
        : '';
    return {
      ok: false,
      error:
        "Couldn't reach Ollama. Is it running? If this site is HTTPS, set OLLAMA_ORIGINS to this site's URL in Ollama's environment, then restart Ollama (see Settings → Ollama). Use Chrome or Edge." +
        originHint
    };
  } catch {
    const originHint =
      typeof window !== 'undefined' && window.location?.origin
        ? ` Paste this exact value into OLLAMA_ORIGINS (then restart Ollama): ${window.location.origin}`
        : '';
    return {
      ok: false,
      error:
        "Couldn't reach Ollama. Is it running? If this site is HTTPS, set OLLAMA_ORIGINS to this site's URL in Ollama's environment, then restart Ollama (see Settings → Ollama). Use Chrome or Edge." +
        originHint
    };
  }
}

function generateFetchInit(body, signal, useTargetAddressSpace) {
  /** @type {RequestInit & { targetAddressSpace?: string }} */
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(body)
  };
  if (useTargetAddressSpace) init.targetAddressSpace = 'local';
  return init;
}

async function postGenerateOnce(base, model, prompt, maxTokens, useTargetAddressSpace) {
  const signal = withTimeout(120000);
  const body = {
    model,
    prompt,
    format: 'json',
    stream: false,
    options: { num_predict: maxTokens, temperature: 0.1 }
  };
  return fetch(`${base}/api/generate`, generateFetchInit(body, signal, useTargetAddressSpace));
}

/**
 * @param {string} baseUrl
 * @param {string} model
 * @param {string} prompt
 * @param {number} [maxTokens]
 */
export async function generateLocalOllamaJson(baseUrl, model, prompt, maxTokens = 500) {
  const primary = String(baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  const bases = [primary];
  const alt = alternateLoopbackBase(primary);
  if (alt && alt !== primary) bases.push(alt);

  let lastErr = null;
  for (const base of bases) {
    for (const useTs of [true, false]) {
      try {
        const res = await postGenerateOnce(base, model, prompt, maxTokens, useTs);
        if (!res.ok) {
          lastErr = new Error(String(res.status));
          continue;
        }
        const data = await res.json();
        const text = (data.response || '').trim();
        if (!text) return null;
        try {
          let jsonStr = text;
          const codeBlock = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (codeBlock) jsonStr = codeBlock[1].trim();
          return JSON.parse(jsonStr);
        } catch {
          const snippet = text.replace(/\s+/g, ' ').slice(0, 420);
          throw new Error(
            snippet
              ? `Ollama returned non-JSON (format=json was requested). First part of response: ${snippet}`
              : 'Ollama returned empty or non-JSON output.'
          );
        }
      } catch (e) {
        lastErr = e;
      }
    }
  }
  if (lastErr) throw lastErr instanceof Error ? lastErr : new Error("Couldn't connect.");
  return null;
}

export async function pickFirstLocalModelName(baseUrl = DEFAULT_BASE) {
  const p = await probeLocalOllama(baseUrl);
  if (!p.ok || !p.models?.length) return null;
  const named = p.models.find((m) => m && String(m.name || '').trim());
  return named ? String(named.name).trim() : null;
}
