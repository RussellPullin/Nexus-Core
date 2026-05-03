
import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, Link, Outlet, useParams, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { FeatureFlagProvider } from './context/FeatureFlagContext';
import { PRODUCT_AGENCY, PRODUCT_COORDINATION, isValidActiveProduct } from '@nexus-shared/tenantProduct.js';
import { ai, auth as authApi } from './lib/api';
import { probeLocalOllama, resolveLocalOllamaBaseUrl } from './lib/localOllama.js';
import { writePreferredProductSurface } from './lib/nexusPreferredProduct.js';
import ParticipantsPage from './pages/ParticipantsPage';
import ParticipantProfile from './pages/ParticipantProfile';
import DirectoryPage from './pages/DirectoryPage';
import StaffPage from './pages/StaffPage';
import StaffProfile from './pages/StaffProfile';
import ShiftsPage from './pages/ShiftsPage';
import StaffAvailabilityReportPage from './pages/StaffAvailabilityReportPage';
import ShiftDetailPage from './pages/ShiftDetailPage';
import NDISPage from './pages/NDISPage';
import FinancialPage from './pages/FinancialPage';
import CaseTasksPage from './pages/CaseTasksPage';
import OnboardingPage from './pages/OnboardingPage';
import AdminPage from './pages/AdminPage';
import FeatureFlagsAdminPage from './pages/FeatureFlagsAdminPage';
import LoginPage from './pages/LoginPage';
import SetupOrgPage from './pages/SetupOrgPage';
import SettingsPage from './pages/SettingsPage';
import FormsPage from './pages/FormsPage';
import StaffOnboardingFormPage from './pages/StaffOnboardingFormPage';
import StaffRenewalPage from './pages/StaffRenewalPage';
import './App.css';

const EMAIL_BANNER_KEY = 'nexus_email_banner_dismissed';

