/**
 * Phase 4: Public participant self-service intake tokens.
 *
 * Token lifecycle:
 *   1. Coordinator calls issueIntakeToken(participantId) — returns the *raw* token (shown
 *      once in the email/link); the DB stores only the SHA-256 hash.
 *   2. Participant opens /intake/<token>; resolveIntakeToken(token) validates + returns the
 *      record, bumps last_used_at.
 *   3. Participant saves fields incrementally via upsertFieldsByToken(token, fields).
 *   4. On submit, completeIntakeToken(token) marks the row complete and feeds the data
 *      into participant_intake_fields via the existing onboarding helper.
 */
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { upsertIntakeFields, initializeParticipantOnboarding } from './onboarding.service.js';

const DEFAULT_TTL_DAYS = 30;

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

/**
 * @param {object} params
 * @param {string} params.participantId
 * @param {string|null} [params.organisationId]
 * @param {string|null} [params.issuedByUserId]
 * @param {number} [params.ttlDays]
 * @returns {{ token: string, expires_at: string, record_id: string }}
 */
export function issueIntakeToken({ participantId, organisationId = null, issuedByUserId = null, ttlDays = DEFAULT_TTL_DAYS }) {
  if (!participantId) throw new Error('participantId required');
  const participant = db.prepare('SELECT id, provider_org_id, plan_manager_id FROM participants WHERE id = ?').get(participantId);
  if (!participant) throw new Error('Participant not found');

  // Revoke any still-active tokens for this participant — only one outstanding at a time.
  db.prepare(
    `UPDATE participant_intake_tokens
     SET status = 'revoked'
     WHERE participant_id = ? AND status = 'active'`
  ).run(participantId);

  const raw = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(raw);
  const id = uuidv4();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const orgId = organisationId || participant.provider_org_id || participant.plan_manager_id || null;

  db.prepare(`
    INSERT INTO participant_intake_tokens (id, participant_id, organisation_id, token_hash, issued_by_user_id, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `).run(id, participantId, orgId, tokenHash, issuedByUserId, expiresAt);

  return { token: raw, expires_at: expiresAt, record_id: id };
}

/**
 * Validate a raw token and return the participant + intake record. Throws on miss/expired.
 * @param {string} token
 * @returns {{ id: string, participant_id: string, organisation_id: string|null, expires_at: string, status: string, participant: object }}
 */
export function resolveIntakeToken(token) {
  if (!token) {
    const e = new Error('Token required');
    e.code = 'TOKEN_REQUIRED';
    throw e;
  }
  const hash = hashToken(token);
  const row = db.prepare('SELECT * FROM participant_intake_tokens WHERE token_hash = ?').get(hash);
  if (!row) {
    const e = new Error('Intake link not found.');
    e.code = 'TOKEN_NOT_FOUND';
    throw e;
  }
  if (row.status !== 'active') {
    const e = new Error(`Intake link ${row.status === 'completed' ? 'has already been submitted.' : 'is no longer valid.'}`);
    e.code = row.status === 'completed' ? 'TOKEN_COMPLETED' : 'TOKEN_REVOKED';
    throw e;
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare("UPDATE participant_intake_tokens SET status = 'expired' WHERE id = ?").run(row.id);
    const e = new Error('Intake link has expired. Ask your coordinator to send a new one.');
    e.code = 'TOKEN_EXPIRED';
    throw e;
  }

  db.prepare("UPDATE participant_intake_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.id);

  const participant = db
    .prepare('SELECT id, name, email, phone, address, date_of_birth, ndis_number, provider_org_id, plan_manager_id FROM participants WHERE id = ?')
    .get(row.participant_id);

  return { ...row, participant };
}

/**
 * Save a partial set of intake fields supplied by the participant. Idempotent — the
 * existing upsertIntakeFields helper handles ON CONFLICT updates per field_key.
 *
 * @param {string} token
 * @param {Record<string, any>} fields
 */
export function upsertFieldsByToken(token, fields) {
  const record = resolveIntakeToken(token);
  if (!fields || typeof fields !== 'object') return record;
  upsertIntakeFields({
    participantId: record.participant_id,
    fields,
    actorType: 'participant',
    actorId: record.participant_id
  });
  return record;
}

/**
 * Mark the token completed and ensure participant_onboarding exists so a coordinator
 * can flip straight into the "Run onboarding" flow. Returns the participant id so the
 * caller can chain further actions.
 *
 * @param {string} token
 * @returns {{ participant_id: string, organisation_id: string|null }}
 */
export function completeIntakeToken(token) {
  const record = resolveIntakeToken(token);

  // Persist the row as completed before any side effects so re-submits hit TOKEN_COMPLETED.
  db.prepare(
    `UPDATE participant_intake_tokens
     SET status = 'completed', completed_at = datetime('now')
     WHERE id = ?`
  ).run(record.id);

  try {
    initializeParticipantOnboarding({
      participantId: record.participant_id,
      providerOrganisationId: record.organisation_id || null,
      actorType: 'participant',
      actorId: record.participant_id
    });
  } catch (err) {
    // Surface only via console — completion still succeeds since the data was saved.
    console.warn('[intake] initializeParticipantOnboarding after self-service intake failed:', err?.message);
  }

  return { participant_id: record.participant_id, organisation_id: record.organisation_id };
}

/**
 * Return the most recent (non-revoked) token for a participant. Used by the coordinator
 * UI so they can see whether a link is still outstanding without re-issuing.
 *
 * @param {string} participantId
 */
export function getLatestIntakeTokenForParticipant(participantId) {
  return db
    .prepare(
      `SELECT id, participant_id, organisation_id, issued_at, expires_at, last_used_at, completed_at, status
       FROM participant_intake_tokens
       WHERE participant_id = ?
       ORDER BY issued_at DESC
       LIMIT 1`
    )
    .get(participantId);
}
