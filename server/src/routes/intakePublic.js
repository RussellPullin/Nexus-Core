/**
 * Phase 4: Public participant self-service intake endpoints.
 *
 *   GET    /api/intake/:token            — fetch the intake shell (participant name, org branding, prior answers)
 *   PUT    /api/intake/:token            — save a partial set of fields (autosave)
 *   POST   /api/intake/:token/submit     — finalise; marks token completed, ensures onboarding row exists
 *
 * Mounted WITHOUT requireAuth — the token itself is the credential.
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import {
  resolveIntakeToken,
  upsertFieldsByToken,
  completeIntakeToken
} from '../services/participantIntakeToken.service.js';
import { getOrgRenderContext } from '../services/orgContext.service.js';

const router = Router();

function tokenError(res, err, fallback = 400) {
  const code = err?.code || 'TOKEN_ERROR';
  const status = code === 'TOKEN_NOT_FOUND' ? 404 : code === 'TOKEN_EXPIRED' ? 410 : fallback;
  res.status(status).json({ error: err?.message || 'Intake token error', code });
}

router.get('/:token', (req, res) => {
  try {
    const record = resolveIntakeToken(req.params.token);
    const intake = db
      .prepare('SELECT field_key, field_value FROM participant_intake_fields WHERE participant_onboarding_id IN (SELECT id FROM participant_onboarding WHERE participant_id = ?)')
      .all(record.participant_id);
    const intakeMap = Object.fromEntries(intake.map((r) => [r.field_key, r.field_value]));
    const ctx = record.organisation_id ? getOrgRenderContext(record.organisation_id) : null;
    res.json({
      participant: record.participant,
      organisation: ctx
        ? {
            id: ctx.org.id,
            name: ctx.org.tradingName || ctx.org.name,
            legal_name: ctx.org.legalName,
            primary_color: ctx.branding.primaryColor,
            accent_color: ctx.branding.accentColor,
            logo_path: Boolean(ctx.branding.logoPath)
          }
        : null,
      expires_at: record.expires_at,
      saved_fields: intakeMap
    });
  } catch (err) {
    tokenError(res, err);
  }
});

router.put('/:token', (req, res) => {
  try {
    const fields = req.body?.fields || {};
    if (typeof fields !== 'object' || Array.isArray(fields)) {
      return res.status(400).json({ error: 'fields must be an object' });
    }
    upsertFieldsByToken(req.params.token, fields);
    res.json({ ok: true, saved: Object.keys(fields).length });
  } catch (err) {
    tokenError(res, err);
  }
});

router.post('/:token/submit', (req, res) => {
  try {
    if (req.body?.fields && typeof req.body.fields === 'object' && !Array.isArray(req.body.fields)) {
      upsertFieldsByToken(req.params.token, req.body.fields);
    }
    const result = completeIntakeToken(req.params.token);
    res.json({ ok: true, ...result });
  } catch (err) {
    tokenError(res, err);
  }
});

export default router;
