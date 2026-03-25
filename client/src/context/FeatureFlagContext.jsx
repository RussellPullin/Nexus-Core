import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from './AuthContext';
import { orgFeatures as orgFeaturesApi } from '../lib/api';

const FeatureFlagContext = createContext(null);

export function FeatureFlagProvider({ children }) {
  const { user, loading: authLoading } = useAuth();
  const [flags, setFlags] = useState({});
  const [featureKeys, setFeatureKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [configured, setConfigured] = useState(false);

  const load = useCallback(async () => {
    if (authLoading) return;
    if (!user) {
      setFlags({});
      setFeatureKeys([]);
      setConfigured(false);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await orgFeaturesApi.mine();
      setFlags(data?.flags && typeof data.flags === 'object' ? data.flags : {});
      setFeatureKeys(Array.isArray(data?.feature_keys) ? data.feature_keys : []);
      setConfigured(data?.configured !== false);
    } catch (e) {
      setError(e?.message || 'Failed to load flags');
      setFlags({});
      setFeatureKeys([]);
      setConfigured(false);
    } finally {
      setLoading(false);
    }
  }, [user, authLoading]);

  useEffect(() => {
    load();
  }, [load]);

  const value = useMemo(
    () => ({
      flags,
      featureKeys,
      loading: loading || authLoading,
      error,
      configured,
      refresh: load
    }),
    [flags, featureKeys, loading, authLoading, error, configured, load]
  );

  return <FeatureFlagContext.Provider value={value}>{children}</FeatureFlagContext.Provider>;
}

export function useFeatureFlags() {
  const ctx = useContext(FeatureFlagContext);
  if (!ctx) throw new Error('useFeatureFlags must be used within FeatureFlagProvider');
  return ctx;
}

/**
 * @param {string} featureKey — must match server FEATURE_FLAG_KEYS (e.g. advanced_reporting)
 */
export function useFeatureFlag(featureKey) {
  const { flags, loading, error, configured, refresh } = useFeatureFlags();
  return {
    enabled: Boolean(flags[featureKey]),
    loading,
    error,
    configured,
    refresh
  };
}
