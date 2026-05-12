/**
 * Legacy hook for browser-side CSV column mapping via local LLM — disabled (returns null).
 * Use manual column mapping in the Participants import UI.
 * @returns {Promise<null>}
 */
export async function tryClientSideParticipantsCsvMapping() {
  return null;
}
