import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { normalizeAppRole } from '@nexus-shared/appRoles.js';
import { auth as authApi, tryRestoreExpressSessionFromSupabase } from '../lib/api';
import { clearPreferredProductSurface, readPreferredProductSurface } from '../lib/nexusPreferredProduct.js';
import { getSupabaseBrowserClient } from '../lib/supabaseClient';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authNotice, setAuthNotice] = useState('');

  useEffect(() => {
    const onAuthRequired = (event) => {
      if (event?.detail?.code === 'SESSION_REPLACED') {
        setAuthNotice('You were signed out because this account was used on another device.');
      }
      setUser(null);
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('nexus:auth-required', onAuthRequired);
      return () => window.removeEventListener('nexus:auth-required', onAuthRequired);
    }
    return undefined;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const AUTH_BOOT_TIMEOUT_MS = 12_000;

    const bootstrapAuth = async () => {
      try {
        const data = await authApi.me();
        if (!cancelled) setUser(data?.user);
      } catch (err) {
        if (err?.code === 'SESSION_REPLACED') {
          setAuthNotice('You were signed out because this account was used on another device.');
          if (!cancelled) setUser(null);
          return;
        }
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
      }
    };

    const timeout = new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error('Auth bootstrap timed out')), AUTH_BOOT_TIMEOUT_MS);
    });

    (async () => {
      try {
        await Promise.race([bootstrapAuth(), timeout]);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /** Dual-product users: align session with last-used shell from localStorage (session + optional localStorage). */
  useEffect(() => {
    if (loading || !user?.id) return;
    if (!user.can_use_coordination || !user.can_use_agency) return;
    const pref = readPreferredProductSurface();
    if (!pref || pref === user.active_product) return;
    let cancelled = false;
    (async () => {
      try {
        await authApi.setActiveProduct(pref);
        const data = await authApi.me();
        if (!cancelled && data?.user) setUser(data.user);
      } catch {
        /* keep server default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, user?.id, user?.active_product, user?.can_use_coordination, user?.can_use_agency]);

  const login = async (email, password) => {
    const data = await authApi.login(email, password);
    // Use login payload — avoids a second /auth/me before the session cookie is applied (Safari timing).
    setAuthNotice('');
    setUser(data?.user ?? null);
    return data;
  };

  const register = async (email, password, name, organization_name, products) => {
    const data = await authApi.register(email, password, name, organization_name, products);
    setAuthNotice('');
    setUser(data?.user ?? null);
    return data;
  };

  /**
   * @returns {Promise<{ needs_org_setup?: boolean, awaiting_email_confirm?: boolean }>}
   */
  const loginWithSupabase = async (email, password) => {
    const sb = getSupabaseBrowserClient();
    if (!sb) throw new Error('Sign-in is not set up in this app. Ask your administrator.');
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    const token = data.session?.access_token;
    if (!token) throw new Error('No session returned. Please try signing in again.');
    const body = await authApi.supabaseSession(token);
    if (body.needs_org_setup) return { needs_org_setup: true };
    const meData = await authApi.me();
    setAuthNotice('');
    setUser(meData?.user ?? null);
    return {};
  };

  /**
   * @returns {Promise<{ needs_org_setup?: boolean, awaiting_email_confirm?: boolean }>}
   */
  const registerWithSupabase = async (email, password, name) => {
    const sb = getSupabaseBrowserClient();
    if (!sb) throw new Error('Sign-in is not set up in this app. Ask your administrator.');
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
      setAuthNotice('');
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
    clearPreferredProductSurface();
    const sb = getSupabaseBrowserClient();
    if (sb) await sb.auth.signOut();
    setAuthNotice('');
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

  const normalizedRole = normalizeAppRole(user?.role);
  const isAdmin = normalizedRole === 'admin';
  const isDelegate = normalizedRole === 'delegate';
  const canManageUsers = isAdmin || (isDelegate && user?.delegate_grant_active);
  const canAccessCaseTasks = isAdmin || (isDelegate && user?.delegate_grant_active) || normalizedRole === 'support_coordinator';

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        authNotice,
        clearAuthNotice: () => setAuthNotice(''),
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
