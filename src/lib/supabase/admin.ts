import { createClient } from '@supabase/supabase-js';

export function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase admin env variables for API');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export async function getPricingMap() {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('pricing_configs')
    .select('key,value');

  if (error) throw new Error(error.message);

  const map = new Map<string, number>();
  (data ?? []).forEach((row) => {
    map.set(row.key, row.value);
  });
  return map;
}
