import { buildParticipantsCsvColumnMapPrompt } from '@nexus-shared/participantsCsvColumnMapPrompt.js';
import { participants } from './api';
import {
  resolveLocalOllamaBaseUrl,
  probeLocalOllama,
  pickFirstLocalModelName,
  generateLocalOllamaJson
} from './localOllama.js';

/**
 * When org feature ai_staff_local_ollama is on, map CSV headers via the user's local Ollama (browser → localhost).
 * @returns {Promise<Record<string, string>|null>}
 */
export async function tryClientSideParticipantsCsvMapping(file, user) {
  const base = resolveLocalOllamaBaseUrl(user);
  const probe = await probeLocalOllama(base);
  if (!probe.ok) return null;
  const model = await pickFirstLocalModelName(base);
  if (!model) return null;
  let headers;
  try {
    const peek = await participants.peekCsvHeaders(file);
    headers = peek?.headers;
  } catch {
    return null;
  }
  if (!Array.isArray(headers) || headers.length === 0) return null;
  const prompt = buildParticipantsCsvColumnMapPrompt(headers);
  const mapping = await generateLocalOllamaJson(base, model, prompt, 500);
  if (!mapping || typeof mapping !== 'object') return null;
  return mapping;
}