function useSyncActiveProduct(productSurface) {
  const { user, refreshUser } = useAuth();
  useEffect(() => {
    if (!user?.id || !productSurface) return;
    if (productSurface === PRODUCT_COORDINATION && !user.can_use_coordination) return;
    if (productSurface === PRODUCT_AGENCY && !user.can_use_agency) return;
    if (user.active_product === productSurface) return;
    let cancelled = false;
    authApi.setActiveProduct(productSurface).then(() => {
      if (!cancelled) {
        writePreferredProductSurface(productSurface);
        refreshUser();
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [user?.id, user?.active_product, productSurface, user?.can_use_coordination, user?.can_use_agency, refreshUser]);
}

function ProductLayout() {
  const { productSurface } = useParams();
  useSyncActiveProduct(productSurface);
  return (
    <Layout productSurface={productSurface}>
      <Outlet />
    </Layout>
  );
}

function Layout({ productSurface, children }) {
  const { user, logout, canManageUsers, canAccessCaseTasks } = useAuth();
  const [ollamaOk, setOllamaOk] = useState(null);
  const [emailBannerDismissed, setEmailBannerDismissed] = useState(() =>
    typeof sessionStorage !== 'undefined' && sessionStorage.getItem(EMAIL_BANNER_KEY) === '1'
  );
  const prefix = productSurface ? `/${productSurface}` : '';
  const isAgency = productSurface === PRODUCT_AGENCY;

  useEffect(() => {
    if (!user) {
      setOllamaOk(null);
      return;
    }
    let cancel = false;
    (async () => {
      try {
        const s = await ai.status();
        if (cancel) return;
        const serverOk = Boolean(s?.server?.available);
        let localOk = false;
        if (s?.orgAllowsLocalOllama) {
          const base = s.userOllamaLocalBaseUrl || resolveLocalOllamaBaseUrl(user);
          const p = await probeLocalOllama(base);
          localOk = Boolean(p.ok && (p.models?.length ?? 0) > 0);
        }
        setOllamaOk(serverOk || localOk);
      } catch {
        if (!cancel) setOllamaOk(false);
      }
    })();
    return () => { cancel = true; };
  }, [user?.id, user?.ollama_local_base_url]);

  const needsEmailOauth =
    Boolean(user) && (user.email_reconnect_required || !user.email_connected_address);
  const needsEmailRelay =
    Boolean(user) &&
    user.email_connected_address &&
    !user.email_reconnect_required &&
    user.email_relay_configured === false;
  const showEmailBanner = Boolean(user) && !emailBannerDismissed && (needsEmailOauth || needsEmailRelay);

  const brandTitle = productSurface === PRODUCT_COORDINATION ? 'Nexus Coordination' : 'Nexus Agency';
  const brandTagline =
    productSurface === PRODUCT_COORDINATION
      ? 'NDIS planning, budgets & coordination.'
      : 'Shifts, staff & service delivery.';

  const showProductSwitcher = Boolean(user?.can_use_coordination && user?.can_use_agency);

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="logo-block">
          <img src="/logo.png" alt={brandTitle} className="logo-img" />
          <p className="logo-tagline" style={{ fontWeight: 600 }}>{brandTitle}</p>
          <p className="logo-tagline" style={{ marginTop: 4, fontSize: '0.8rem' }}>{brandTagline}</p>
        </div>
        {showProductSwitcher && (
          <div style={{ padding: '0 0.75rem 0.75rem', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: '0.7rem', color: '#94a3b8', textTransform: 'uppercase' }}>Switch product</span>
            <NavLink
              to={`/${PRODUCT_COORDINATION}/participants`}
              className={productSurface === PRODUCT_COORDINATION ? 'nav-link active' : 'nav-link'}
            >
              Nexus Coordination
            </NavLink>
            <NavLink
              to={`/${PRODUCT_AGENCY}/participants`}
              className={productSurface === PRODUCT_AGENCY ? 'nav-link active' : 'nav-link'}
            >
              Nexus Agency
            </NavLink>
          </div>
        )}
        <div className="nav-links">
          <NavLink to={`${prefix}/participants`} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            Participants
          </NavLink>
          <NavLink to={`${prefix}/directory`} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            Directory
          </NavLink>
          {isAgency && (
            <>
              <NavLink to={`${prefix}/staff`} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
                Staff
              </NavLink>
              <NavLink to={`${prefix}/shifts`} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
                Shifts
              </NavLink>
            </>
          )}
          <NavLink to={`${prefix}/ndis`} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            NDIS Pricing
          </NavLink>
          <NavLink to={`${prefix}/financial`} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            Financial
          </NavLink>
          {canAccessCaseTasks && (
            <NavLink to={`${prefix}/case-tasks`} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
              Client Cases
            </NavLink>
          )}
          <NavLink to={`${prefix}/forms`} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            Forms
          </NavLink>
          {canManageUsers && (
            <NavLink to={`${prefix}/admin`} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
              Admin
            </NavLink>
          )}
          {user?.is_super_admin && (
            <NavLink to={`${prefix}/admin/feature-flags`} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
              Feature flags
            </NavLink>
          )}
        </div>
        <div className="nav-footer">
          <NavLink to={`${prefix}/settings`} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            Settings
          </NavLink>
          <span
            className="nav-ai-status"
            title={ollamaOk === true ? 'Ollama' : ollamaOk === false ? '—' : '…'}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: ollamaOk === true ? '#22c55e' : ollamaOk === false ? '#94a3b8' : 'transparent', display: 'inline-block', marginRight: 4 }} />
            AI
          </span>
          <span className="nav-user">{user?.email}</span>
          <button type="button" className="nav-logout" onClick={logout}>Sign out</button>
        </div>
      </nav>
      <main className="content">
        {showEmailBanner && (
          <div
            style={{
              margin: '0 0 1rem 0',
              padding: '0.85rem 1rem',
              background:
                user.email_reconnect_required ? '#fef3c7' : needsEmailRelay ? '#fff7ed' : '#e0f2fe',
              border: `1px solid ${
                user.email_reconnect_required ? '#fcd34d' : needsEmailRelay ? '#fdba74' : '#7dd3fc'
              }`,
              borderRadius: 8,
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '0.75rem',
            }}
          >
            <span style={{ flex: '1 1 200px', color: '#0f172a', fontSize: '0.95rem' }}>
              {user.email_reconnect_required
                ? 'Your email connection needs to be renewed. Reconnect in Settings to keep sending rosters and messages.'
                : needsEmailRelay
                  ? 'Your inbox is connected, but this server is not set up to send outgoing mail yet. Ask your administrator to finish email setup.'
                  : isAgency
                    ? 'Connect your email so you can send rosters and staff messages from your own address.'
                    : 'Connect your email so you can send participant-related mail from your own address.'}
            </span>
            <Link to={`${prefix}/settings`} className="btn btn-primary" style={{ textDecoration: 'none' }}>
              {user.email_reconnect_required
                ? 'Reconnect email'
                : needsEmailRelay
                  ? 'Settings'
                  : 'Connect email'}
            </Link>
            {!user.email_reconnect_required && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  sessionStorage.setItem(EMAIL_BANNER_KEY, '1');
                  setEmailBannerDismissed(true);
                }}
              >
                Remind me later
              </button>
            )}
          </div>
        )}
        {children ?? <Outlet />}
      </main>
    </div>
  );
}

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function DefaultProductRedirect() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  const c = Boolean(user.can_use_coordination);
  const a = Boolean(user.can_use_agency);
  if (c && a) {
    const ap = user.active_product;
    if (ap === PRODUCT_COORDINATION) {
      return <Navigate to={`/${PRODUCT_COORDINATION}/participants`} replace />;
    }
    if (ap === PRODUCT_AGENCY) {
      return <Navigate to={`/${PRODUCT_AGENCY}/participants`} replace />;
    }
    // Session has not resolved yet; match server default (agency when both)
    return <Navigate to={`/${PRODUCT_AGENCY}/participants`} replace />;
  }
  if (a) return <Navigate to={`/${PRODUCT_AGENCY}/participants`} replace />;
  if (c) return <Navigate to={`/${PRODUCT_COORDINATION}/participants`} replace />;
  return <Navigate to="/login" replace />;
}

