/**
 * OpenAI-compatible Chat Completions (JSON). Used for per-org API keys and optional EXTERNAL_LLM_* env.
 */

const DEFAULT_BASE = 'https://api.openai.com';

function trimBase(url) {
  const s = String(url || '').trim().replace(/\/$/, '');
  return s || DEFAULT_BASE;
}

export function maskApiKey(key) {
  const s = String(key || '').trim();
  if (!s) return null;
  if (s.length <= 8) return '…configured';
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

function safeModelId(model) {
  const m = String(model || 'gpt-4o-mini').trim();
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(m)) return 'gpt-4o-mini';
  return m;
}

/**
 * @param {{ apiKey: string, model?: string|null, baseUrl?: string|null, prompt: string, maxTokens?: number }} opts
 * @returns {Promise<object>} Parsed JSON from assistant message
 */
export async function chatCompletionsJson(opts) {
  const apiKey = String(opts.apiKey || '').trim();
  if (!apiKey) {
    const err = new Error('Missing API key');
    err.status = 400;
    throw err;
  }
  const model = safeModelId(opts.model);
  const base = trimBase(opts.baseUrl || DEFAULT_BASE);
  const url = `${base}/v1/chat/completions`;
  const maxTokens = Math.min(Math.max(opts.maxTokens ?? 3500, 200), 8192);

  const body = {
    model,
    messages: [
      { role: 'system', content: 'You output only valid JSON objects as requested by the user. No markdown fences.' },
      { role: 'user', content: opts.prompt }
    ],
    temperature: 0.1,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' }
  };

  const doFetch = async (useJsonFormat) => {
    const b = { ...body };
    if (!useJsonFormat) delete b.response_format;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(b),
      signal: AbortSignal.timeout(90000)
    });
    const text = await res.text();
    return { res, text };
  };

  let { res, text } = await doFetch(true);
  if (!res.ok && res.status === 400 && /response_format|json_object/i.test(text)) {
    ({ res, text } = await doFetch(false));
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text);
      if (j.error?.message) msg = j.error.message;
    } catch {
      /* keep */
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error('Invalid JSON from LLM host');
    err.status = 502;
    throw err;
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    const err = new Error('Empty model response');
    err.status = 502;
    throw err;
  }

  let jsonStr = content.trim();
  const codeBlock = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) jsonStr = codeBlock[1].trim();
  try {
    return JSON.parse(jsonStr);
  } catch {
    const err = new Error(`Model returned non-JSON (first 240 chars): ${jsonStr.slice(0, 240)}`);
    err.status = 502;
    throw err;
  }
}

/** @returns {{ apiKey: string, model: string, baseUrl: string } | null} */
export function externalLlmFromEnv() {
  const apiKey = process.env.EXTERNAL_LLM_API_KEY?.trim();
  const baseUrl = process.env.EXTERNAL_LLM_BASE_URL?.trim();
  if (!apiKey || !baseUrl) return null;
  const model = process.env.EXTERNAL_LLM_MODEL?.trim() || 'gpt-4o-mini';
  return { apiKey, model, baseUrl };
}
