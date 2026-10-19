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
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  -- 'imported' items ship from abroad and take longer; the admin flags them so
  -- customers and dispatch see the difference.
  origin TEXT DEFAULT 'local' CHECK (origin IN ('local', 'imported')),
  status TEXT DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Product variants
CREATE TABLE IF NOT EXISTS public.product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES public.products(id) ON DELETE CASCADE,
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
  product_id UUID REFERENCES public.products(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  alt_text TEXT,
  position INTEGER DEFAULT 0,
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Orders
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  -- Lowercase vocabulary, matching the live database and lib/status.ts. Mixed
  -- case in one column breaks every SQL report and WHERE filter.
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'shipped', 'delivered', 'cancelled')),
  payment_status TEXT DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
  -- Reason recorded whenever an admin moves payment_status by hand. Manual
  -- Paid/Refunded writes bypass the gateway, so they must leave a trail.
  payment_note TEXT,
  -- How the customer intends to pay. Without this, a Cash-on-Delivery order is
  -- indistinguishable from an unpaid Mobile Money order, so COD orders sit in
  -- Pending forever looking like abandoned payments.
  -- 'momo' = LivePay collect-money prompt, 'card' = LivePay hosted card
  -- checkout, 'cod' = cash on delivery.
  payment_method TEXT DEFAULT 'momo' CHECK (payment_method IN ('momo', 'cod', 'card')),
  tracking_number TEXT,
  -- Money already returned to the customer (partial refunds accumulate here).
  refunded_minor_units BIGINT NOT NULL DEFAULT 0,
  -- Immutable pricing basis captured at checkout: unit prices, discounts and
  -- shipping as they were when the customer pressed Pay. Every later check
  -- validates against this instead of re-pricing from live catalog data.
  pricing_snapshot JSONB,
  -- Idempotency key for checkout: a retried request returns the same order.
  client_request_id TEXT,
  -- Guest idempotency scope: one id per browser, so a retried guest checkout is
  -- recognised as the same attempt instead of creating a second order.
  guest_session_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- For databases created before payment_note existed (CREATE TABLE IF NOT EXISTS
-- will not add a column to a table that is already there).
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]'::jsonb;
-- payment_status is what the whole money model hangs on: Pending until a
-- VERIFIED webhook says otherwise. It must exist on databases created before it
-- (CREATE TABLE IF NOT EXISTS does not add columns to an existing table).
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS guest_session_id TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS total_amount NUMERIC;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_note TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS refunded_minor_units BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS client_request_id TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'momo';

-- Card collection is a documented LivePay product, so 'card' is a valid method.
-- Databases created before it existed still carry the two-value CHECK from the
-- original CREATE TABLE; replace it (named constraint, so this is idempotent).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_payment_method_check') THEN
    ALTER TABLE public.orders DROP CONSTRAINT orders_payment_method_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_payment_method_valid') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_payment_method_valid
      CHECK (payment_method IN ('momo', 'cod', 'card')) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS tracking_number TEXT;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS origin TEXT DEFAULT 'local';

