/**
 * Central LLM service - Ollama only (privacy by design).
 * All AI features in the CRM use this service.
 * Uses OLLAMA_MODEL if set; otherwise auto-detects first available model from Ollama.
 */

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const AI_ENABLED = process.env.AI_ENABLED !== 'false';

/** When OLLAMA_MODEL is not set, we use the first model returned by Ollama (e.g. gemma3). */
let cachedFirstModel = null;

function getModel() {
  if (process.env.OLLAMA_MODEL?.trim()) return process.env.OLLAMA_MODEL.trim();
  return cachedFirstModel || null;
}

/**
 * Check if Ollama is reachable and cache first available model when OLLAMA_MODEL is not set.
 * @returns {Promise<boolean>}
 */
export async function isAvailable() {
  const { available } = await getConnectionStatus();
  return available;
}

/**
 * Check Ollama connection and return status plus optional error message for the UI.
 * @returns {Promise<{ available: boolean, error?: string }>}
 */
export async function getConnectionStatus() {
  if (!AI_ENABLED) return { available: false, error: 'AI is disabled (AI_ENABLED=false)' };
  const url = `${OLLAMA_BASE_URL}/api/tags`;
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      const models = data?.models;
      if (Array.isArray(models) && models.length > 0 && models[0]?.name) {
        cachedFirstModel = models[0].name;
      }
      return { available: true };
    }
    return { available: false, error: `Ollama returned ${res.status}. Check that the app is open.` };
  } catch (err) {
    const code = err?.code || err?.cause?.code;
    const message = err?.message || String(err);
    if (code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
      return { available: false, error: `Cannot reach Ollama at ${OLLAMA_BASE_URL}. Open the Ollama app on this machine.` };
    }
    if (code === 'ABORT_ERR' || message.includes('timeout')) {
      return { available: false, error: 'Connection timed out. Is Ollama running?' };
    }
    return { available: false, error: message || 'Connection failed.' };
  }
}

/**
 * Send a prompt to Ollama and get raw text response.
 * @param {string} prompt
 * @param {{ maxTokens?: number, temperature?: number }} [options]
 * @returns {Promise<string|null>} Response text, or null if AI disabled/unavailable
 */
export async function complete(prompt, options = {}) {
  if (!AI_ENABLED) return null;
  const model = getModel();
  if (!model) return null;
  const { maxTokens = 4096, temperature = 0.2 } = options;
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { num_predict: maxTokens, temperature }
      }),
      signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.response?.trim() || null;
  } catch (err) {
    console.error('LLM complete error:', err?.message || err);
    return null;
  }
}

/**
 * Send a prompt and parse the response as JSON.
 * Handles markdown code blocks (```json ... ```).
 * @param {string} prompt
 * @param {object} [options]
 * @returns {Promise<object|null>} Parsed JSON, or null
 */
export async function completeJson(prompt, options = {}) {
  const text = await complete(prompt, { ...options, temperature: 0.1 });
  if (!text) return null;
  try {
    let jsonStr = text.trim();
    const codeBlock = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) jsonStr = codeBlock[1].trim();
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

export function getConfig() {
  return { model: getModel(), baseUrl: OLLAMA_BASE_URL, enabled: AI_ENABLED };
}

export default { isAvailable, getConnectionStatus, complete, completeJson, getConfig };
