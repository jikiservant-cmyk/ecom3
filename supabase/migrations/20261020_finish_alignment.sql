-- ============================================================================
--  Drum Palace — finish the alignment (complete definitions, reviewed)
--
--  You ran the additive part of lib/schemaSql.ts and deliberately stopped
--  before the functions, triggers, policies and the tables whose definitions
--  looked incomplete. That was the right call. This file is the complete,
--  reviewed version of the remainder, in the order it must be applied.
--
--  WHAT IS STILL MISSING AFTER YOUR PARTIAL RUN, AND WHAT BREAKS
--
--   1. CHECK constraint on orders.status  → checkout may already be failing.
--      Your live table was created with status IN ('pending','paid',
--      'processing','shipped','completed','cancelled','refunded'). The app
--      writes 'Pending' / 'Processing' / 'Delivered'. If that old CHECK is still
--      present, every INSERT into orders is rejected.
--      Verify:  SELECT pg_get_constraintdef(oid), conname FROM pg_constraint
--                WHERE conrelid = 'public.orders'::regclass AND contype = 'c';
--
--   2. CHECK on payments.status → the webhook writes 'success'; the legacy
--      check allows 'paid' but not 'success'. Settlements would be rejected.
--
--   3. create_order_v2 → checkout silently uses the non-atomic fallback:
--      oversell is possible, and guest idempotency is not enforced.
--
--   4. record_refund → refunds take the optimistic fallback path (safe against
--      races, but not a single transaction).
--
--   5. payment_webhook_events unique key → a redelivered webhook is processed
--      twice; the "duplicate" branch in the handler never fires.
--
--   6. Triggers + is_admin() → a direct PostgREST write can still flip payment_status.
--
--   7. reviews / store_ratings / contact_messages → those three features 500.
--      (wishlists is NOT created: no application code uses it.)
--
--  EVERYTHING HERE IS IDEMPOTENT. Take a backup first; step 1 rewrites nothing
--  but does replace constraints.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. PREFLIGHT — refuse to continue if the additive half has not been applied.
-- ---------------------------------------------------------------------------
DO $preflight$
DECLARE
  v_missing TEXT;
  v_tables  TEXT;
BEGIN
  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(ARRAY['payment_status','payment_method','items','pricing_snapshot',
                      'client_request_id','refunded_minor_units','payment_note']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema='public' AND table_name='orders' AND column_name=c);

  SELECT string_agg(c, ', ') INTO v_tables
    FROM unnest(ARRAY['refunds','payments','order_items','product_variants']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.tables
                      WHERE table_schema='public' AND table_name=c);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'orders is missing [%]. Apply the additive part of lib/schemaSql.ts first. Nothing was changed.', v_missing;
  END IF;
  IF v_tables IS NOT NULL THEN
    RAISE EXCEPTION 'missing tables [%]. Apply the additive part of lib/schemaSql.ts first. Nothing was changed.', v_tables;
  END IF;
  RAISE NOTICE 'preflight ok';
END
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. Replace the legacy CHECK constraints.
--
--    They were created inline by CREATE TABLE, so their names vary between
--    databases. Find every status-ish CHECK by its DEFINITION and drop it, then
--    install named ones. NOT VALID = existing rows are not re-checked (a legacy
--    row with an odd value will not block the deployment), new writes are.
-- ---------------------------------------------------------------------------
DO $constraints$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname, rel.relname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public'
       AND rel.relname IN ('orders', 'payments')
       AND con.contype = 'c'
       AND (pg_get_constraintdef(con.oid) ILIKE '%payment_status%'
            OR pg_get_constraintdef(con.oid) ILIKE '%status%')
       AND con.conname NOT IN ('orders_status_valid', 'orders_payment_status_valid',
                               'payments_status_valid', 'orders_payment_method_valid',
                               'orders_amounts_whole_shillings', 'orders_totals_add_up',
                               'orders_refund_within_total')
  LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.relname, r.conname);
    RAISE NOTICE 'dropped legacy constraint %.%', r.relname, r.conname;
  END LOOP;