-- 7b. Money invariants. NOT VALID so they can be installed on a database that
--     already holds rows: existing rows are left alone, but every new write is
--     checked. '% 100 = 0' encodes "UGX has no circulating subunit" — the amount
--     charged, stored and reconciled is always one whole-shilling integer.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_amounts_whole_shillings') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_amounts_whole_shillings
      CHECK (
        total_minor_units % 100 = 0
        AND subtotal_minor_units % 100 = 0
        AND discount_minor_units % 100 = 0
        AND shipping_minor_units % 100 = 0
        AND tax_minor_units % 100 = 0
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_totals_add_up') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_totals_add_up
      CHECK (total_minor_units = subtotal_minor_units - discount_minor_units + shipping_minor_units + tax_minor_units)
      NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_refund_within_total') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_refund_within_total
      CHECK (refunded_minor_units >= 0 AND refunded_minor_units <= total_minor_units) NOT VALID;
  END IF;
END $$;

-- 8. Order items
CREATE TABLE IF NOT EXISTS public.order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE,
  -- Immutable catalog identity. Valuation must never depend on a product NAME,
  -- which is neither unique nor stable.
  product_id UUID,
  -- The exact variant that was bought. Prices live per variant, so the order
  -- line must record which one, not just the product.
  variant_id UUID REFERENCES public.product_variants(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  product_slug TEXT,
  variant_sku TEXT,
  variant_attributes JSONB DEFAULT '{}'::jsonb,
  unit_price_minor_units BIGINT NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  line_total_minor_units BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS product_id UUID;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS variant_id UUID;

-- 9. Payments — SERVICE ROLE ONLY (no grants to anon/authenticated below)
CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  provider TEXT DEFAULT 'livepay',
  provider_reference TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  -- What we ASKED the gateway to collect, expressed in the row currency
  -- (UGX for mobile money, USD cents for card collection).
  amount_minor_units BIGINT NOT NULL DEFAULT 0,
  -- What the gateway says it actually collected, its fee, and the net — always
  -- in the shop ledger currency (UGX minor units) so revenue totals add up
  -- across payment products. The gateway-currency figures stay in raw_payload.
  settled_amount_minor_units BIGINT,
  fee_minor_units BIGINT NOT NULL DEFAULT 0,
  net_amount_minor_units BIGINT,
  provider_transaction_id TEXT,
  settled_at TIMESTAMPTZ,
  currency TEXT DEFAULT 'UGX',
  raw_payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS settled_amount_minor_units BIGINT;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS fee_minor_units BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS net_amount_minor_units BIGINT;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;

-- 9b. Refunds — the money-out ledger. A refund is NOT a status flip: it is a
--     row here (amount, reason, actor, reference) plus a negative cash-flow row
--     in public.payments. Service role only, like public.payments.
CREATE TABLE IF NOT EXISTS public.refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  amount_minor_units BIGINT NOT NULL CHECK (amount_minor_units > 0 AND amount_minor_units % 100 = 0),
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
  reason TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'manual' CHECK (method IN ('manual', 'gateway')),
  gateway_reference TEXT,
  actor_id UUID,
  actor_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
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
  product_id UUID REFERENCES public.products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, product_id)
);

CREATE TABLE IF NOT EXISTS public.reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES public.products(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  user_email TEXT,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  verified_purchase BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 12b. Store ratings. Unlike product reviews these rate the shop itself, and
-- only a customer with at least one PAID order may leave one. The gate is
-- enforced here as well as in the API so the rule survives a direct
-- PostgREST insert.
CREATE TABLE IF NOT EXISTS public.store_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- One rating per customer: they can change their mind, not spam the score.
  CONSTRAINT store_ratings_one_per_user UNIQUE (user_id)
);

-- Refuse a store rating from anyone who has not actually paid for something.
CREATE OR REPLACE FUNCTION public.store_rating_requires_paid_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF
  IF NEW.user_id IS NULL OR NEW.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'a store rating must belong to the signed-in user' USING ERRCODE = '42501';
  END IF
  IF NOT EXISTS (
    SELECT 1 FROM public.orders o
     WHERE o.customer_id = NEW.user_id
       AND lower(o.payment_status) = 'paid'
  ) THEN
    RAISE EXCEPTION 'only customers with a completed paid order can rate the store' USING ERRCODE = '42501';
  END IF
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS store_rating_requires_paid_order ON public.store_ratings;
CREATE TRIGGER store_rating_requires_paid_order
  BEFORE INSERT OR UPDATE ON public.store_ratings
  FOR EACH ROW EXECUTE PROCEDURE public.store_rating_requires_paid_order();

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
  product_id UUID REFERENCES public.products(id) ON DELETE CASCADE,
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
-- Idempotent checkout: one order per client request key, PER CUSTOMER.
--
-- The application looks a replay up scoped to the caller (customer_id = <me>,
-- or IS NULL for guests). A globally unique key would let anybody who guesses
-- a key block that customer's checkout forever (the insert fails as a duplicate
-- but the scoped lookup finds nothing). Guests are folded into one scope with
-- COALESCE because NULLs are distinct in a unique index.
DROP INDEX IF EXISTS public.idx_orders_client_request_id;
-- Signed-in customers: their user id scopes the retry key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_customer_request_id
  ON public.orders (customer_id, client_request_id)
  WHERE customer_id IS NOT NULL AND client_request_id IS NOT NULL;

