/**
 * Drum Palace Supabase schema — HARDENED.
 *
 * Security model:
 * - anon: read catalog only + insert its own checkout/contact rows (RLS-scoped).
 * - authenticated: own-row access; admin checks go through is_admin().
 * - privileged tables (payments, webhook events) are service-role only: no
 *   grants to anon/authenticated at all.
 * - The old schema granted ALL to anon with USING (true) policies — that is gone.
 *
 * IMPORTANT: after running this script, set SUPABASE_SERVICE_ROLE_KEY in the app
 * environment. Server routes fail closed without it for privileged operations.
 */
export const DRUM_PALACE_COMPLETE_SCHEMA_SQL = `-- Drum Palace Supabase Schema (hardened) — run in the Supabase SQL Editor
-- Safe to re-run (idempotent via IF NOT EXISTS / DROP POLICY guards).

-- 1. Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Profiles (linked to auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin', 'staff')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Categories
CREATE TABLE IF NOT EXISTS public.categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Products
CREATE TABLE IF NOT EXISTS public.products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
  category TEXT,
  price NUMERIC NOT NULL DEFAULT 0,
  original_price NUMERIC,
  rating NUMERIC DEFAULT 0,
  reviews_count INTEGER DEFAULT 0,
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

-- 5. Product variants
CREATE TABLE IF NOT EXISTS public.product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id TEXT REFERENCES public.products(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  attributes JSONB DEFAULT '{}'::jsonb,
  price_minor_units BIGINT NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'UGX',
  inventory_quantity INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  position INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Product images
CREATE TABLE IF NOT EXISTS public.product_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id TEXT REFERENCES public.products(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  alt_text TEXT,
  position INTEGER DEFAULT 0,
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Orders
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
  status TEXT DEFAULT 'Pending' CHECK (status IN ('Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled', 'pending', 'processing', 'shipped', 'delivered', 'cancelled')),
  payment_status TEXT DEFAULT 'Pending' CHECK (payment_status IN ('Pending', 'Paid', 'Failed', 'Refunded', 'pending', 'paid', 'failed', 'refunded')),
  -- Reason recorded whenever an admin moves payment_status by hand. Manual
  -- Paid/Refunded writes bypass the gateway, so they must leave a trail.
  payment_note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- For databases created before payment_note existed (CREATE TABLE IF NOT EXISTS
-- will not add a column to a table that is already there).
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_note TEXT;

-- 8. Order items
CREATE TABLE IF NOT EXISTS public.order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id TEXT REFERENCES public.orders(id) ON DELETE CASCADE,
  product_name TEXT NOT NULL,
  product_slug TEXT,
  variant_sku TEXT,
  variant_attributes JSONB DEFAULT '{}'::jsonb,
  unit_price_minor_units BIGINT NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  line_total_minor_units BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Payments — SERVICE ROLE ONLY (no grants to anon/authenticated below)
CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id TEXT REFERENCES public.orders(id) ON DELETE SET NULL,
  provider TEXT DEFAULT 'livepay',
  provider_reference TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'refunded')),
  amount_minor_units BIGINT NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'UGX',
  raw_payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. Contact messages
CREATE TABLE IF NOT EXISTS public.contact_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  topic TEXT,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'unread',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. Wishlists & reviews
CREATE TABLE IF NOT EXISTS public.wishlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES public.products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, product_id)
);

CREATE TABLE IF NOT EXISTS public.reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id TEXT REFERENCES public.products(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  user_email TEXT,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  verified_purchase BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 12. Store settings (single row)
CREATE TABLE IF NOT EXISTS public.store_settings (
  id TEXT PRIMARY KEY DEFAULT 'default_settings',
  settings JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 13. Carts
CREATE TABLE IF NOT EXISTS public.carts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  session_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.cart_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id UUID REFERENCES public.carts(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES public.products(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 14. Webhook event log (idempotency)
CREATE TABLE IF NOT EXISTS public.payment_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'livepay',
  event_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT payment_webhook_events_event_id_key UNIQUE (provider, event_id)
);

-- 15. Indexes
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON public.orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders (status);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON public.order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON public.payments (order_id);
CREATE INDEX IF NOT EXISTS idx_reviews_product_id ON public.reviews (product_id);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON public.products (category_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON public.product_variants (product_id);
CREATE INDEX IF NOT EXISTS idx_product_images_product_id ON public.product_images (product_id);
CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at ON public.contact_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cart_items_cart_id ON public.cart_items (cart_id);

-- 16. Least-privilege grants
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated;

GRANT SELECT ON public.categories, public.products, public.product_variants,
  public.product_images, public.reviews, public.store_settings TO anon, authenticated;

-- Checkout writes (RLS narrows these further)
-- anon may NOT insert orders: order rows are written only by the server under
-- the service role. Granting anon INSERT let a caller forge an order with an
-- arbitrary total (e.g. 1 UGX for a 5,000 UGX cart) and then pay it.
GRANT SELECT ON public.orders TO anon;
GRANT SELECT, INSERT ON public.orders TO authenticated;
GRANT UPDATE, DELETE ON public.orders TO authenticated;
GRANT SELECT ON public.order_items TO anon;
GRANT SELECT, INSERT ON public.order_items TO authenticated;
GRANT INSERT ON public.contact_messages TO anon, authenticated;
GRANT SELECT, UPDATE ON public.contact_messages TO authenticated;
GRANT INSERT ON public.reviews TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wishlists TO authenticated;
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
GRANT UPDATE ON public.store_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.carts, public.cart_items TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
-- NOTE: public.payments and public.payment_webhook_events intentionally have NO
-- grants for anon/authenticated; only the service role (BYPASSRLS) touches them.

-- 17. Admin helper
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN FALSE;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;

-- 18. New users are ALWAYS customers; admins are provisioned manually in the DB.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    'customer'
  )
  ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name);
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- 19. Protect the role column: only existing admins may grant/revoke roles.
CREATE OR REPLACE FUNCTION public.protect_profile_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'role changes require administrator privileges' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_protect_role ON public.profiles;
CREATE TRIGGER profiles_protect_role
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE PROCEDURE public.protect_profile_role();

-- 20. Atomic order creation with stock decrement (used by the API server).
-- Drop any older signature first so CREATE OR REPLACE can change the argument list.
DROP FUNCTION IF EXISTS public.create_order_v2(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BIGINT, TIMESTAMPTZ);
CREATE OR REPLACE FUNCTION public.create_order_v2(
  p_order_id TEXT,
  p_order_number TEXT,
  p_customer_id UUID,
  p_customer_name TEXT,
  p_customer_email TEXT,
  p_customer_phone TEXT,
  p_shipping_address TEXT,
  p_items JSONB,
  p_subtotal_minor_units BIGINT,
  p_shipping_minor_units BIGINT,
  p_total_minor_units BIGINT,
  p_created_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  item RECORD;
  v_product_id TEXT;
  v_variant_id UUID;
BEGIN
  INSERT INTO public.orders (
    id, order_number, customer_id, customer_name, customer_email, customer_phone,
    shipping_address, items, status, payment_status, currency,
    subtotal_minor_units, discount_minor_units, shipping_minor_units, tax_minor_units,
    total_minor_units, total_amount, created_at, updated_at
  ) VALUES (
    p_order_id, p_order_number, p_customer_id, p_customer_name, p_customer_email, p_customer_phone,
    jsonb_build_object('address', COALESCE(p_shipping_address, '')), p_items, 'Pending', 'Pending', 'UGX',
    p_subtotal_minor_units, 0, p_shipping_minor_units, 0,
    p_total_minor_units, ROUND(p_total_minor_units / 100.0, 2), p_created_at, p_created_at
  );

  FOR item IN
    SELECT * FROM jsonb_to_recordset(p_items)
      AS x("productName" TEXT, quantity INT, price NUMERIC, variant TEXT)
  LOOP
    INSERT INTO public.order_items (
      order_id, product_name, product_slug, variant_sku, variant_attributes,
      unit_price_minor_units, quantity, line_total_minor_units, created_at
    ) VALUES (
      p_order_id, item."productName",
      regexp_replace(lower(item."productName"), '[^a-z0-9]+', '-', 'g'),
      COALESCE(item.variant, 'Standard'), jsonb_build_object('variant', COALESCE(item.variant, 'Standard')),
      ROUND(COALESCE(item.price, 0) * 100)::BIGINT,
      item.quantity,
      ROUND(COALESCE(item.price, 0) * 100 * item.quantity)::BIGINT,
      p_created_at
    );

    SELECT p.id INTO v_product_id FROM public.products p
      WHERE p.name = item."productName" AND p.status = 'active' LIMIT 1;
    IF v_product_id IS NOT NULL THEN
      SELECT pv.id INTO v_variant_id FROM public.product_variants pv
        WHERE pv.product_id = v_product_id AND pv.status = 'active'
        ORDER BY pv.position ASC LIMIT 1;
      IF v_variant_id IS NOT NULL THEN
        UPDATE public.product_variants
           SET inventory_quantity = inventory_quantity - item.quantity,
               updated_at = NOW()
         WHERE id = v_variant_id AND inventory_quantity >= item.quantity;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Insufficient stock for product: %', item."productName" USING ERRCODE = 'P0001';
        END IF;
      END IF;
    END IF;
  END LOOP;
END;
$$;

-- Revoked from anon: calling the RPC directly writes orders with caller-chosen
-- totals, bypassing the catalog re-pricing in app/api/orders/route.ts.
GRANT EXECUTE ON FUNCTION public.create_order_v2(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ) TO authenticated;

-- 20b. CRITICAL — order state may never be supplied by a client.
-- public.orders is INSERTable by anon/authenticated (guest checkout) and
-- payment_status is a plain settable column whose CHECK constraint permits
-- 'Paid'. Without a trigger, any browser holding the public anon key could
-- PostgREST-insert an order already marked Paid for 1 UGX, defeating the
-- server-side catalog re-pricing and the webhook-only Paid transition.
-- Force EVERY insert to Pending regardless of caller: the server's order
-- creation path (create_order_v2 and the fallback insert) always writes
-- Pending anyway, so this costs nothing and closes the hole at the database.
CREATE OR REPLACE FUNCTION public.orders_force_pending()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.status := 'Pending';
  NEW.payment_status := 'Pending';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_force_pending ON public.orders;
CREATE TRIGGER orders_force_pending
  BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE PROCEDURE public.orders_force_pending();

-- Payment state advances only via the verified gateway webhook (service role)
-- or an explicit admin reconciliation. Blocks direct PostgREST writes.
CREATE OR REPLACE FUNCTION public.orders_protect_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'payment_status changes require the payment service role' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_protect_payment_status ON public.orders;
CREATE TRIGGER orders_protect_payment_status
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE PROCEDURE public.orders_protect_payment_status();

-- Line items may only be attached to an order that is still Pending, so an
-- attacker cannot grow an already-paid order after the fact.
CREATE OR REPLACE FUNCTION public.order_items_require_pending_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment_status TEXT;
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;
  SELECT o.payment_status INTO v_payment_status
    FROM public.orders o
   WHERE o.id = NEW.order_id;
  IF v_payment_status IS NULL OR v_payment_status <> 'Pending' THEN
    RAISE EXCEPTION 'cannot modify line items on a paid or missing order' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_items_require_pending_order ON public.order_items;
CREATE TRIGGER order_items_require_pending_order
  BEFORE INSERT ON public.order_items
  FOR EACH ROW EXECUTE PROCEDURE public.order_items_require_pending_order();

-- 20c. Remove LEGACY permissive policies from the pre-audit schema (if present).
-- The grants were already revoked above, but the policies themselves must go.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT pol.polname, cls.relname
    FROM pg_policy pol
    JOIN pg_class cls ON cls.oid = pol.polrelid
    JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
    WHERE nsp.nspname = 'public'
      AND pol.polname IN (
        'Public read categories','Admin manage categories',
        'Public read products','Admin manage products',
        'Public read variants','Admin manage variants',
        'Public read images','Admin manage images',
        'Public read profiles','Users manage profiles',
        'Public read orders','Public insert orders','Admin update orders',
        'Public insert order_items','Public insert payments',
        'Public insert contact_messages',
        'Public read/write reviews','Public read/write wishlists',
        'Public read/write store_settings'
      )
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', r.polname, r.relname);
  END LOOP;
END $$;

DROP POLICY IF EXISTS "Public read products bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public insert products bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public update products bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public delete products bucket" ON storage.objects;

-- 21. Row Level Security
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
ALTER TABLE public.carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cart_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_webhook_events ENABLE ROW LEVEL SECURITY;

-- Catalog: public read, admin write
DROP POLICY IF EXISTS "Catalog public read" ON public.categories;
CREATE POLICY "Catalog public read" ON public.categories FOR SELECT USING (true);
DROP POLICY IF EXISTS "Catalog admin write" ON public.categories;
CREATE POLICY "Catalog admin write" ON public.categories FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Products public read" ON public.products;
CREATE POLICY "Products public read" ON public.products FOR SELECT USING (true);
DROP POLICY IF EXISTS "Products admin write" ON public.products;
CREATE POLICY "Products admin write" ON public.products FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Variants public read" ON public.product_variants;
CREATE POLICY "Variants public read" ON public.product_variants FOR SELECT USING (true);
DROP POLICY IF EXISTS "Variants admin write" ON public.product_variants;
CREATE POLICY "Variants admin write" ON public.product_variants FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Images public read" ON public.product_images;
CREATE POLICY "Images public read" ON public.product_images FOR SELECT USING (true);
DROP POLICY IF EXISTS "Images admin write" ON public.product_images;
CREATE POLICY "Images admin write" ON public.product_images FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Profiles: self read/update, admin read/update (role column trigger-protected)
DROP POLICY IF EXISTS "Profiles self read" ON public.profiles;
CREATE POLICY "Profiles self read" ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid() OR public.is_admin());
DROP POLICY IF EXISTS "Profiles self update" ON public.profiles;
CREATE POLICY "Profiles self update" ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid() OR public.is_admin()) WITH CHECK (id = auth.uid() OR public.is_admin());

-- Orders: server/guest insert allowed (API validates), owner+admin read, admin update/delete
DROP POLICY IF EXISTS "Orders insert" ON public.orders;
CREATE POLICY "Orders insert" ON public.orders FOR INSERT TO authenticated WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS "Orders owner or admin read" ON public.orders;
CREATE POLICY "Orders owner or admin read" ON public.orders FOR SELECT TO authenticated USING (customer_id = auth.uid() OR public.is_admin());
DROP POLICY IF EXISTS "Orders admin update" ON public.orders;
CREATE POLICY "Orders admin update" ON public.orders FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS "Orders admin delete" ON public.orders;
CREATE POLICY "Orders admin delete" ON public.orders FOR DELETE TO authenticated USING (public.is_admin());

-- Order items: only for orders that exist; owner+admin read
DROP POLICY IF EXISTS "Order items insert" ON public.order_items;
CREATE POLICY "Order items insert" ON public.order_items FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id)
);
DROP POLICY IF EXISTS "Order items owner read" ON public.order_items;
CREATE POLICY "Order items owner read" ON public.order_items FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND (o.customer_id = auth.uid() OR public.is_admin()))
);

-- Payments: no policies for anon/authenticated (service role only).

-- Contact messages: anyone can submit, only admins read/manage
DROP POLICY IF EXISTS "Contact submit" ON public.contact_messages;
CREATE POLICY "Contact submit" ON public.contact_messages FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "Contact admin manage" ON public.contact_messages;
CREATE POLICY "Contact admin manage" ON public.contact_messages FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Reviews: public read, signed-in users insert, admin manages
DROP POLICY IF EXISTS "Reviews public read" ON public.reviews;
CREATE POLICY "Reviews public read" ON public.reviews FOR SELECT USING (true);
DROP POLICY IF EXISTS "Reviews signed-in insert" ON public.reviews;
CREATE POLICY "Reviews signed-in insert" ON public.reviews FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "Reviews admin manage" ON public.reviews;
CREATE POLICY "Reviews admin manage" ON public.reviews FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Wishlists: owner only
DROP POLICY IF EXISTS "Wishlists owner all" ON public.wishlists;
CREATE POLICY "Wishlists owner all" ON public.wishlists FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Store settings: public read, admin write
DROP POLICY IF EXISTS "Settings public read" ON public.store_settings;
CREATE POLICY "Settings public read" ON public.store_settings FOR SELECT USING (true);
DROP POLICY IF EXISTS "Settings admin write" ON public.store_settings;
CREATE POLICY "Settings admin write" ON public.store_settings FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Carts: owner only
DROP POLICY IF EXISTS "Carts owner all" ON public.carts;
CREATE POLICY "Carts owner all" ON public.carts FOR ALL TO authenticated USING (customer_id = auth.uid()) WITH CHECK (customer_id = auth.uid());
DROP POLICY IF EXISTS "Cart items owner all" ON public.cart_items;
CREATE POLICY "Cart items owner all" ON public.cart_items FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM public.carts c WHERE c.id = cart_id AND c.customer_id = auth.uid())
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.carts c WHERE c.id = cart_id AND c.customer_id = auth.uid())
);

-- Webhook events: no policies for anon/authenticated (service role only).

-- 22. Storage: products bucket is public-read, admin-write only.
INSERT INTO storage.buckets (id, name, public)
VALUES ('products', 'products', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "Public read products bucket" ON storage.objects;
CREATE POLICY "Public read products bucket" ON storage.objects FOR SELECT USING (bucket_id = 'products');
DROP POLICY IF EXISTS "Public insert products bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public update products bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public delete products bucket" ON storage.objects;
DROP POLICY IF EXISTS "Admin insert products bucket" ON storage.objects;
CREATE POLICY "Admin insert products bucket" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'products' AND public.is_admin());
DROP POLICY IF EXISTS "Admin update products bucket" ON storage.objects;
CREATE POLICY "Admin update products bucket" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'products' AND public.is_admin());
DROP POLICY IF EXISTS "Admin delete products bucket" ON storage.objects;
CREATE POLICY "Admin delete products bucket" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'products' AND public.is_admin());
`;
