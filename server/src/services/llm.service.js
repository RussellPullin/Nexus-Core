/**
 * Central LLM service (Ollama). Off by default — set AI_ENABLED=true to opt in.
 * When disabled, all callers receive null / unavailable and should use heuristics or manual flows.
 */

import { fetchFlagsForOrg } from './orgFeatures.service.js';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const AI_ENABLED = process.env.AI_ENABLED === 'true';

function ollamaBaseLooksLikeLocalhost() {
  try {
    const u = new URL(OLLAMA_BASE_URL);
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

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
 * Whether the API may call server-side Ollama for this org context.
 * @param {string|null|undefined} orgId
 * @param {{ automationAllowServerLlm?: boolean }} [opts]
 */
export async function isServerLlmAllowed(orgId, opts = {}) {
  if (opts.automationAllowServerLlm) return true;
  if (orgId == null || orgId === '') return true;
  try {
    const { flags } = await fetchFlagsForOrg(orgId);
    if (flags.ai_staff_local_ollama) return false;
  } catch {
    return true;
  }
  return true;
}

/**
 * Server Ollama reachable AND allowed for this org (staff-local orgs => false unless automation).
 */
export async function isAvailableForOrg(orgId, opts = {}) {
  if (!(await isServerLlmAllowed(orgId, opts))) return false;
  return isAvailable();
}

/**
 * @param {string|null|undefined} orgId
 * @param {string} prompt
 * @param {object} [options] token/temperature options
 * @param {{ automationAllowServerLlm?: boolean }} [orgOpts]
 */
export async function completeJsonForOrg(orgId, prompt, options = {}, orgOpts = {}) {
  if (!(await isServerLlmAllowed(orgId, orgOpts))) return null;
  return completeJson(prompt, options);
}

/**
 * @param {string|null|undefined} orgId
 * @param {string} prompt
 * @param {object} [options]
 * @param {{ automationAllowServerLlm?: boolean }} [orgOpts]
 */
export async function completeForOrg(orgId, prompt, options = {}, orgOpts = {}) {
  if (!(await isServerLlmAllowed(orgId, orgOpts))) return null;
  return complete(prompt, options);
}

/**
 * Check Ollama connection and return status plus optional error message for the UI.
 * @returns {Promise<{ available: boolean, error?: string, warning?: string }>}
 */
export async function getConnectionStatus() {
  if (!AI_ENABLED) return { available: false, error: 'LLM is disabled. Set AI_ENABLED=true on the server only if you intentionally use Ollama.' };
  // Cloud (e.g. Fly): default OLLAMA_URL is localhost — probing wastes time; skip unless AI_PROBE_SERVER_OLLAMA is true.
  if (
    process.env.NODE_ENV === 'production' &&
    ollamaBaseLooksLikeLocalhost() &&
    process.env.AI_PROBE_SERVER_OLLAMA !== 'true'
  ) {
    return {
      available: false,
      error:
        'Server-side Ollama is not used on this host (localhost). Set OLLAMA_BASE_URL to an Ollama the API can reach, or set AI_PROBE_SERVER_OLLAMA=true to force a probe.'
    };
  }
  const url = `${OLLAMA_BASE_URL}/api/tags`;
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      const data = await res.json();
      const models = data?.models;
      if (Array.isArray(models) && models.length > 0 && models[0]?.name) {
        cachedFirstModel = models[0].name;
      }
      const noModels =
        !Array.isArray(models) ||
        models.length === 0 ||
        !models.some((m) => m && String(m.name || '').trim());
      return {
        available: true,
        ...(noModels
          ? {
              warning:
                'Ollama is running but no models are installed. In Terminal run: ollama pull llama3.2 (or set OLLAMA_MODEL in server .env after pulling that model).'
            }
          : {})
      };
    }
    return { available: false, error: `Ollama returned ${res.status}. Check that the app is open.` };
  } catch (err) {
    const code = err?.code || err?.cause?.code;
    const message = err?.message || String(err);
    if (code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
      if (ollamaBaseLooksLikeLocalhost()) {
        return {
          available: false,
          error: `Cannot reach Ollama at ${OLLAMA_BASE_URL} from the API server. On cloud hosting, localhost is the server machine, not your laptop. Options: enable org feature "AI: Ollama on staff computers" and use Settings → Ollama on this computer; or set OLLAMA_BASE_URL to an Ollama the API can reach; or run Nexus and Ollama on the same host.`
        };
      }
      return {
        available: false,
        error: `Cannot reach Ollama at ${OLLAMA_BASE_URL}. Run Ollama on the same machine (or network) as the Nexus API, or change OLLAMA_BASE_URL.`
      };
    }
    if (code === 'ABORT_ERR' || message.includes('timeout')) {
      return {
        available: false,
        error: ollamaBaseLooksLikeLocalhost()
          ? `Timed out reaching ${OLLAMA_BASE_URL}. If the API runs in the cloud, localhost Ollama on your PC will not work — see Settings (per-computer Ollama) or set OLLAMA_BASE_URL.`
          : 'Connection timed out. Is Ollama running?'
      };
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

export default {
  isAvailable,
  isServerLlmAllowed,
  isAvailableForOrg,
  completeForOrg,
  completeJsonForOrg,
  getConnectionStatus,
  complete,
  completeJson,
  getConfig
};
