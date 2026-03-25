import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireSuperAdmin } from '../middleware/superAdmin.js';
import { listFeatureFlagKeys } from '../config/featureFlags.js';
import { fetchFlagsForOrg, fetchOrgFeatureMatrix, upsertOrgFeature } from '../services/orgFeatures.service.js';

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const orgId = req.session.user?.org_id || null;
    const { configured, flags } = await fetchFlagsForOrg(orgId);
    res.json({
      configured,
      org_id: orgId,
      feature_keys: listFeatureFlagKeys(),
      flags
    });
  } catch (err) {
    console.error('[org-features]', err);
    res.status(500).json({ error: err.message || 'Failed to load feature flags' });
  }
});

router.get('/super-admin/matrix', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const payload = await fetchOrgFeatureMatrix();
    res.json({
      ...payload,
      supabase_configured: Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim())
    });
  } catch (err) {
    console.error('[org-features matrix]', err);
    res.status(500).json({ error: err.message || 'Failed to load matrix' });
  }
});

router.put('/super-admin', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { org_id: orgId, feature_key: featureKey, enabled } = req.body || {};
    if (!orgId || !featureKey || typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'org_id, feature_key, and enabled (boolean) required' });
    }
    const row = await upsertOrgFeature(String(orgId), String(featureKey), enabled);
    res.json(row);
  } catch (err) {
    if (err.code === 'UNKNOWN_FEATURE_KEY' || err.code === 'ORG_NOT_FOUND') {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === 'SUPABASE_NOT_CONFIGURED') {
      return res.status(503).json({ error: err.message });
    }
    console.error('[org-features upsert]', err);
    res.status(500).json({ error: err.message || 'Failed to update flag' });
  }
});

export default router;
