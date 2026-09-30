import { createClient } from '@supabase/supabase-js';
import { config } from './env.js';

// The user's JWT reaches PostgREST, so RLS remains the authorization boundary.
export function userDatabase(token: string) {
  if (!config.SUPABASE_URL || !config.SUPABASE_PUBLISHABLE_KEY) {
    throw Object.assign(new Error('Cloud library is not configured'), { statusCode: 503 });
  }
  return createClient(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
