import { createClient } from '@supabase/supabase-js';

let _client = null;

/** Browser Supabase client; null when Vite env is not set. */
export function getSupabaseBrowserClient() {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return null;
  if (!_client) {
    _client = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
  }
  return _client;
}
