import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Database } from './database.types';

// Key for client-side storage of user-provided Supabase credentials (if entered via UI)
export const LOCAL_SUPABASE_CONFIG_KEY = 'drum_palace_supabase_credentials_v1';

// Read config from env or localStorage (if in browser)
export function getActiveSupabaseConfig(): { url: string; anonKey: string; source: 'env' | 'local' | 'none' } {
  const envUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const envKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (
    envUrl &&
    envKey &&
    !envUrl.includes('placeholder') &&
    !envKey.includes('placeholder') &&
    envUrl.startsWith('https://')
  ) {
    return { url: envUrl.trim(), anonKey: envKey.trim(), source: 'env' };
  }

  if (typeof window !== 'undefined') {
    try {
      const stored = localStorage.getItem(LOCAL_SUPABASE_CONFIG_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.url && parsed.anonKey && parsed.url.startsWith('https://')) {
          return { url: parsed.url.trim(), anonKey: parsed.anonKey.trim(), source: 'local' };
        }
      }
    } catch {
      // Ignore storage error
    }
  }

  return {
    url: 'https://placeholder.supabase.co',
    anonKey: 'placeholder-anon-key',
    source: 'none',
  };
}

let activeClient: SupabaseClient<Database> | null = null;
let currentClientUrl = '';
let currentClientKey = '';

export function getSupabaseClient(): SupabaseClient<Database> {
  const config = getActiveSupabaseConfig();
  if (!activeClient || currentClientUrl !== config.url || currentClientKey !== config.anonKey) {
    currentClientUrl = config.url;
    currentClientKey = config.anonKey;
    activeClient = createClient<Database>(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return activeClient;
}

// Proxy export so existing calls like `supabase.from(...)` work seamlessly and dynamically
export const supabase = new Proxy({} as SupabaseClient<Database>, {
  get(_target, prop) {
    const client = getSupabaseClient();
    const val = (client as any)[prop];
    if (typeof val === 'function') {
      return val.bind(client);
    }
    return val;
  },
});

export const isSupabaseConfigured = Boolean(
  typeof window !== 'undefined'
    ? getActiveSupabaseConfig().source !== 'none'
    : process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
      !process.env.NEXT_PUBLIC_SUPABASE_URL.includes('placeholder') &&
      process.env.NEXT_PUBLIC_SUPABASE_URL.startsWith('https://')
);

export function saveSupabaseConfig(url: string, anonKey: string) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(
      LOCAL_SUPABASE_CONFIG_KEY,
      JSON.stringify({ url: url.trim(), anonKey: anonKey.trim(), configuredAt: new Date().toISOString() })
    );
    activeClient = null; // force re-creation
  } catch (e) {
    console.error('Failed to save Supabase config to local storage', e);
  }
}

export function clearSupabaseConfig() {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(LOCAL_SUPABASE_CONFIG_KEY);
    activeClient = null;
  } catch (e) {
    console.error('Failed to clear Supabase config', e);
  }
}

export interface ConnectionDiagnosticResult {
  isConfigured: boolean;
  url: string;
  source: 'env' | 'local' | 'none';
  overallStatus: 'connected' | 'partial' | 'disconnected' | 'unconfigured';
  responseTimeMs: number;
  checks: {
    name: string;
    status: 'pass' | 'fail' | 'warning' | 'skipped';
    message: string;
    details?: any;
  }[];
}

/**
 * Perform a live, comprehensive multi-point diagnostic check on the Supabase connection
 */