END
$constraints$;

DO $add_checks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_status_valid' AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_status_valid
      CHECK (status IN ('Pending','Processing','Shipped','Delivered','Cancelled',
                        'pending','processing','shipped','delivered','cancelled')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_payment_status_valid' AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_payment_status_valid
      CHECK (payment_status IN ('Pending','Paid','Failed','Refunded',
                                'pending','paid','failed','refunded')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payments_status_valid' AND conrelid='public.payments'::regclass) THEN
    ALTER TABLE public.payments ADD CONSTRAINT payments_status_valid
      CHECK (status IN ('pending','success','failed','refunded')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_payment_method_valid' AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_payment_method_valid
      CHECK (payment_method IN ('momo','cod','card')) NOT VALID;
  END IF;

  -- Money invariants (whole shillings, totals add up, refunds within the total).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_amounts_whole_shillings' AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_amounts_whole_shillings
      CHECK (total_minor_units % 100 = 0 AND subtotal_minor_units % 100 = 0
             AND discount_minor_units % 100 = 0 AND shipping_minor_units % 100 = 0) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_refund_within_total' AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_refund_within_total
      CHECK (refunded_minor_units >= 0 AND refunded_minor_units <= total_minor_units) NOT VALID;
  END IF;
END
$add_checks$;

-- ---------------------------------------------------------------------------
-- 2. Webhook idempotency.
--    De-duplicate first, otherwise the unique constraint cannot be created.
--    The handler relies on the 23505 duplicate error to short-circuit retries.
-- ---------------------------------------------------------------------------
DELETE FROM public.payment_webhook_events a
 USING public.payment_webhook_events b
 WHERE a.provider = b.provider AND a.event_id = b.event_id AND a.ctid > b.ctid;

DO $webhook_key$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname='payment_webhook_events_event_id_key'
                    AND conrelid='public.payment_webhook_events'::regclass) THEN
    ALTER TABLE public.payment_webhook_events
      ADD CONSTRAINT payment_webhook_events_event_id_key UNIQUE (provider, event_id);
  END IF;
END
$webhook_key$;

-- ---------------------------------------------------------------------------
-- 3. Idempotency index — COVERS GUESTS.
--
--    The index you added keys on customer_id only, so concurrent guest retries
--    (customer_id IS NULL) are not constrained: a retried checkout creates a
--    second order and a second Mobile Money prompt. NULLs are distinct in a
--    unique index, so guests are folded into one scope explicitly.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_orders_client_request_id;
DROP INDEX IF EXISTS public.idx_orders_customer_request_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_customer_request_id
  ON public.orders (COALESCE(customer_id::text, 'guest'), client_request_id)
  WHERE client_request_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. RPC: create_order_v2 — atomic order + line items + stock decrement.
--
--    SECURITY: SECURITY DEFINER, so EXECUTE is granted to service_role ONLY.
--    The auth.role() guard inside the body means even a future mis-grant cannot
--    open it. Without this function checkout falls back to a non-atomic path
--    where two concurrent buyers can take the same last unit.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_order_v2(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BIGINT, BIGINT, BIGINT, BIGINT, JSONB, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.create_order_v2(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BIGINT, BIGINT, BIGINT, BIGINT, JSONB, TEXT, TEXT, TIMESTAMPTZ);

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
  p_created_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  item RECORD;
  v_product_id UUID;
  v_variant_id UUID;
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

  INSERT INTO public.orders (
    id, order_number, client_request_id, customer_id, customer_name, customer_email, customer_phone,
    shipping_address, items, status, payment_status, payment_method, currency,
    subtotal_minor_units, discount_minor_units, shipping_minor_units, tax_minor_units,
    total_minor_units, total_amount, pricing_snapshot, refunded_minor_units, created_at, updated_at
  ) VALUES (
    p_order_id, p_order_number, p_client_request_id, p_customer_id, p_customer_name, p_customer_email, p_customer_phone,
    jsonb_build_object('address', COALESCE(p_shipping_address, '')), p_items, 'Pending', 'Pending',
    CASE WHEN p_payment_method IN ('cod','card') THEN p_payment_method ELSE 'momo' END, 'UGX',
    p_subtotal_minor_units, p_discount_minor_units, p_shipping_minor_units, 0,
    p_total_minor_units, p_total_minor_units / 100.0, p_pricing_snapshot, 0, p_created_at, p_created_at
  );

  FOR item IN
    SELECT * FROM jsonb_to_recordset(p_items)
      AS x("productName" TEXT, "productId" TEXT, quantity INT, price NUMERIC, variant TEXT)
  LOOP
    INSERT INTO public.order_items (
      order_id, product_id, product_name, product_slug, variant_sku, variant_attributes,
      unit_price_minor_units, quantity, line_total_minor_units, created_at
    ) VALUES (
      p_order_id,
      CASE WHEN COALESCE(item."productId", '') ~ '^[0-9a-fA-F-]{36}$' THEN item."productId"::uuid ELSE NULL END,
      item."productName",
      regexp_replace(lower(item."productName"), '[^a-z0-9]+', '-', 'g'),
      COALESCE(item.variant, 'Standard'),
      jsonb_build_object('variant', COALESCE(item.variant, 'Standard')),
      ROUND(COALESCE(item.price, 0) * 100)::BIGINT,
      item.quantity,
      ROUND(COALESCE(item.price, 0) * 100 * item.quantity)::BIGINT,
      p_created_at
    );

    -- Stock: prefer the immutable product id, fall back to name for legacy callers.
    v_product_id := CASE WHEN COALESCE(item."productId", '') ~ '^[0-9a-fA-F-]{36}$'
                         THEN item."productId"::uuid ELSE NULL END;
    IF v_product_id IS NOT NULL THEN
      SELECT p.id INTO v_product_id FROM public.products p
        WHERE p.id = v_product_id AND p.status = 'active' LIMIT 1;
    END IF;
    IF v_product_id IS NULL THEN
      SELECT p.id INTO v_product_id FROM public.products p
        WHERE p.name = item."productName" AND p.status = 'active' LIMIT 1;
    END IF;

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
$fn$;

REVOKE ALL ON FUNCTION public.create_order_v2(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BIGINT, BIGINT, BIGINT, BIGINT, JSONB, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order_v2(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BIGINT, BIGINT, BIGINT, BIGINT, JSONB, TEXT, TEXT, TIMESTAMPTZ) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. RPC: record_refund — atomic refund (row lock + balance re-check).
--
--    SECURITY: service_role only, guarded inside the body as well. The order row
--    is locked FOR UPDATE, so two concurrent refunds cannot both pass the
--    balance test. Matches your refunds table (ON DELETE RESTRICT is irrelevant
--    here: this function never deletes).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.record_refund(TEXT, BIGINT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ);

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
AS $fn$
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

  -- Negative cash-flow row: the ledger must show the money going back out.
  INSERT INTO public.payments (
    order_id, provider, provider_reference, status, amount_minor_units,
    settled_amount_minor_units, net_amount_minor_units, currency, raw_payload,
    settled_at, created_at, updated_at
  ) VALUES (
    p_order_id, 'manual',
    COALESCE(p_gateway_reference, 'REFUND-' || v_order.order_number), 'refunded',
    p_amount_minor_units, -p_amount_minor_units, -p_amount_minor_units, 'UGX',
    jsonb_build_object('kind','refund','refund_id',v_refund_id,'reason',p_reason,'refunded_by',p_actor_id),
    p_created_at, p_created_at, p_created_at
  );

  UPDATE public.orders
     SET refunded_minor_units = v_new_refunded,
         payment_note = p_reason,
         payment_status = CASE WHEN v_full THEN 'Refunded' ELSE payment_status END,
         status = CASE WHEN v_full THEN 'Cancelled' ELSE status END,
         updated_at = p_created_at
   WHERE id = p_order_id;

  RETURN QUERY SELECT v_refund_id, v_new_refunded, v_full;
END;
$fn$;

REVOKE ALL ON FUNCTION public.record_refund(UUID, BIGINT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_refund(UUID, BIGINT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. is_admin() — required by the triggers and policies below.
--
--    You skipped "functions", and this one was among them. It is needed even
--    though the API never calls it directly: the triggers and RLS policies
--    below call it, and a missing function would turn every one of those paths
--    into an error at runtime.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN FALSE;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Triggers — the database-level guarantees the app cannot provide alone.
-- ---------------------------------------------------------------------------
-- 7a. A new order is ALWAYS Pending with nothing refunded, whoever writes it.
--     Closes the hole where a browser holding the public anon key POSTgREST-
--     inserts an order already marked Paid.
CREATE OR REPLACE FUNCTION public.orders_force_pending()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  NEW.status := 'Pending';
  NEW.payment_status := 'Pending';
  NEW.refunded_minor_units := 0;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS orders_force_pending ON public.orders;
CREATE TRIGGER orders_force_pending BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE PROCEDURE public.orders_force_pending();

-- 7b. Payment state is MONOTONIC:
--       Pending → Paid | Failed      (verified webhook, or audited admin)
--       Paid    → Refunded           (refund ledger only)
--       Refunded is terminal.
--     A late/replayed FAILED notification can never cancel real revenue.
CREATE OR REPLACE FUNCTION public.orders_protect_payment_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  old_status TEXT := lower(COALESCE(OLD.payment_status, ''));
  new_status TEXT := lower(COALESCE(NEW.payment_status, ''));
BEGIN
  IF new_status IS NOT DISTINCT FROM old_status THEN
    RETURN NEW;
  END IF;
  IF old_status = 'paid' AND new_status NOT IN ('paid','refunded') THEN
    RAISE EXCEPTION 'a paid order cannot be moved back to %', NEW.payment_status USING ERRCODE = '42501';
  END IF;
  IF old_status = 'refunded' AND new_status <> 'refunded' THEN
    RAISE EXCEPTION 'a refunded order is final' USING ERRCODE = '42501';
  END IF;
  IF new_status IN ('paid','refunded')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'payment_status changes require the payment service role' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS orders_protect_payment_status ON public.orders;
CREATE TRIGGER orders_protect_payment_status BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE PROCEDURE public.orders_protect_payment_status();

-- 7c. The money on a settled order is frozen. Repricing a paid order after the
--     fact would rewrite history and break every reconciliation.
CREATE OR REPLACE FUNCTION public.orders_protect_amounts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
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
$fn$;

DROP TRIGGER IF EXISTS orders_protect_amounts ON public.orders;
CREATE TRIGGER orders_protect_amounts BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE PROCEDURE public.orders_protect_amounts();

-- 7d. Line items belong to the server, and only to a PENDING order.
CREATE OR REPLACE FUNCTION public.order_items_require_pending_order()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_payment_status TEXT;
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'order items are written by the server only' USING ERRCODE = '42501';
  END IF;
  SELECT o.payment_status INTO v_payment_status FROM public.orders o WHERE o.id = NEW.order_id;
  IF v_payment_status IS NULL OR lower(v_payment_status) <> 'pending' THEN
    RAISE EXCEPTION 'cannot modify line items on a paid or missing order' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS order_items_require_pending_order ON public.order_items;
CREATE TRIGGER order_items_require_pending_order BEFORE INSERT ON public.order_items
  FOR EACH ROW EXECUTE PROCEDURE public.order_items_require_pending_order();

-- ---------------------------------------------------------------------------
-- 8. The three missing tables (wishlists is deliberately NOT created — no app
--    code reads or writes it).
--
--    All ids UUID to match the live database. product_id references the live
--    UUID products table.
-- ---------------------------------------------------------------------------
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
CREATE INDEX IF NOT EXISTS idx_reviews_product_id ON public.reviews (product_id);

CREATE TABLE IF NOT EXISTS public.store_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT store_ratings_one_per_user UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS public.contact_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  topic TEXT,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'unread',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at ON public.contact_messages (created_at DESC);

-- RLS on, least privilege.
ALTER TABLE public.reviews          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_ratings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;

-- Reviews are public content; they are WRITTEN by the API server (service role).
DROP POLICY IF EXISTS "Reviews public read" ON public.reviews;
CREATE POLICY "Reviews public read" ON public.reviews FOR SELECT USING (true);

-- Store ratings are public content; ditto for writes.
DROP POLICY IF EXISTS "Store ratings public read" ON public.store_ratings;
CREATE POLICY "Store ratings public read" ON public.store_ratings FOR SELECT USING (true);

-- Contact messages contain PII: no anon/authenticated access at all. The API
-- server inserts with the service role, which bypasses RLS.
REVOKE ALL ON public.contact_messages FROM anon, authenticated;

REVOKE ALL ON public.reviews FROM anon, authenticated;
GRANT SELECT ON public.reviews TO anon, authenticated;

REVOKE ALL ON public.store_ratings FROM anon, authenticated;
GRANT SELECT ON public.store_ratings TO anon, authenticated;

GRANT ALL ON public.reviews, public.store_ratings, public.contact_messages TO service_role;

-- ---------------------------------------------------------------------------
-- 9. Storefront read access. The browser reads the catalog with the public anon
--    key, so those four tables need SELECT for anon. They are already
--    RLS-enabled on your database; these policies are ADDITIVE (permissive
--    SELECT policies OR together), so if you already have them this is a no-op.
-- ---------------------------------------------------------------------------
DO $catalog_policies$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='products' AND cmd='SELECT') THEN
    CREATE POLICY "Products public read" ON public.products FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='categories' AND cmd='SELECT') THEN
    CREATE POLICY "Categories public read" ON public.categories FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='product_variants' AND cmd='SELECT') THEN
    CREATE POLICY "Variants public read" ON public.product_variants FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='product_images' AND cmd='SELECT') THEN
    CREATE POLICY "Images public read" ON public.product_images FOR SELECT USING (true);
  END IF;
END
$catalog_policies$;

GRANT SELECT ON public.products, public.categories, public.product_variants, public.product_images TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10. VERIFY. Every row must be 'OK'.
-- ---------------------------------------------------------------------------
WITH checks(kind, name, ok) AS (
  SELECT 'function', 'create_order_v2',
         EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='create_order_v2')
  UNION ALL
  SELECT 'function', 'record_refund',
         EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='record_refund')
  UNION ALL
  SELECT 'trigger', 'orders_force_pending',
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='orders_force_pending')
  UNION ALL
  SELECT 'trigger', 'orders_protect_payment_status',
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='orders_protect_payment_status')
  UNION ALL
  SELECT 'trigger', 'orders_protect_amounts',
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='orders_protect_amounts')
  UNION ALL
  SELECT 'trigger', 'order_items_require_pending_order',
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='order_items_require_pending_order')
  UNION ALL
  SELECT 'index', 'idx_orders_customer_request_id',
         EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_orders_customer_request_id')
  UNION ALL
  SELECT 'constraint', 'payment_webhook_events_event_id_key',
         EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payment_webhook_events_event_id_key')
  UNION ALL
  SELECT 'constraint', 'orders_status_valid',
         EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_status_valid')
  UNION ALL
  SELECT 'constraint', 'payments_status_valid',
         EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payments_status_valid')
  UNION ALL
  SELECT 'table', 'reviews',
         EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reviews')
  UNION ALL
  SELECT 'table', 'store_ratings',
         EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='store_ratings')
  UNION ALL
  SELECT 'table', 'contact_messages',
         EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='contact_messages')
)
SELECT kind, name, CASE WHEN ok THEN 'OK' ELSE 'MISSING' END AS status
  FROM checks
 ORDER BY ok, kind, name;
