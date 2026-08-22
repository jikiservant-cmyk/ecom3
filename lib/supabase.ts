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
export const DRUM_PALACE_COMPLETE_SCHEMA_SQL = `-- Drum Palace Complete Supabase PostgreSQL Schema
-- Run this script in the Supabase SQL Editor (https://supabase.com/dashboard/project/_/sql)

-- 1. Create Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Profiles Table (linked to Supabase auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  phone TEXT,
  role TEXT DEFAULT 'customer' CHECK (role IN ('customer', 'admin', 'staff')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Categories Table
CREATE TABLE IF NOT EXISTS public.categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Products Table
CREATE TABLE IF NOT EXISTS public.products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
  category TEXT,
  price NUMERIC NOT NULL DEFAULT 0,
  original_price NUMERIC,
  rating NUMERIC DEFAULT 4.9,
  reviews_count INTEGER DEFAULT 24,
  sold_count TEXT DEFAULT '500+ sold',
  image_url TEXT,
  badge TEXT,
  specs JSONB DEFAULT '{}'::jsonb,
  sound_profile TEXT,
  variants JSONB DEFAULT '["Standard"]'::jsonb,
  free_shipping BOOLEAN DEFAULT TRUE,
  status TEXT DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Product Variants Table (Normalized)
CREATE TABLE IF NOT EXISTS public.product_variants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id TEXT REFERENCES public.products(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  attributes JSONB DEFAULT '{}'::jsonb,
  price_minor_units BIGINT NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'UGX',
  inventory_quantity INTEGER DEFAULT 50,
  status TEXT DEFAULT 'active',
  position INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Product Images Table
CREATE TABLE IF NOT EXISTS public.product_images (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id TEXT REFERENCES public.products(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  alt_text TEXT,
  position INTEGER DEFAULT 0,
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Orders Table
CREATE TABLE IF NOT EXISTS public.orders (
  id TEXT PRIMARY KEY,
  order_number TEXT UNIQUE NOT NULL,
  customer_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  shipping_address JSONB DEFAULT '{}'::jsonb,
  items JSONB DEFAULT '[]'::jsonb,
  subtotal_minor_units BIGINT DEFAULT 0,
  discount_minor_units BIGINT DEFAULT 0,
  shipping_minor_units BIGINT DEFAULT 0,
  tax_minor_units BIGINT DEFAULT 0,
  total_minor_units BIGINT DEFAULT 0,
  total_amount NUMERIC,
  currency TEXT DEFAULT 'UGX',
  status TEXT DEFAULT 'Processing' CHECK (status IN ('Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled', 'pending', 'processing', 'shipped', 'delivered', 'cancelled')),
  payment_status TEXT DEFAULT 'Paid' CHECK (payment_status IN ('Pending', 'Paid', 'Failed', 'Refunded', 'pending', 'paid', 'failed', 'refunded')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Order Items Table
CREATE TABLE IF NOT EXISTS public.order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id TEXT REFERENCES public.orders(id) ON DELETE CASCADE,
  product_name TEXT NOT NULL,
  product_slug TEXT,
  variant_sku TEXT,
  variant_attributes JSONB DEFAULT '{}'::jsonb,
  unit_price_minor_units BIGINT NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 1,
  line_total_minor_units BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Payments Table
CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id TEXT REFERENCES public.orders(id) ON DELETE SET NULL,
  provider TEXT DEFAULT 'livepay',
  provider_reference TEXT,
  status TEXT DEFAULT 'pending',
  amount_minor_units BIGINT NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'UGX',
  raw_payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. Contact Messages Table
CREATE TABLE IF NOT EXISTS public.contact_messages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  topic TEXT,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'unread',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. Wishlists & Reviews
CREATE TABLE IF NOT EXISTS public.wishlists (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES public.products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, product_id)
);

CREATE TABLE IF NOT EXISTS public.reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id TEXT REFERENCES public.products(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  user_email TEXT,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  verified_purchase BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 12. Store Settings Table
CREATE TABLE IF NOT EXISTS public.store_settings (
  id TEXT PRIMARY KEY DEFAULT 'default_settings',
  settings JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 13. Enable Row Level Security (RLS) with Permissive Public Policies for E-commerce
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wishlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_settings ENABLE ROW LEVEL SECURITY;

-- Permissive RLS Policies with Idempotency
DROP POLICY IF EXISTS "Public read categories" ON public.categories;
CREATE POLICY "Public read categories" ON public.categories FOR SELECT USING (true);
DROP POLICY IF EXISTS "Admin manage categories" ON public.categories;
CREATE POLICY "Admin manage categories" ON public.categories FOR ALL USING (true);

DROP POLICY IF EXISTS "Public read products" ON public.products;
CREATE POLICY "Public read products" ON public.products FOR SELECT USING (true);
DROP POLICY IF EXISTS "Admin manage products" ON public.products;
CREATE POLICY "Admin manage products" ON public.products FOR ALL USING (true);

DROP POLICY IF EXISTS "Public read variants" ON public.product_variants;
CREATE POLICY "Public read variants" ON public.product_variants FOR SELECT USING (true);
DROP POLICY IF EXISTS "Admin manage variants" ON public.product_variants;
CREATE POLICY "Admin manage variants" ON public.product_variants FOR ALL USING (true);

DROP POLICY IF EXISTS "Public read images" ON public.product_images;
CREATE POLICY "Public read images" ON public.product_images FOR SELECT USING (true);
DROP POLICY IF EXISTS "Admin manage images" ON public.product_images;
CREATE POLICY "Admin manage images" ON public.product_images FOR ALL USING (true);

DROP POLICY IF EXISTS "Public read profiles" ON public.profiles;
CREATE POLICY "Public read profiles" ON public.profiles FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users manage profiles" ON public.profiles;
CREATE POLICY "Users manage profiles" ON public.profiles FOR ALL USING (true);

DROP POLICY IF EXISTS "Public read orders" ON public.orders;
CREATE POLICY "Public read orders" ON public.orders FOR SELECT USING (true);
DROP POLICY IF EXISTS "Public insert orders" ON public.orders;
CREATE POLICY "Public insert orders" ON public.orders FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "Admin update orders" ON public.orders;
CREATE POLICY "Admin update orders" ON public.orders FOR ALL USING (true);

DROP POLICY IF EXISTS "Public insert order_items" ON public.order_items;
CREATE POLICY "Public insert order_items" ON public.order_items FOR ALL USING (true);
DROP POLICY IF EXISTS "Public insert payments" ON public.payments;
CREATE POLICY "Public insert payments" ON public.payments FOR ALL USING (true);
DROP POLICY IF EXISTS "Public insert contact_messages" ON public.contact_messages;
CREATE POLICY "Public insert contact_messages" ON public.contact_messages FOR ALL USING (true);
DROP POLICY IF EXISTS "Public read/write reviews" ON public.reviews;
CREATE POLICY "Public read/write reviews" ON public.reviews FOR ALL USING (true);
DROP POLICY IF EXISTS "Public read/write wishlists" ON public.wishlists;
CREATE POLICY "Public read/write wishlists" ON public.wishlists FOR ALL USING (true);
DROP POLICY IF EXISTS "Public read/write store_settings" ON public.store_settings;
CREATE POLICY "Public read/write store_settings" ON public.store_settings FOR ALL USING (true);

-- Trigger to auto-create public.profiles on new Auth signups
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    COALESCE(new.raw_user_meta_data->>'role', 'customer')
  )
  ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name);
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- 13. Ensure 'products' Storage Bucket Exists & is Public
INSERT INTO storage.buckets (id, name, public)
VALUES ('products', 'products', true)
ON CONFLICT (id) DO UPDATE SET public = true;

CREATE POLICY "Public read products bucket" ON storage.objects FOR SELECT USING (bucket_id = 'products');
CREATE POLICY "Public insert products bucket" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'products');
CREATE POLICY "Public update products bucket" ON storage.objects FOR UPDATE USING (bucket_id = 'products');
CREATE POLICY "Public delete products bucket" ON storage.objects FOR DELETE USING (bucket_id = 'products');
`;