export async function testSupabaseConnection(): Promise<ConnectionDiagnosticResult> {
  const startTime = Date.now();
  const config = getActiveSupabaseConfig();

  if (config.source === 'none') {
    return {
      isConfigured: false,
      url: config.url,
      source: config.source,
      overallStatus: 'unconfigured',
      responseTimeMs: 0,
      checks: [
        {
          name: 'Configuration Check',
          status: 'warning',
          message: 'NEXT_PUBLIC_SUPABASE_URL & NEXT_PUBLIC_SUPABASE_ANON_KEY are not configured yet. App is using local offline persistence.',
        },
      ],
    };
  }

  const client = getSupabaseClient();
  const checks: ConnectionDiagnosticResult['checks'] = [];
  let passedCount = 0;

  // 1. Check Auth Service
  try {
    const { error: authErr } = await client.auth.getSession();
    if (authErr) {
      checks.push({
        name: 'Supabase Auth Service',
        status: 'fail',
        message: `Auth check failed: ${authErr.message}`,
      });
    } else {
      passedCount++;
      checks.push({
        name: 'Supabase Auth Service',
        status: 'pass',
        message: 'Auth service reachable & session storage operational.',
      });
    }
  } catch (err: any) {
    checks.push({
      name: 'Supabase Auth Service',
      status: 'fail',
      message: `Auth service exception: ${err?.message || err}`,
    });
  }

  // 2. Check Categories Table
  try {
    const { data: cats, error: catErr, count } = await (client.from('categories') as any)
      .select('id, name, slug', { count: 'exact' })
      .limit(5);

    if (catErr) {
      checks.push({
        name: 'Categories Table (`public.categories`)',
        status: 'warning',
        message: `Table query notice: ${catErr.message}. You can run the schema migration script below.`,
        details: catErr,
      });
    } else {
      passedCount++;
      checks.push({
        name: 'Categories Table (`public.categories`)',
        status: 'pass',
        message: `Connected (${count ?? cats?.length ?? 0} categories found).`,
        details: cats,
      });
    }
  } catch (err: any) {
    checks.push({
      name: 'Categories Table (`public.categories`)',
      status: 'warning',
      message: `Exception: ${err?.message || err}`,
    });
  }

  // 3. Check Products Table
  try {
    const { data: prods, error: prodErr, count } = await (client.from('products') as any)
      .select('id, name', { count: 'exact' })
      .limit(5);

    if (prodErr) {
      checks.push({
        name: 'Products Table (`public.products`)',
        status: 'warning',
        message: `Table query notice: ${prodErr.message}.`,
        details: prodErr,
      });
    } else {
      passedCount++;
      checks.push({
        name: 'Products Table (`public.products`)',
        status: 'pass',
        message: `Connected (${count ?? prods?.length ?? 0} products found).`,
        details: prods,
      });
    }
  } catch (err: any) {
    checks.push({
      name: 'Products Table (`public.products`)',
      status: 'warning',
      message: `Exception: ${err?.message || err}`,
    });
  }

  // 4. Check Orders Table
  try {
    const { data: ords, error: ordErr, count } = await (client.from('orders') as any)
      .select('id', { count: 'exact' })
      .limit(5);

    if (ordErr) {
      checks.push({
        name: 'Orders Table (`public.orders`)',
        status: 'warning',
        message: `Table query notice: ${ordErr.message}`,
      });
    } else {
      passedCount++;
      checks.push({
        name: 'Orders Table (`public.orders`)',
        status: 'pass',
        message: `Connected (${count ?? ords?.length ?? 0} orders recorded).`,
      });
    }
  } catch (err: any) {
    checks.push({
      name: 'Orders Table (`public.orders`)',
      status: 'warning',
      message: `Exception: ${err?.message || err}`,
    });
  }

  // 5. Check Profiles Table
  try {
    const { data: profs, error: profErr, count } = await (client.from('profiles') as any)
      .select('id', { count: 'exact' })
      .limit(5);

    if (profErr) {
      checks.push({
        name: 'Profiles Table (`public.profiles`)',
        status: 'warning',
        message: `Table query notice: ${profErr.message}`,
      });
    } else {
      passedCount++;
      checks.push({
        name: 'Profiles Table (`public.profiles`)',
        status: 'pass',
        message: `Connected (${count ?? profs?.length ?? 0} user profiles).`,
      });
    }
  } catch (err: any) {
    checks.push({
      name: 'Profiles Table (`public.profiles`)',
      status: 'warning',
      message: `Exception: ${err?.message || err}`,
    });
  }

  // 6. Check Storage Bucket (`products`)
  try {
    const { data: bucketList, error: storageErr } = await client.storage.listBuckets();
    if (storageErr) {
      checks.push({
        name: 'Storage Service',
        status: 'warning',
        message: `Storage check notice: ${storageErr.message}`,
      });
    } else {
      const productsBucket = bucketList?.find((b) => b.name === 'products' || b.id === 'products');
      if (productsBucket) {
        passedCount++;
        checks.push({
          name: 'Storage Bucket (`products`)',
          status: 'pass',
          message: `Storage bucket "products" found (${productsBucket.public ? 'Public Access Enabled' : 'Private'}). Direct image uploads ready.`,
        });
      } else {
        checks.push({
          name: 'Storage Bucket (`products`)',
          status: 'warning',
          message: `Bucket "products" not listed (${bucketList?.length || 0} bucket(s) detected). Make sure the "products" bucket is created as Public in your Supabase Storage dashboard.`,
        });
      }
    }
  } catch (err: any) {
    checks.push({
      name: 'Storage Service',
      status: 'warning',
      message: `Storage check notice: ${err?.message || err}`,
    });
  }

  const duration = Date.now() - startTime;
  let overall: ConnectionDiagnosticResult['overallStatus'] = 'disconnected';
  if (passedCount >= 4) overall = 'connected';
  else if (passedCount > 0) overall = 'partial';

  return {
    isConfigured: true,
    url: config.url,
    source: config.source,
    overallStatus: overall,
    responseTimeMs: duration,
    checks,
  };
}

/**
 * Complete, ready-to-run Supabase PostgreSQL Schema with RLS and Indexes
 */
// Hardened schema SQL lives in its own module (was previously inline here with
// permissive GRANT ALL / USING (true) policies — those have been removed).
export { DRUM_PALACE_COMPLETE_SCHEMA_SQL } from './schemaSql';
