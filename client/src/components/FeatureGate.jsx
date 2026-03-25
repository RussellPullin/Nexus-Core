import { Navigate } from 'react-router-dom';
import { useFeatureFlag } from '../context/FeatureFlagContext';

const defaultPlaceholderStyle = {
  padding: '2rem',
  borderRadius: 8,
  border: '1px solid #e2e8f0',
  background: '#f8fafc',
  color: '#334155',
  maxWidth: 480
};

/**
 * Renders children only when the org feature flag is on.
 *
 * @param {string} feature — feature_key (see server config/featureFlags.js)
 * @param {'hidden' | React.ReactNode} [fallback] — null: default "coming soon" card; 'hidden': render nothing
 * @param {React.ReactNode} [children]
 */
export function FeatureGate({ feature, fallback = null, children }) {
  const { enabled, loading } = useFeatureFlag(feature);

  if (loading) return null;

  if (enabled) return children;

  if (fallback === 'hidden') return null;
  if (fallback != null) return fallback;

  return (
    <div className="card" style={defaultPlaceholderStyle}>
      <h3 style={{ marginTop: 0 }}>Coming soon</h3>
      <p style={{ marginBottom: 0 }}>This area is not enabled for your organisation yet.</p>
    </div>
  );
}

/**
 * Full-page placeholder for feature-gated routes.
 */
export function FeatureComingSoon() {
  return (
    <div className="content">
      <div className="card" style={{ ...defaultPlaceholderStyle, marginTop: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Coming soon</h2>
        <p style={{ marginBottom: 0 }}>This page is not available for your organisation yet.</p>
      </div>
    </div>
  );
}

/**
 * Use inside a route to gate the whole page.
 *
 * @param {'hidden' | 'coming-soon' | 'redirect'} [whenDisabled] — hidden: render nothing; coming-soon: placeholder; redirect: go to /participants
 */
export function FeatureProtectedRoute({ feature, whenDisabled = 'redirect', children }) {
  const { enabled, loading } = useFeatureFlag(feature);

  if (loading) {
    return (
      <div className="content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 120 }}>
        Loading…
      </div>
    );
  }

  if (!enabled) {
    if (whenDisabled === 'coming-soon') return <FeatureComingSoon />;
    if (whenDisabled === 'hidden') return null;
    return <Navigate to="/participants" replace />;
  }

  return children;
}
