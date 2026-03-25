import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { getSupabaseBrowserClient } from '../lib/supabaseClient';
import { auth as authApi } from '../lib/api';
import { useAuth } from '../context/AuthContext';

export default function SetupOrgPage() {
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const [orgName, setOrgName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [noSession, setNoSession] = useState(false);

  useEffect(() => {
    const sb = getSupabaseBrowserClient();
    if (!sb) {
      setNoSession(true);
      return;
    }
    sb.auth.getSession().then(({ data: { session } }) => {
      if (!session?.access_token) setNoSession(true);
    });
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const name = orgName.trim();
    if (!name) {
      setError('Enter your organisation name.');
      return;
    }
    const sb = getSupabaseBrowserClient();
    if (!sb) {
      setError('Supabase is not configured in the client.');
      return;
    }
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) {
      setNoSession(true);
      return;
    }
    setBusy(true);
    try {
      await authApi.supabaseRegisterOrg(session.access_token, name);
      await refreshUser();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message || 'Could not create organisation');
    } finally {
      setBusy(false);
    }
  };

  if (noSession) {
    return (
      <div className="login-page">
        <div className="login-card">
          <p className="login-subtitle">Sign in first</p>
          <p style={{ marginBottom: '1rem', color: '#64748b' }}>
            You need an active Supabase session to create your organisation. Open the link from your email or sign in.
          </p>
          <Link to="/login" className="btn btn-primary">Back to sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <img src="/logo.png" alt="NexusCore" className="login-logo" />
        <p className="login-tagline">Where paperwork disappears.</p>
        <p className="login-subtitle">Name your organisation</p>
        <p style={{ marginBottom: '1rem', fontSize: '0.9rem', color: '#64748b' }}>
          If this organisation exists in Shifter Supabase, Nexus Core will reuse that org ID. Otherwise a new org ID is created in Nexus Core.
        </p>
        <form onSubmit={handleSubmit}>
          {error && <div className="login-error">{error}</div>}
          <input
            type="text"
            placeholder="Organisation name"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            className="login-input"
            required
            autoComplete="organization"
          />
          <button type="submit" className="btn btn-primary login-btn" disabled={busy}>
            {busy ? 'Creating…' : 'Continue'}
          </button>
        </form>
      </div>
    </div>
  );
}
