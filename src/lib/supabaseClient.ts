import { createClient } from '@supabase/supabase-js';

// Publishable key is designed for browser use; database access is protected by RLS.
// Never put a Supabase service_role/secret key in this file or in a Vite variable.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://pnzxxdaxvjfacztussxl.supabase.co';
const supabasePublishableKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  'sb_publishable_Si7tuapTwX1pk68nXeapBQ_8WJOvOlH';

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  realtime: {
    params: { eventsPerSecond: 10 },
  },
});

export const BILLION_SUPABASE_PROJECT = 'pnzxxdaxvjfacztussxl';