function LegacyPathRedirect() {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace />;
  const product =
    user.active_product === PRODUCT_COORDINATION && user.can_use_coordination
      ? PRODUCT_COORDINATION
      : user.can_use_agency
        ? PRODUCT_AGENCY
        : user.can_use_coordination
          ? PRODUCT_COORDINATION
          : PRODUCT_AGENCY;
  const pathAfterRoot = location.pathname.replace(/^\/+/, '') || '';
  return <Navigate to={`/${product}/${pathAfterRoot}${location.search || ''}`} replace />;
}

function ProductAccessGate() {
  const { productSurface } = useParams();
  const { user } = useAuth();
  if (!isValidActiveProduct(productSurface)) {
    return <Navigate to="/" replace />;
  }
  if (!user) return null;
  if (productSurface === PRODUCT_COORDINATION && !user.can_use_coordination) {
    return <Navigate to={user.can_use_agency ? `/${PRODUCT_AGENCY}/participants` : '/login'} replace />;
  }
  if (productSurface === PRODUCT_AGENCY && !user.can_use_agency) {
    return <Navigate to={user.can_use_coordination ? `/${PRODUCT_COORDINATION}/participants` : '/login'} replace />;
  }
  return <Outlet />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <FeatureFlagProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/setup-org" element={<SetupOrgPage />} />
          <Route path="/staff-onboarding/:token" element={<StaffOnboardingFormPage />} />
          <Route path="/staff-onboarding/renew/:token" element={<StaffRenewalPage />} />

          <Route path="/participants/*" element={<ProtectedRoute><LegacyPathRedirect /></ProtectedRoute>} />
          <Route path="/directory" element={<ProtectedRoute><LegacyPathRedirect /></ProtectedRoute>} />
          <Route path="/staff/*" element={<ProtectedRoute><LegacyPathRedirect /></ProtectedRoute>} />
          <Route path="/shifts/*" element={<ProtectedRoute><LegacyPathRedirect /></ProtectedRoute>} />
          <Route path="/ndis" element={<ProtectedRoute><LegacyPathRedirect /></ProtectedRoute>} />
          <Route path="/financial" element={<ProtectedRoute><LegacyPathRedirect /></ProtectedRoute>} />
          <Route path="/case-tasks" element={<ProtectedRoute><LegacyPathRedirect /></ProtectedRoute>} />
          <Route path="/onboarding/*" element={<ProtectedRoute><LegacyPathRedirect /></ProtectedRoute>} />
          <Route path="/forms" element={<ProtectedRoute><LegacyPathRedirect /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><LegacyPathRedirect /></ProtectedRoute>} />
          <Route path="/admin/*" element={<ProtectedRoute><LegacyPathRedirect /></ProtectedRoute>} />

          <Route path="/" element={<ProtectedRoute><DefaultProductRedirect /></ProtectedRoute>} />

          {/* RR v7 does not match `/:x(a|b)` like v6; use plain param + gate above. */}
          <Route path="/:productSurface" element={<ProtectedRoute><ProductAccessGate /></ProtectedRoute>}>
            <Route element={<ProductLayout />}>
              <Route index element={<Navigate to="participants" replace />} />
              <Route path="participants" element={<ParticipantsPage />} />
              <Route path="participants/:id" element={<ParticipantProfile />} />
              <Route path="directory" element={<DirectoryPage />} />
              <Route path="staff" element={<StaffPage />} />
              <Route path="staff/:id" element={<StaffProfile />} />
              <Route path="shifts/availability" element={<StaffAvailabilityReportPage />} />
              <Route path="shifts/:id" element={<ShiftDetailPage />} />
              <Route path="shifts" element={<ShiftsPage />} />
              <Route path="ndis" element={<NDISPage />} />
              <Route path="financial" element={<FinancialPage />} />
              <Route path="case-tasks" element={<CaseTasksPage />} />
              <Route path="onboarding" element={<ParticipantsPage />} />
              <Route path="onboarding/:id" element={<OnboardingPage />} />
              <Route path="forms" element={<FormsPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="admin" element={<AdminPage />} />
              <Route path="admin/feature-flags" element={<FeatureFlagsAdminPage />} />
            </Route>
          </Route>
        </Routes>
        </FeatureFlagProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