-- Guests: the browser session scopes it. A shared 'guest' scope would make one
-- shopper's retry look like another shopper's duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_guest_session_request_id
  ON public.orders (guest_session_id, client_request_id)
  WHERE customer_id IS NULL AND guest_session_id IS NOT NULL AND client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_refunds_order_id ON public.refunds (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_provider_transaction_id ON public.payments (provider_transaction_id);
-- The webhook may receive the gateway's OWN reference for a card transaction
-- (the docs' success example returns a REF-... value, not the one sent).
-- Both are stored; this index makes the fallback lookup cheap.
CREATE INDEX IF NOT EXISTS idx_payments_provider_reference ON public.payments (provider, provider_reference);
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
  public.product_images, public.store_settings TO anon, authenticated;

-- Reviews are public, but the reviewer's email is not: grant the columns the
-- public feed needs, not the row. (RLS still decides which rows are visible.)
GRANT SELECT (id, product_id, user_name, rating, comment, verified_purchase, created_at)
  ON public.reviews TO anon, authenticated;

-- Checkout writes (RLS narrows these further)
-- anon may NOT insert orders: order rows are written only by the server under
-- the service role. Granting anon INSERT let a caller forge an order with an
-- arbitrary total (e.g. 1 UGX for a 5,000 UGX cart) and then pay it.
-- Orders are READ-ONLY for the browser: no anon grant at all (guest tracking
-- goes through the API, which returns a PII-redacted view), and signed-in users
-- read only what RLS shows them. INSERT/UPDATE/DELETE are server-only.
GRANT SELECT ON public.orders TO authenticated;
-- Line items are written only by the server (service role). An anon/authenticated
-- INSERT here let anyone append lines to any pending order, which desynchronised
-- the order total from its items and could strand a legitimate payment.
GRANT SELECT ON public.order_items TO authenticated;
GRANT SELECT ON public.contact_messages TO authenticated;
GRANT INSERT ON public.reviews TO authenticated;
GRANT SELECT ON public.store_ratings TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wishlists TO authenticated;
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
GRANT UPDATE ON public.store_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.carts, public.cart_items TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
-- NOTE: public.payments, public.refunds and public.payment_webhook_events
-- intentionally have NO grants for anon/authenticated; only the service role
-- (BYPASSRLS) touches them.

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
  -- No JWT (SQL editor / migration / service role) is how the first admin is
  -- provisioned. Any browser request carries auth.uid() and must already be
  -- an admin to touch this column.
  IF NEW.role IS DISTINCT FROM OLD.role
     AND auth.uid() IS NOT NULL
     AND NOT public.is_admin() THEN
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
DROP FUNCTION IF EXISTS public.create_order_v2(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BIGINT, BIGINT, BIGINT, BIGINT, JSONB, TEXT, TEXT, TIMESTAMPTZ, TEXT);
DROP FUNCTION IF EXISTS public.create_order_v2(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BIGINT, BIGINT, BIGINT, BIGINT, JSONB, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.create_order_v2(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BIGINT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.create_order_v2(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.create_order_v2(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BIGINT, BIGINT, BIGINT, BIGINT, JSONB, TEXT, TIMESTAMPTZ);
CREATE OR REPLACE FUNCTION public.create_order_v2(
  p_order_id UUID,
  p_order_number TEXT,
  p_customer_id UUID,
  p_customer_name TEXT,
  p_customer_email TEXT,
  p_customer_phone TEXT,
  p_shipping_address TEXT,
  p_items JSONB,
  p_subtotal_minor_units BIGINT,
  p_discount_minor_units BIGINT,
  p_shipping_minor_units BIGINT,
  p_total_minor_units BIGINT,
  p_pricing_snapshot JSONB,
  p_client_request_id TEXT,
  p_payment_method TEXT,
  p_created_at TIMESTAMPTZ,
  p_guest_session_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  item            RECORD;
  v_product_id    UUID;
  v_variant_id    UUID;
  v_catalog_price BIGINT;
  v_net_price     BIGINT;
  v_catalog_sum   BIGINT := 0;
  v_net_sum       BIGINT := 0;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'create_order_v2 is server-only' USING ERRCODE = '42501';
  END IF;

  IF p_subtotal_minor_units % 100 <> 0
     OR p_discount_minor_units % 100 <> 0
     OR p_shipping_minor_units % 100 <> 0
     OR p_total_minor_units % 100 <> 0 THEN
    RAISE EXCEPTION 'order amounts must be whole shillings' USING ERRCODE = '22023';
  END IF;
  IF p_discount_minor_units < 0 OR p_shipping_minor_units < 0 THEN
    RAISE EXCEPTION 'discount and shipping cannot be negative' USING ERRCODE = '22023';
  END IF;
  IF p_total_minor_units <> p_subtotal_minor_units - p_discount_minor_units + p_shipping_minor_units THEN
    RAISE EXCEPTION 'order totals do not add up' USING ERRCODE = '22023';
  END IF;
  IF p_total_minor_units <= 0 THEN
    RAISE EXCEPTION 'order total must be positive' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_payment_method, 'momo') NOT IN ('momo', 'cod', 'card') THEN
    RAISE EXCEPTION 'unsupported payment method' USING ERRCODE = '22023';
  END IF;
  IF p_pricing_snapshot IS NOT NULL
     AND COALESCE((p_pricing_snapshot->>'totalMinorUnits')::BIGINT, -1) <> p_total_minor_units THEN
    RAISE EXCEPTION 'pricing snapshot disagrees with the order total' USING ERRCODE = '22023';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'an order needs at least one line item' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.orders (
    id, order_number, client_request_id, guest_session_id, customer_id,
    customer_name, customer_email, customer_phone,
    shipping_address, items, status, payment_status, payment_method, currency,
    subtotal_minor_units, discount_minor_units, shipping_minor_units, tax_minor_units,
    total_minor_units, total_amount, pricing_snapshot, refunded_minor_units, created_at, updated_at
  ) VALUES (
    p_order_id, p_order_number, p_client_request_id, p_guest_session_id, p_customer_id,
    p_customer_name, p_customer_email, p_customer_phone,
    jsonb_build_object('address', COALESCE(p_shipping_address, '')),
    p_items, 'pending', 'pending',
    CASE WHEN p_payment_method IN ('cod','card') THEN p_payment_method ELSE 'momo' END,
    'UGX',
    p_subtotal_minor_units, p_discount_minor_units, p_shipping_minor_units, 0,
    p_total_minor_units, p_total_minor_units / 100.0, p_pricing_snapshot, 0, p_created_at, p_created_at
  );

  FOR item IN
    SELECT * FROM jsonb_to_recordset(p_items)
      AS x("productName" TEXT, "productId" TEXT, "variantId" TEXT,
           quantity INT, price NUMERIC, variant TEXT)
  LOOP
    IF item.quantity IS NULL OR item.quantity < 1 THEN
      RAISE EXCEPTION 'invalid quantity for %', item."productName" USING ERRCODE = '22023';
    END IF;

    -- ── The product must exist and be active. No name-based fallback: a name is
    --    neither unique nor immutable, and falling back to it is how a cart gets
    --    steered at a cheaper twin.
    v_product_id := CASE
      WHEN COALESCE(item."productId", '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN item."productId"::uuid ELSE NULL END;

    IF v_product_id IS NULL THEN
      RAISE EXCEPTION 'every line needs a valid product id (%)', item."productName" USING ERRCODE = '22023';
    END IF;

    SELECT p.id INTO v_product_id
      FROM public.products p
     WHERE p.id = v_product_id AND p.status = 'active';
    IF v_product_id IS NULL THEN
      RAISE EXCEPTION 'product is not available: %', item."productName" USING ERRCODE = '22023';
    END IF;

    -- ── The variant must exist, be active, and belong to that product.
    v_variant_id := CASE
      WHEN COALESCE(item."variantId", '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN item."variantId"::uuid ELSE NULL END;

    IF v_variant_id IS NOT NULL THEN
      SELECT pv.id, pv.price_minor_units INTO v_variant_id, v_catalog_price
        FROM public.product_variants pv
       WHERE pv.id = v_variant_id
         AND pv.product_id = v_product_id
         AND pv.status = 'active';
      IF v_variant_id IS NULL THEN
        RAISE EXCEPTION 'selected option is not available for %', item."productName" USING ERRCODE = '22023';
      END IF;
    ELSE
      -- No option named: use the product's first active variant, deterministically.
      SELECT pv.id, pv.price_minor_units INTO v_variant_id, v_catalog_price
        FROM public.product_variants pv
       WHERE pv.product_id = v_product_id AND pv.status = 'active'
       ORDER BY pv.position ASC, pv.id ASC
       LIMIT 1;
      IF v_variant_id IS NULL THEN
        RAISE EXCEPTION 'no active option for %', item."productName" USING ERRCODE = '22023';
      END IF;
    END IF;

    -- ── PRICE COMES FROM THE DATABASE, never from the request. The submitted
    --    price is only allowed to be a DISCOUNT on the catalog price (that is
    --    what promotions are); it may never exceed it.
    v_catalog_price := COALESCE(v_catalog_price, 0);
    IF v_catalog_price <= 0 THEN
      RAISE EXCEPTION 'catalog price missing for %', item."productName" USING ERRCODE = '22023';
    END IF;

    v_net_price := ROUND(COALESCE(item.price, 0) * 100)::BIGINT;
    IF v_net_price <= 0 OR v_net_price > v_catalog_price THEN
      RAISE EXCEPTION 'line price for % must be between 1 and the catalog price', item."productName"
        USING ERRCODE = '22023';
    END IF;

    v_catalog_sum := v_catalog_sum + v_catalog_price * item.quantity;
    v_net_sum     := v_net_sum + v_net_price * item.quantity;

    -- ── Stock is held against the VARIANT that was bought. The conditional
    --    UPDATE is the concurrency guard: if another checkout took the last unit
    --    between our read and this write, zero rows match and we abort.
    UPDATE public.product_variants
       SET inventory_quantity = inventory_quantity - item.quantity,
           updated_at = NOW()
     WHERE id = v_variant_id AND inventory_quantity >= item.quantity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Insufficient stock for product: %', item."productName" USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.order_items (
      order_id, product_id, variant_id, product_name, product_slug, variant_sku, variant_attributes,
      unit_price_minor_units, quantity, line_total_minor_units, created_at
    ) VALUES (
      p_order_id,
      v_product_id,
      v_variant_id,
      item."productName",
      regexp_replace(lower(item."productName"), '[^a-z0-9]+', '-', 'g'),
      COALESCE(item.variant, 'Standard'),
      jsonb_build_object('variant', COALESCE(item.variant, 'Standard')),
      v_net_price,
      item.quantity,
      v_net_price * item.quantity,
      p_created_at
    );
  END LOOP;

  -- ── Reconcile the totals against what the DATABASE just priced.
  IF v_catalog_sum <> p_subtotal_minor_units THEN
    RAISE EXCEPTION 'subtotal % does not match catalog prices %', p_subtotal_minor_units, v_catalog_sum
      USING ERRCODE = '22023';
  END IF;
  IF v_net_sum <> p_subtotal_minor_units - p_discount_minor_units THEN
    RAISE EXCEPTION 'line prices and discount do not reconcile (lines %, subtotal % - discount %)',
      v_net_sum, p_subtotal_minor_units, p_discount_minor_units
      USING ERRCODE = '22023';
  END IF;
END;
$fn$;

-- EXECUTE is for the service role ONLY. Order rows are written by the API
-- server, never by a browser holding a user JWT.
REVOKE ALL ON FUNCTION public.create_order_v2(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BIGINT, BIGINT, BIGINT, BIGINT, JSONB, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order_v2(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BIGINT, BIGINT, BIGINT, BIGINT, JSONB, TEXT, TEXT, TIMESTAMPTZ, TEXT) TO service_role;

-- 20a2. Atomic refund recording (server only).
-- Two concurrent refunds (double click, two admin tabs, a retried request) must
-- not together exceed the order total. The application also guards this with an
-- optimistic update, but the real guarantee is here: the order row is locked,
-- the balance re-checked inside the transaction, and the ledger rows written
-- with the counter.
CREATE OR REPLACE FUNCTION public.record_refund(
  p_order_id UUID,
  p_amount_minor_units BIGINT,
  p_reason TEXT,
  p_actor_id UUID,
  p_actor_email TEXT,
  p_gateway_reference TEXT,
  p_created_at TIMESTAMPTZ
) RETURNS TABLE (refund_id UUID, refunded_minor_units BIGINT, fully_refunded BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_refund_id UUID;
  v_new_refunded BIGINT;
  v_full BOOLEAN;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'record_refund is server-only' USING ERRCODE = '42501';
  END IF;
  IF p_amount_minor_units IS NULL OR p_amount_minor_units <= 0 OR p_amount_minor_units % 100 <> 0 THEN
    RAISE EXCEPTION 'invalid refund amount' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'a refund reason is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found' USING ERRCODE = 'P0002';
  END IF;
  IF lower(COALESCE(v_order.payment_status, '')) <> 'paid' THEN
    RAISE EXCEPTION 'only a paid order can be refunded' USING ERRCODE = '22023';
  END IF;
  IF v_order.refunded_minor_units + p_amount_minor_units > v_order.total_minor_units THEN
    RAISE EXCEPTION 'refund exceeds the refundable balance' USING ERRCODE = '22023';
  END IF;

  v_new_refunded := v_order.refunded_minor_units + p_amount_minor_units;
  v_full := v_new_refunded >= v_order.total_minor_units;

  INSERT INTO public.refunds (
    order_id, amount_minor_units, currency, reason, method, gateway_reference,
    actor_id, actor_email, created_at
  ) VALUES (
    p_order_id, p_amount_minor_units, 'UGX', p_reason, 'manual', p_gateway_reference,
    p_actor_id, p_actor_email, p_created_at
  ) RETURNING id INTO v_refund_id;

  INSERT INTO public.payments (
    order_id, provider, provider_reference, status, amount_minor_units,
    settled_amount_minor_units, net_amount_minor_units, currency, raw_payload,
    settled_at, created_at, updated_at
  ) VALUES (
    p_order_id, 'manual', COALESCE(p_gateway_reference, 'REFUND-' || v_order.order_number), 'refunded',
    p_amount_minor_units, -p_amount_minor_units, -p_amount_minor_units, 'UGX',
    jsonb_build_object('kind', 'refund', 'refund_id', v_refund_id, 'reason', p_reason, 'refunded_by', p_actor_id),
    p_created_at, p_created_at, p_created_at
  );

  UPDATE public.orders
     SET refunded_minor_units = v_new_refunded,
         payment_note = p_reason,
         payment_status = CASE WHEN v_full THEN 'refunded' ELSE payment_status END,
         status = CASE WHEN v_full THEN 'cancelled' ELSE status END,
         updated_at = p_created_at
   WHERE id = p_order_id;

  RETURN QUERY SELECT v_refund_id, v_new_refunded, v_full;
END;
$$;

REVOKE ALL ON FUNCTION public.record_refund(UUID, BIGINT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_refund(UUID, BIGINT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role;

-- 20b. CRITICAL — order state may never be supplied by a client.
-- Force EVERY insert to Pending with no money already refunded, regardless of
-- caller: the server's creation path always writes Pending anyway, so this costs
-- nothing and closes the hole where a browser holding the public anon key could
-- PostgREST-insert an order already marked Paid.
CREATE OR REPLACE FUNCTION public.orders_force_pending()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.status := 'pending';
  NEW.payment_status := 'pending';
  NEW.refunded_minor_units := 0;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_force_pending ON public.orders;
CREATE TRIGGER orders_force_pending
  BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE PROCEDURE public.orders_force_pending();

-- Payment state is MONOTONIC:
--   Pending -> Paid | Failed        (gateway webhook or audited admin)
--   Paid    -> Refunded             (refund ledger only)
--   Refunded is terminal.
-- Nothing may move a Paid order back to Failed/Pending: a late or replayed
-- failure notification used to cancel real revenue.
CREATE OR REPLACE FUNCTION public.orders_protect_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  old_status TEXT := lower(COALESCE(OLD.payment_status, ''));
  new_status TEXT := lower(COALESCE(NEW.payment_status, ''));
BEGIN
  IF new_status IS NOT DISTINCT FROM old_status THEN
    RETURN NEW;
  END IF;

  IF old_status = 'paid' AND new_status NOT IN ('paid', 'refunded') THEN
    RAISE EXCEPTION 'a paid order cannot be moved back to %', NEW.payment_status USING ERRCODE = '42501';
  END IF;
  IF old_status = 'refunded' AND new_status <> 'refunded' THEN
    RAISE EXCEPTION 'a refunded order is final' USING ERRCODE = '42501';
  END IF;

  IF new_status IN ('paid', 'refunded')
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

-- The money on a non-pending order is frozen. Repricing a paid order after the
-- fact would rewrite history and break every reconciliation.
CREATE OR REPLACE FUNCTION public.orders_protect_amounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF lower(COALESCE(OLD.payment_status, '')) <> 'pending' THEN
    IF NEW.total_minor_units IS DISTINCT FROM OLD.total_minor_units
       OR NEW.subtotal_minor_units IS DISTINCT FROM OLD.subtotal_minor_units
       OR NEW.discount_minor_units IS DISTINCT FROM OLD.discount_minor_units
       OR NEW.shipping_minor_units IS DISTINCT FROM OLD.shipping_minor_units
       OR NEW.pricing_snapshot IS DISTINCT FROM OLD.pricing_snapshot THEN
      RAISE EXCEPTION 'amounts on a settled order are immutable' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_protect_amounts ON public.orders;
CREATE TRIGGER orders_protect_amounts
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE PROCEDURE public.orders_protect_amounts();

-- Line items are server-written. Even a legitimate owner may not add lines to a
-- pending order from the browser: doing so desynchronises the total from the
-- items and strands the payment.
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
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'order items are written by the server only' USING ERRCODE = '42501';
  END IF;
  SELECT o.payment_status INTO v_payment_status
    FROM public.orders o
   WHERE o.id = NEW.order_id;
  IF v_payment_status IS NULL OR lower(v_payment_status) <> 'pending' THEN
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
ALTER TABLE public.store_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;

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

-- Orders: READ-ONLY for the browser. Every write (create, status, settlement,
-- refund) goes through the API server with the service_role key, so there is
-- deliberately no INSERT/UPDATE/DELETE policy here and the matching table
-- grants are revoked. Keeping the owner/admin SELECT policy is what lets a
-- customer see their own orders and an admin see all of them.
DROP POLICY IF EXISTS "Orders insert" ON public.orders;
DROP POLICY IF EXISTS "Orders admin update" ON public.orders;
DROP POLICY IF EXISTS "Orders admin delete" ON public.orders;
DROP POLICY IF EXISTS "Orders owner or admin read" ON public.orders;
CREATE POLICY "Orders owner or admin read" ON public.orders FOR SELECT TO authenticated USING (customer_id = auth.uid() OR (SELECT public.is_admin()));

-- Order items: owner+admin read; writes are service_role only.
DROP POLICY IF EXISTS "Store ratings public read" ON public.store_ratings;
CREATE POLICY "Store ratings public read" ON public.store_ratings FOR SELECT USING (true);
DROP POLICY IF EXISTS "Store ratings own write" ON public.store_ratings;
CREATE POLICY "Store ratings own write" ON public.store_ratings FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Order items insert" ON public.order_items;
-- Server/service-role only: no policy grants INSERT to anon or authenticated.
-- (The role-level GRANT was revoked above; this removes the old permissive
-- policy so a future re-grant cannot resurrect it.)
DROP POLICY IF EXISTS "Order items owner insert" ON public.order_items;
DROP POLICY IF EXISTS "Order items owner read" ON public.order_items;
CREATE POLICY "Order items owner read" ON public.order_items FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND (o.customer_id = auth.uid() OR public.is_admin()))
);

-- Payments: no policies for anon/authenticated (service role only).

-- Contact messages: submitted through the rate-limited API (service_role), read
-- by admins. No anonymous INSERT: a public grant here would let anyone POST
-- junk straight to PostgREST and skip the spam checks entirely.
DROP POLICY IF EXISTS "Contact submit" ON public.contact_messages;
DROP POLICY IF EXISTS "Contact admin manage" ON public.contact_messages;
CREATE POLICY "Contact admin read" ON public.contact_messages FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

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
