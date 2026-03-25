import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { auth as authApi, tryRestoreExpressSessionFromSupabase } from '../lib/api';
import { getSupabaseBrowserClient } from '../lib/supabaseClient';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await authApi.me();
        if (!cancelled) setUser(data?.user);
      } catch {
        const restored = await tryRestoreExpressSessionFromSupabase();
        if (cancelled) return;
        if (restored) {
          try {
            const data = await authApi.me();
            if (!cancelled) setUser(data?.user);
          } catch {
            if (!cancelled) setUser(null);
          }
        } else if (!cancelled) {
          setUser(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = async (email, password) => {
    const data = await authApi.login(email, password);
    // Use login payload — avoids a second /auth/me before the session cookie is applied (Safari timing).
    setUser(data?.user ?? null);
    return data;
  };

  const register = async (email, password, name) => {
    const data = await authApi.register(email, password, name);
    setUser(data?.user ?? null);
    return data;
  };

  /**
   * @returns {Promise<{ needs_org_setup?: boolean, awaiting_email_confirm?: boolean }>}
   */
  const loginWithSupabase = async (email, password) => {
    const sb = getSupabaseBrowserClient();
    if (!sb) throw new Error('Supabase client is not configured (set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY).');
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    const token = data.session?.access_token;
    if (!token) throw new Error('No session returned from Supabase.');
    const body = await authApi.supabaseSession(token);
    if (body.needs_org_setup) return { needs_org_setup: true };
    const meData = await authApi.me();
    setUser(meData?.user ?? null);
    return {};
  };

  /**
   * @returns {Promise<{ needs_org_setup?: boolean, awaiting_email_confirm?: boolean }>}
   */
  const registerWithSupabase = async (email, password, name) => {
    const sb = getSupabaseBrowserClient();
    if (!sb) throw new Error('Supabase client is not configured.');
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const emailRedirectTo = origin ? `${origin}/login` : undefined;
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: name || null },
        ...(emailRedirectTo ? { emailRedirectTo } : {}),
      },
    });
    if (error) throw new Error(error.message);
    if (data.session?.access_token) {
      const body = await authApi.supabaseSession(data.session.access_token);
      if (body.needs_org_setup) return { needs_org_setup: true };
      const meData = await authApi.me();
      setUser(meData?.user ?? null);
      return {};
    }
    return {
      awaiting_email_confirm: true,
      confirmEmail: data.user?.email || email,
    };
  };

  const logout = async () => {
    await authApi.logout();
    const sb = getSupabaseBrowserClient();
    if (sb) await sb.auth.signOut();
    setUser(null);
  };

  const updateSettings = async (data) => {
    const res = await authApi.updateSettings(data);
    setUser(res.user);
    return res;
  };

  const refreshUser = useCallback(async () => {
    const data = await authApi.me();
    setUser(data?.user ?? null);
    return data?.user;
  }, []);

  const changePassword = async (currentPassword, newPassword) => {
    await authApi.changePassword(currentPassword, newPassword);
  };

  const isAdmin = user?.role === 'admin';
  const isDelegate = user?.role === 'delegate';
  const canManageUsers = isAdmin || (isDelegate && user?.delegate_grant_active);
  const canAccessCaseTasks = isAdmin || (isDelegate && user?.delegate_grant_active) || user?.role === 'support_coordinator';

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        register,
        loginWithSupabase,
        registerWithSupabase,
        logout,
        updateSettings,
        refreshUser,
        changePassword,
        isAdmin,
        isDelegate,
        canManageUsers,
        canAccessCaseTasks
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
