import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { auth as authApi } from '../lib/api';
import { getSupabaseBrowserClient } from '../lib/supabaseClient';

export default function LoginPage() {
  const { user, loading, login, register, loginWithSupabase, registerWithSupabase } = useAuth();
  const navigate = useNavigate();
  const [useCloudAuth, setUseCloudAuth] = useState(false);
  const syncingSupabaseSessionRef = useRef(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [isRegister, setIsRegister] = useState(false);
  const [isRecoveryMode, setIsRecoveryMode] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const attemptedTokenRef = useRef('');

  const hasSupabaseCallbackParams = useCallback(() => {
    if (typeof window === 'undefined') return false;
    const search = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    return (
      search.has('code') ||
      search.has('token_hash') ||
      search.has('type') ||
      hash.has('access_token') ||
      hash.has('refresh_token') ||
      hash.has('type')
    );
  }, []);

  useEffect(() => {
    if (!loading && user) navigate('/', { replace: true });
  }, [user, loading, navigate]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.sessionStorage.getItem('nexus_supabase_recovery_mode') === '1') {
      setIsRecoveryMode(true);
      setIsRegister(false);
      setInfo('Recovery link accepted. Set a new password below.');
    }
  }, []);

  useEffect(() => {
    const preferLocal =
      import.meta.env.VITE_PREFER_LOCAL_LOGIN === 'true' || import.meta.env.VITE_PREFER_LOCAL_LOGIN === '1';
    const callbackFlow = hasSupabaseCallbackParams();
    if (preferLocal && !callbackFlow) {
      setUseCloudAuth(false);
      return;
    }
    const viteOk = Boolean(import.meta.env.VITE_SUPABASE_URL?.trim() && import.meta.env.VITE_SUPABASE_ANON_KEY?.trim());
    if (!viteOk) {
      setUseCloudAuth(false);
      return;
    }
    authApi
      .supabasePublicConfig()
      .then((c) => setUseCloudAuth(Boolean(c?.supabase_auth_enabled)))
      .catch(() => setUseCloudAuth(false));
  }, [hasSupabaseCallbackParams]);

  const completeSupabaseSession = useCallback(
    async (accessToken) => {
      if (!accessToken || syncingSupabaseSessionRef.current) return;
      if (attemptedTokenRef.current === accessToken) return;
      attemptedTokenRef.current = accessToken;
      syncingSupabaseSessionRef.current = true;
      setError('');
      setInfo('');
      try {
        const body = await authApi.supabaseSession(accessToken);
        if (body?.needs_org_setup) {
          navigate('/setup-org', { replace: true });
          return;
        }
        navigate('/', { replace: true });
      } catch (err) {
        const msg = String(err?.message || '');
        if (msg.toLowerCase().includes('invalid or expired token')) {
          const sb = getSupabaseBrowserClient();
          if (sb) {
            try {
              await sb.auth.signOut();
            } catch {
              // Ignore signOut cleanup failures
            }
          }
          setError('Your Supabase session token is invalid or expired.');
          setInfo('Please sign in again or use Forgot password to get a fresh link.');
        } else {
          setError(msg || 'Could not complete Supabase sign-in.');
        }
      } finally {
        syncingSupabaseSessionRef.current = false;
      }
    },
    [navigate],
  );

  useEffect(() => {
    const sb = getSupabaseBrowserClient();
    if (!sb) return undefined;

    let active = true;
    const completeUrlCallback = async () => {
      const search = new URLSearchParams(window.location.search);
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const code = search.get('code');
      const tokenHash = search.get('token_hash');
      const type = search.get('type') || hash.get('type');

      if (code) {
        const { data, error } = await sb.auth.exchangeCodeForSession(code);
        if (!active) return true;
        if (error) {
          const msg = String(error.message || '').toLowerCase();
          if (msg.includes('expired') || msg.includes('invalid')) {
            setError('This sign-in link is invalid or expired.');
            setInfo('Request a fresh link from Forgot password and open the newest email only once.');
          } else {
            setError(error.message || 'Could not process sign-in link.');
          }
          window.history.replaceState({}, document.title, window.location.pathname);
          return true;
        }
        const token = data?.session?.access_token;
        if (type === 'recovery') {
          setIsRecoveryMode(true);
          setIsRegister(false);
          setInfo('Recovery link accepted. Set a new password below.');
          window.sessionStorage.setItem('nexus_supabase_recovery_mode', '1');
        } else if (token) {
          await completeSupabaseSession(token);
        }
        window.history.replaceState({}, document.title, window.location.pathname);
        return true;
      }

      if (tokenHash && type) {
        const { data, error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type });
        if (!active) return true;
        if (error) {
          const msg = String(error.message || '').toLowerCase();
          if (msg.includes('expired') || msg.includes('invalid')) {
            setError('This sign-in link is invalid or expired.');
            setInfo('Click Forgot password to send a new link, then open only the latest email link.');
          } else {
            setError(error.message || 'Could not verify sign-in link.');
          }
          window.history.replaceState({}, document.title, window.location.pathname);
          return true;
        }
        const token = data?.session?.access_token;
        if (type === 'recovery') {
          setIsRecoveryMode(true);
          setIsRegister(false);
          setInfo('Recovery link accepted. Set a new password below.');
          window.sessionStorage.setItem('nexus_supabase_recovery_mode', '1');
        } else if (token) {
          await completeSupabaseSession(token);
        }
        window.history.replaceState({}, document.title, window.location.pathname);
        return true;
      }

      return false;
    };

    const syncFromCurrentSession = async () => {
      const fromUrl = await completeUrlCallback();
      if (!active || fromUrl) return;
      const { data, error } = await sb.auth.getSession();
      if (!active || error) return;
      const token = data?.session?.access_token;
      if (token && !isRecoveryMode) await completeSupabaseSession(token);
    };

    syncFromCurrentSession();

    const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === 'PASSWORD_RECOVERY') {
        setIsRecoveryMode(true);
        setIsRegister(false);
        setError('');
        setInfo('Recovery link accepted. Set a new password below.');
        window.sessionStorage.setItem('nexus_supabase_recovery_mode', '1');
        return;
      }
      const token = session?.access_token;
      if (token && !isRecoveryMode) {
        completeSupabaseSession(token);
      }
    });

    return () => {
      active = false;
      sub?.subscription?.unsubscribe();
    };
  }, [completeSupabaseSession, isRecoveryMode]);

  const handleCompleteRecovery = async () => {
    setError('');
    setInfo('');
    if (!newPassword || newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    const sb = getSupabaseBrowserClient();
    if (!sb) {
      setError('Supabase client is not configured.');
      return;
    }
    setSubmitting(true);
    try {
      const { error: updateErr } = await sb.auth.updateUser({ password: newPassword });
      if (updateErr) throw new Error(updateErr.message || 'Could not update password.');
      const { data: sessionData } = await sb.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error('Password updated, but no session found. Please sign in again.');
      window.sessionStorage.removeItem('nexus_supabase_recovery_mode');
      setIsRecoveryMode(false);
      setNewPassword('');
      setConfirmPassword('');
      await completeSupabaseSession(token);
    } catch (err) {
      setError(err.message || 'Could not complete password reset.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotPassword = async () => {
    setError('');
    setInfo('');
    const emailNorm = String(email || '').trim().toLowerCase();
    if (!emailNorm) {
      setError('Enter your email first, then click Forgot password.');
      return;
    }
    if (!useCloudAuth) {
      setInfo('Forgot password is only available in Supabase login mode.');
      return;
    }
    const sb = getSupabaseBrowserClient();
    if (!sb) {
      setError('Supabase client is not configured in this browser origin.');
      setInfo('Open http://localhost:5174/login and retry Forgot password.');
      return;
    }
    setSubmitting(true);
    try {
      const redirectTo = (() => {
        if (typeof window === 'undefined') return 'http://localhost:5174/login';
        const host = window.location.hostname;
        const port = window.location.port;
        // In local dev, force links back to Vite so VITE_SUPABASE_* env is present.
        if ((host === 'localhost' || host === '127.0.0.1') && !port) {
          return 'http://localhost:5174/login';
        }
        return `${window.location.origin}/login`;
      })();
      const { error: resetErr } = await sb.auth.resetPasswordForEmail(emailNorm, redirectTo ? { redirectTo } : {});
      if (resetErr) throw new Error(resetErr.message || 'Could not send password reset email.');
      setInfo(
        `Password reset email sent to ${emailNorm}. Open that link, then this page will show "Set new password".`,
      );
    } catch (err) {
      setError(err.message || 'Could not send password reset email.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setSubmitting(true);
    try {
      if (useCloudAuth) {
        if (isRegister) {
          const r = await registerWithSupabase(email, password, name);
          if (r.awaiting_email_confirm) {
            const to = r.confirmEmail ? ` to ${r.confirmEmail}` : '';
            setInfo(
              [
                `If email confirmation is enabled in Supabase, a message should arrive${to}. After you click the link, sign in here to finish organisation setup.`,
                '',
                'No email? Confirmation is sent by your Supabase project (not Nexus email in Settings). Check spam and wait a few minutes.',
                'In Supabase Dashboard: Authentication → Providers → Email — use Custom SMTP for reliable delivery. For local testing you can turn off "Confirm email".',
                `Authentication → URL Configuration → add your Redirect URLs (e.g. ${typeof window !== 'undefined' ? `${window.location.origin}/**` : 'https://your-app/**'}).`,
              ].join('\n'),
            );
            setIsRegister(false);
            return;
          }
          if (r.needs_org_setup) {
            navigate('/setup-org', { replace: true });
            return;
          }
          navigate('/', { replace: true });
          return;
        }
        const r = await loginWithSupabase(email, password);
        if (r.needs_org_setup) {
          navigate('/setup-org', { replace: true });
          return;
        }
        navigate('/', { replace: true });
        return;
      }

      if (isRegister) {
        await register(email, password, name);
      } else {
        await login(email, password);
      }
      navigate('/', { replace: true });
    } catch (err) {
      if (err?.code === 'USE_SUPABASE_AUTH') {
        setUseCloudAuth(true);
        setError('');
        setInfo(
          [
            'This account must use cloud sign-in (Supabase). Your next Sign in will check the password stored in Supabase Auth — that can differ from an older password that only ever lived in Nexus’s local database.',
            '',
            'Click Sign in again. If Supabase still rejects it: Supabase Dashboard → Authentication → Users → your email → reset password (or Send magic link).',
          ].join('\n'),
        );
        return;
      }
      let msg = err.message || 'Login failed';
      if (useCloudAuth) {
        if (err?.code === 'NO_PROFILE') {
          msg +=
            '\n\nYour Supabase user exists but there is no matching row in public.profiles. A developer needs to run the profiles migration / trigger that creates profiles on signup.';
        } else if (/invalid login credentials|invalid email or password/i.test(msg)) {
          msg +=
            '\n\nThat error is from Supabase Auth, not Nexus. The password in Supabase may not match what you expect if you first created the user locally. Reset it: Dashboard → Authentication → Users → pick your user → reset password.';
        } else if (/email not confirmed|confirm your email/i.test(msg)) {
          msg +=
            '\n\nConfirm your email using the link Supabase sent, or for local testing turn off “Confirm email” under Authentication → Providers → Email.';
        }
      }
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="login-page"><div className="login-card">Loading...</div></div>;

  const preferLocalLogin =
    import.meta.env.VITE_PREFER_LOCAL_LOGIN === 'true' || import.meta.env.VITE_PREFER_LOCAL_LOGIN === '1';
  const supabaseConfigured = Boolean(
    import.meta.env.VITE_SUPABASE_URL?.trim() && import.meta.env.VITE_SUPABASE_ANON_KEY?.trim(),
  );

  return (
    <div className="login-page">
      <div className="login-card">
        <img src="/logo.png" alt="NexusCore" className="login-logo" />
        <p className="login-tagline">Where paperwork disappears.</p>
        <p className="login-subtitle">
          {isRegister ? 'Create your account' : 'Sign in to continue'}
          {useCloudAuth && (
            <span style={{ display: 'block', fontSize: '0.8rem', color: '#64748b', marginTop: '0.35rem' }}>
              Secured with Supabase (same project as org features &amp; Shifter sync).
            </span>
          )}
        </p>
        <form onSubmit={handleSubmit}>
          {error && <div className="login-error">{error}</div>}
          {info && (
            <div
              style={{
                marginBottom: '0.75rem',
                padding: '0.65rem',
                background: '#e0f2fe',
                borderRadius: 8,
                fontSize: '0.85rem',
                lineHeight: 1.45,
                whiteSpace: 'pre-line',
                color: '#0c4a6e',
              }}
            >
              {info}
            </div>
          )}
          {isRegister && !isRecoveryMode && (
            <input
              type="text"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="login-input"
              autoComplete="name"
            />
          )}
          {!isRecoveryMode ? (
            <>
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="login-input"
                required
                autoComplete="email"
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="login-input"
                required
                autoComplete={isRegister ? 'new-password' : 'current-password'}
              />
              <button type="submit" className="btn btn-primary login-btn" disabled={submitting}>
                {submitting ? 'Please wait...' : isRegister ? 'Register' : 'Sign in'}
              </button>
            </>
          ) : (
            <>
              <input
                type="password"
                placeholder="New password (min 8 chars)"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="login-input"
                required
                autoComplete="new-password"
              />
              <input
                type="password"
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="login-input"
                required
                autoComplete="new-password"
              />
              <button type="button" className="btn btn-primary login-btn" disabled={submitting} onClick={handleCompleteRecovery}>
                {submitting ? 'Please wait...' : 'Set new password'}
              </button>
            </>
          )}
          {!isRegister && !isRecoveryMode && (
            <button
              type="button"
              className="login-toggle"
              onClick={handleForgotPassword}
              disabled={submitting}
              style={{ marginTop: '0.5rem' }}
            >
              Forgot password?
            </button>
          )}
        </form>
        {!isRegister && !isRecoveryMode && !useCloudAuth && preferLocalLogin && supabaseConfigured && (
          <button
            type="button"
            className="login-toggle"
            onClick={() => {
              setUseCloudAuth(true);
              setError('');
              setInfo('Using cloud sign-in (Supabase). Use the email and password from your Supabase project.');
            }}
            style={{ display: 'block', width: '100%', marginTop: '0.5rem' }}
          >
            Use organisation sign-in (Supabase) instead
          </button>
        )}
        {!isRecoveryMode && (
          <button
            type="button"
            className="login-toggle"
            onClick={() => { setIsRegister(!isRegister); setError(''); setInfo(''); }}
          >
            {isRegister ? 'Already have an account? Sign in' : 'Need an account? Register'}
          </button>
        )}
      </div>
    </div>
  );
}
