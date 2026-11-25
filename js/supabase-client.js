import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_CONFIG } from './config.js';

export const isSupabaseConfigured =
  Boolean(SUPABASE_CONFIG.URL) &&
  !SUPABASE_CONFIG.URL.includes('YOUR_PROJECT_ID') &&
  Boolean(SUPABASE_CONFIG.ANON_KEY) &&
  !SUPABASE_CONFIG.ANON_KEY.includes('YOUR_SUPABASE_ANON_KEY');

export const supabase = createClient(SUPABASE_CONFIG.URL, SUPABASE_CONFIG.ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
