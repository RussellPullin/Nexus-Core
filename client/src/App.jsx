import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, Link } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { FeatureFlagProvider } from './context/FeatureFlagContext';
import { ai } from './lib/api';
import ParticipantsPage from './pages/ParticipantsPage';
import ParticipantProfile from './pages/ParticipantProfile';
import DirectoryPage from './pages/DirectoryPage';
import StaffPage from './pages/StaffPage';
import StaffProfile from './pages/StaffProfile';
import ShiftsPage from './pages/ShiftsPage';
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

/**
 * Feature flags: add keys in server/src/config/featureFlags.js, then wrap UI with
 * FeatureGate / FeatureProtectedRoute from ./components/FeatureGate (see that file).
 */
const EMAIL_BANNER_KEY = 'nexus_email_banner_dismissed';

function Layout({ children }) {
  const { user, logout, canManageUsers, canAccessCaseTasks } = useAuth();
  const [ollamaOk, setOllamaOk] = useState(null);
  const [emailBannerDismissed, setEmailBannerDismissed] = useState(() =>
    typeof sessionStorage !== 'undefined' && sessionStorage.getItem(EMAIL_BANNER_KEY) === '1'
  );
  useEffect(() => {
    ai.status().then((s) => setOllamaOk(s?.available)).catch(() => setOllamaOk(false));
  }, []);

  const needsEmailOauth =
    Boolean(user) && (user.email_reconnect_required || !user.email_connected_address);
  const needsEmailRelay =
    Boolean(user) &&
    user.email_connected_address &&
    !user.email_reconnect_required &&
    user.email_relay_configured === false;
  const showEmailBanner = Boolean(user) && !emailBannerDismissed && (needsEmailOauth || needsEmailRelay);

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="logo-block">
          <img src="/logo.png" alt="NexusCore" className="logo-img" />
          <p className="logo-tagline">Where paperwork disappears.</p>
        </div>
        <div className="nav-links">
          <NavLink to="/participants" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            Participants
          </NavLink>
          <NavLink to="/directory" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            Directory
          </NavLink>
          <NavLink to="/staff" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            Staff
          </NavLink>
          <NavLink to="/shifts" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            Shifts
          </NavLink>
          <NavLink to="/ndis" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            NDIS Pricing
          </NavLink>
          <NavLink to="/financial" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            Financial
          </NavLink>
          {canAccessCaseTasks && (
            <NavLink to="/case-tasks" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
              Client Cases
            </NavLink>
          )}
          <NavLink to="/forms" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            Forms
          </NavLink>
          {canManageUsers && (
            <NavLink to="/admin" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
              Admin
            </NavLink>
          )}
          {user?.is_super_admin && (
            <NavLink to="/admin/feature-flags" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
              Feature flags
            </NavLink>
          )}
        </div>
        <div className="nav-footer">
          <NavLink to="/settings" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            Settings
          </NavLink>
          <span className="nav-ai-status" title={ollamaOk === true ? 'Ollama connected' : ollamaOk === false ? 'Ollama not running' : 'Checking...'}>
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
                  ? 'Your inbox is connected, but this server is not set up to send mail yet (missing AZURE_EMAIL_FUNCTION_URL). An administrator must deploy the email relay and set that environment variable on the host.'
                  : 'Connect your email so you can send rosters and staff messages from your own address.'}
            </span>
            <Link to="/settings" className="btn btn-primary" style={{ textDecoration: 'none' }}>
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
        {children}
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
          <Route path="/" element={<ProtectedRoute><Layout><ParticipantsPage /></Layout></ProtectedRoute>} />
          <Route path="/participants" element={<ProtectedRoute><Layout><ParticipantsPage /></Layout></ProtectedRoute>} />
          <Route path="/participants/:id" element={<ProtectedRoute><Layout><ParticipantProfile /></Layout></ProtectedRoute>} />
          <Route path="/directory" element={<ProtectedRoute><Layout><DirectoryPage /></Layout></ProtectedRoute>} />
          <Route path="/staff" element={<ProtectedRoute><Layout><StaffPage /></Layout></ProtectedRoute>} />
          <Route path="/staff/:id" element={<ProtectedRoute><Layout><StaffProfile /></Layout></ProtectedRoute>} />
          <Route path="/shifts/:id" element={<ProtectedRoute><Layout><ShiftDetailPage /></Layout></ProtectedRoute>} />
          <Route path="/shifts" element={<ProtectedRoute><Layout><ShiftsPage /></Layout></ProtectedRoute>} />
          <Route path="/ndis" element={<ProtectedRoute><Layout><NDISPage /></Layout></ProtectedRoute>} />
          <Route path="/financial" element={<ProtectedRoute><Layout><FinancialPage /></Layout></ProtectedRoute>} />
          <Route path="/case-tasks" element={<ProtectedRoute><Layout><CaseTasksPage /></Layout></ProtectedRoute>} />
          <Route path="/onboarding" element={<ProtectedRoute><Layout><ParticipantsPage /></Layout></ProtectedRoute>} />
          <Route path="/onboarding/:id" element={<ProtectedRoute><Layout><OnboardingPage /></Layout></ProtectedRoute>} />
          <Route path="/forms" element={<ProtectedRoute><Layout><FormsPage /></Layout></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><Layout><SettingsPage /></Layout></ProtectedRoute>} />
          <Route path="/admin" element={<ProtectedRoute><Layout><AdminPage /></Layout></ProtectedRoute>} />
          <Route path="/admin/feature-flags" element={<ProtectedRoute><Layout><FeatureFlagsAdminPage /></Layout></ProtectedRoute>} />
        </Routes>
        </FeatureFlagProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
