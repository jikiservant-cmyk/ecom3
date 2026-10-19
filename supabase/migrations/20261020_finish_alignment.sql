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
--   1. `orders.status` is an ENUM (order_status) — there is deliberately NO
--      CHECK constraint here. A CHECK cannot add a label, duplicates the type,
--      and would reject labels the type legitimately holds (`paid`, `completed`,
--      `refunded`). You already added `delivered`. See 20261020a_enum_labels.sql.
--      Your live table was created with status IN ('pending','paid',
--      'processing','shipped','completed','cancelled','refunded').
--
--      RESOLVED DIFFERENTLY AFTER YOUR REVIEW: instead of widening the CHECK to
--      accept Title Case, the APPLICATION now writes lowercase only
--      (lib/status.ts). The vocabulary is therefore the DB's own, unchanged in
--      spirit: 'pending','processing','shipped','delivered','cancelled'.
--      'paid' and 'refunded' move out of `status` and into `payment_status`,
--      where they belong. If that old CHECK is still present, every INSERT into
--      orders is rejected.
--      Verify:  SELECT pg_get_constraintdef(oid), conname FROM pg_constraint
--                WHERE conrelid = 'public.orders'::regclass AND contype = 'c';
--
--   2. `payments.status` is an ENUM whose settled label is `paid`. The app used
--      to write 'success', which the type does not contain — that would have
--      rejected every settlement. lib/status.ts now writes `paid`.
--
--   3. create_order_v2 → checkout silently uses the non-atomic fallback:
--      oversell is possible, and guest idempotency is not enforced.
--
--   4. record_refund → refunds take the optimistic fallback path (safe against
--      races, but not a single transaction).
--
--   5. payment_webhook_events unique key → ALREADY APPLIED. Section 2 only
--      verifies it and never deletes audit rows.
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
  -- The app writes `delivered`. If the enum does not have that label yet, this
  -- migration would half-apply before failing on the first shipped order, so it
  -- stops here instead. Fix: run 20261020a_enum_labels.sql on its own first.
  DECLARE
    v_udt TEXT;
    v_has_delivered BOOLEAN;
  BEGIN
    SELECT c.udt_name INTO v_udt
      FROM information_schema.columns c
     WHERE c.table_schema='public' AND c.table_name='orders' AND c.column_name='status';

    IF v_udt IS NOT NULL AND v_udt <> 'text' THEN
      SELECT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = v_udt AND e.enumlabel = 'delivered') INTO v_has_delivered;
      IF NOT v_has_delivered THEN
        RAISE EXCEPTION 'enum % has no label ''delivered''. Run supabase/migrations/20261020a_enum_labels.sql on its own first, then re-run this file. Nothing was changed.', v_udt;
      END IF;
    END IF;
  END;

  RAISE NOTICE 'preflight ok';
END
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. Status constraints — ENUM AWARE.
--
--    `orders.status` is a POSTGRES ENUM (`order_status`), and `payments.status`
--    is an enum too. You already added `delivered` to the first one.
--
--    So this section does NOT create CHECK constraints on those columns. A
--    CHECK cannot add a label that the type does not have, it duplicates what
--    the enum already enforces, and a CHECK that lists only the labels we use
--    would REJECT the labels that are legitimately in the type (`paid`,
--    `completed`, `refunded`) — turning a working column into a failing one.
--
--    What is enforced instead:
--      * the enum is the validator for `orders.status` and `payments.status`;
--      * `orders.payment_status` is a TEXT column this project added, so it
--        gets a real CHECK — but only if it really is text (see the guard).
--
--    If `delivered` is missing from the enum, run
--    `20261020a_enum_labels.sql` FIRST (it must be its own batch: a label added
--    in a transaction cannot be used in that same transaction).
DO $status_constraints$
DECLARE
  v_udt    TEXT;
BEGIN
  -- 1a. Only add the payment_status CHECK if the column is genuinely text.
  SELECT c.udt_name INTO v_udt
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'orders'
     AND c.column_name = 'payment_status';

  IF v_udt = 'text' AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'orders_payment_status_valid'
          AND conrelid = 'public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_payment_status_valid
      CHECK (payment_status IN ('pending','paid','failed','refunded')) NOT VALID;
  ELSIF v_udt IS NOT NULL AND v_udt <> 'text' THEN
    RAISE NOTICE 'orders.payment_status is %, not text - leaving validation to the type', v_udt;
  END IF;

  -- 1b. Drop a redundant/contradictory status CHECK if a previous run added one.
  --     (This is the constraint that would reject `paid`/`completed`/`refunded`.)
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'orders_status_valid'
                AND conrelid = 'public.orders'::regclass) THEN
    ALTER TABLE public.orders DROP CONSTRAINT orders_status_valid;
    RAISE NOTICE 'dropped redundant orders_status_valid (the enum already validates status)';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'payments_status_valid'
                AND conrelid = 'public.payments'::regclass) THEN
    ALTER TABLE public.payments DROP CONSTRAINT payments_status_valid;
    RAISE NOTICE 'dropped payments_status_valid (the enum already validates status)';
  END IF;

  -- 1c. payment_method and the money invariants are still worth enforcing: they
  --     are ordinary columns, and these checks are additive (NOT VALID).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname='orders_payment_method_valid'
                    AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_payment_method_valid
      CHECK (payment_method IN ('momo','cod','card')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname='orders_amounts_whole_shillings'
                    AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_amounts_whole_shillings
      CHECK (total_minor_units % 100 = 0 AND subtotal_minor_units % 100 = 0
             AND discount_minor_units % 100 = 0 AND shipping_minor_units % 100 = 0) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname='orders_refund_within_total'
                    AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_refund_within_total
      CHECK (refunded_minor_units >= 0 AND refunded_minor_units <= total_minor_units) NOT VALID;
  END IF;
END
$status_constraints$;

-- ---------------------------------------------------------------------------
-- 1b. Normalise the rows the old client already wrote.
--
--    Case is the only thing to fix: the enum labels are lowercase, and an
--    earlier version of the app wrote 'Pending' / 'Processing' — which would not
--    even have been accepted by the enum, so any such row is from a TEXT-era
--    table. The cast to the enum type is explicit, because `CASE` yields text
--    and Postgres will not assign text to an enum column.
--
--    `paid` / `completed` / `refunded` are LEFT ALONE: they are valid labels of
--    your type, and rewriting them would destroy real order history.
--
--    Idempotent: a second run matches nothing.
-- ---------------------------------------------------------------------------
DO $normalise_rows$
DECLARE
  v_udt TEXT;
BEGIN
  SELECT c.udt_name INTO v_udt
    FROM information_schema.columns c
   WHERE c.table_schema='public' AND c.table_name='orders' AND c.column_name='status';

  IF v_udt IS NULL THEN
    RAISE NOTICE 'orders.status not found - skipping';
  ELSIF v_udt = 'text' THEN
    -- Legacy text column: fix the casing only.
    UPDATE public.orders
       SET status = lower(trim(status)),
           updated_at = NOW()
     WHERE status <> lower(trim(status));
  ELSE
    -- Enum column: only touch rows whose value differs from its lowercase form
    -- AND whose lowercase form is a label of the type.
    EXECUTE format($f$
      UPDATE public.orders o
         SET status = lower(trim(o.status::text))::public.%I,
             updated_at = NOW()
       WHERE o.status::text <> lower(trim(o.status::text))
         AND lower(trim(o.status::text)) IN (
               SELECT e.enumlabel FROM pg_enum e
                 JOIN pg_type t ON t.oid = e.enumtypid
                WHERE t.typname = %L)
    $f$, v_udt, v_udt);
  END IF;
END
$normalise_rows$;

-- `payment_status` is our own TEXT column, so it can be normalised directly.
UPDATE public.orders
   SET payment_status = CASE
         WHEN lower(trim(payment_status)) IN ('paid','success','succeeded','completed') THEN 'paid'
         WHEN lower(trim(payment_status)) = 'failed'   THEN 'failed'
         WHEN lower(trim(payment_status)) = 'refunded' THEN 'refunded'
         ELSE 'pending'
       END,
       updated_at = NOW()
 WHERE payment_status IS NULL
    OR payment_status <> lower(trim(payment_status))
    OR lower(trim(payment_status)) NOT IN ('pending','paid','failed','refunded');

-- The payments ledger is an enum whose settled value is `paid` (NOT `success`),
-- so there is nothing to map here — writing a label that is not in the type is
-- exactly the failure this avoids.
DO $payments_note$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                  WHERE t.typname = 'status' AND e.enumlabel = 'paid') THEN
    RAISE NOTICE 'payments.status has no paid label - check the enum before deploying';
  END IF;
END
$payments_note$;

-- ---------------------------------------------------------------------------
-- 2. Webhook idempotency — VERIFY ONLY, never delete.
--
--    The unique (provider, event_id) index already exists on your database, so
--    this section creates nothing and deletes nothing. An earlier version
--    DELETEd duplicate rows to make room for the constraint; deleting from an
--    audit table to satisfy a DDL statement is not acceptable, and it is not
--    needed now that the index is in place.
--
--    If the index is somehow missing, this reports how many duplicates exist
--    and tells you to inspect them instead of silently destroying evidence.
DO $webhook_key$
DECLARE
  v_dupes INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname='public' AND c.relname='payment_webhook_events_event_id_key')
     OR EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='payment_webhook_events_event_id_key'
                   AND conrelid='public.payment_webhook_events'::regclass)
     OR EXISTS (SELECT 1 FROM pg_indexes
                 WHERE schemaname='public' AND tablename='payment_webhook_events'
                   AND indexdef ILIKE '%provider%event_id%') THEN
    RAISE NOTICE 'webhook (provider, event_id) uniqueness already present - nothing to do';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_dupes FROM (
    SELECT provider, event_id FROM public.payment_webhook_events
     GROUP BY provider, event_id HAVING COUNT(*) > 1) d;

  IF v_dupes = 0 THEN
    ALTER TABLE public.payment_webhook_events
      ADD CONSTRAINT payment_webhook_events_event_id_key UNIQUE (provider, event_id);
    RAISE NOTICE 'created payment_webhook_events_event_id_key';
  ELSE
    RAISE WARNING '% duplicate (provider, event_id) group(s) exist. Nothing was deleted. Inspect with: SELECT provider, event_id, COUNT(*) FROM public.payment_webhook_events GROUP BY 1,2 HAVING COUNT(*) > 1;', v_dupes;
  END IF;
END
$webhook_key$;

-- ---------------------------------------------------------------------------
-- 3. Guest idempotency — scoped to a GUEST SESSION, and the customer-scoped
--    index is KEPT.
--
--    Keying every guest to the literal 'guest' gave all guests one shared
--    namespace, and an earlier draft dropped the customer index to do it. Wrong
--    on both counts. A guest retry is only a duplicate if it comes from the SAME
--    browser session, so the session id (generated once per browser, sent as
--    X-Guest-Session-Id) is part of the key.
--
--    Two indexes now exist, each with a single job:
--      * idx_orders_client_request_id        -- guests, scoped by session
--      * idx_orders_customer_request_id      -- signed-in customers (unchanged)
-- ---------------------------------------------------------------------------
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS guest_session_id TEXT;

DROP INDEX IF EXISTS public.idx_orders_guest_session_request_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_guest_session_request_id
  ON public.orders (guest_session_id, client_request_id)
  WHERE customer_id IS NULL
    AND guest_session_id IS NOT NULL
    AND client_request_id IS NOT NULL;

-- Signed-in customers: restored/kept, exactly as before.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_customer_request_id
  ON public.orders (customer_id, client_request_id)
  WHERE customer_id IS NOT NULL
    AND client_request_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. RPC: create_order_v2 — atomic order + line items + stock decrement.
--
--    PRICING: the function does NOT trust `item.price`. It resolves the product
--    and the variant from the database, takes `price_minor_units` from
--    `product_variants`, and then reconciles what it was told against that:
--      * subtotal must equal SUM(catalog price x quantity);
--      * the submitted line prices may DISCOUNT (promotions) but never exceed
--        the catalog price;
--      * SUM(line prices) must equal subtotal - discount;
--      * total must equal subtotal - discount + shipping.
--    A line without a valid, active product and variant is refused outright.
--
--    SECURITY: SECURITY DEFINER, so EXECUTE is granted to service_role ONLY.
--    The auth.role() guard inside the body means even a future mis-grant cannot
--    open it. Without this function checkout falls back to a non-atomic path
--    where two concurrent buyers can take the same last unit.
-- ---------------------------------------------------------------------------
-- Older signatures (no guest session, TEXT ids) are removed so a stale caller
-- cannot reach a version that trusts the submitted price.
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

REVOKE ALL ON FUNCTION public.create_order_v2(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BIGINT, BIGINT, BIGINT, BIGINT, JSONB, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order_v2(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BIGINT, BIGINT, BIGINT, BIGINT, JSONB, TEXT, TEXT, TIMESTAMPTZ, TEXT) TO service_role;

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
         payment_status = CASE WHEN v_full THEN 'refunded' ELSE payment_status END,
         status = CASE WHEN v_full THEN 'cancelled' ELSE status END,
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
  NEW.status := 'pending';
  NEW.payment_status := 'pending';
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
-- 7e. New sign-ups get a profile row — and it is ALWAYS 'customer'.
--
--    The application deliberately does not create this row itself: registration
--    posts to Supabase Auth and the trigger does the rest. Without the trigger,
--    a new user has NO row in public.profiles. That is not cosmetic:
--      * orders.customer_id REFERENCES profiles(id), so a signed-in customer
--        with no profile row cannot complete checkout (23503);
--      * the login route reads the role from profiles, so the admin portal can
--        never recognise anyone;
--      * a NULL profile means "customer" by luck, not by design.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    new.id,
    new.email,
    COALESCE(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      split_part(new.email, '@', 1)
    ),
    'customer'   -- hard-coded: a sign-up can never choose its own role
  )
  ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name);
  RETURN new;
END;
$fn$;

-- Installing the trigger is deliberately conservative: an existing
-- AFTER INSERT trigger on auth.users may do more than create a profile (audit
-- rows, tenant setup, welcome mail). Dropping it would silently delete that
-- behaviour, so it is never dropped here. If one exists, this reports it and
-- leaves you to decide.
DO $auth_trigger$
DECLARE
  v_existing TEXT;
BEGIN
  SELECT t.tgname INTO v_existing
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'auth' AND c.relname = 'users'
     AND NOT t.tgisinternal
     AND (t.tgtype & 4) = 4          -- AFTER
     AND (t.tgtype & 16) = 16        -- INSERT
   LIMIT 1;

  IF v_existing IS NULL THEN
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
    RAISE NOTICE 'created on_auth_user_created';
  ELSE
    RAISE NOTICE 'auth.users already has an AFTER INSERT trigger named %. Nothing was dropped or replaced - confirm it creates the profile row, or call public.handle_new_user() from it.', v_existing;
  END IF;
END
$auth_trigger$;

-- Backfill: every existing auth user must have a profile, or that customer
-- cannot check out and cannot be recognised as an admin.
INSERT INTO public.profiles (id, email, full_name, role)
SELECT u.id,
       u.email,
       COALESCE(u.raw_user_meta_data->>'full_name',
                u.raw_user_meta_data->>'name',
                split_part(COALESCE(u.email, ''), '@', 1)),
       'customer'
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
 WHERE p.id IS NULL
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 7f. A customer can never promote themselves.
--
--    public.profiles has a self-update policy (you may edit your own name and
--    phone). Without this trigger, "your own row" also includes the `role`
--    column — one PostgREST PATCH and a customer is an admin. The function is
--    SECURITY DEFINER and calls is_admin(), which reads the CALLER's JWT, so an
--    admin can still promote staff and a customer cannot promote themselves.
--
--    NOTE: this is the single most important trigger in this file. It is the
--    one that protects the admin portal from being entered by anyone who can
--    sign up.
--
--    Bootstrap, in the SQL editor (no JWT => allowed by the guard below):
--      UPDATE public.profiles SET role = 'admin' WHERE email = 'you@example.com';
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_profile_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  -- A request that carries no user JWT is the SQL editor, a migration or the
  -- service role: that is how the FIRST admin is provisioned, so it is allowed.
  -- Every request from a browser carries auth.uid(); those are the ones that
  -- must be admins already.
  IF NEW.role IS DISTINCT FROM OLD.role
     AND auth.uid() IS NOT NULL
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'role changes require administrator privileges' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS profiles_protect_role ON public.profiles;
CREATE TRIGGER profiles_protect_role
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE PROCEDURE public.protect_profile_role();

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
-- 9. TIGHTEN the money tables (orders, order_items, payments, refunds).
--
--    Your live database currently lets the browser INSERT, UPDATE and DELETE
--    orders — a public anon key can mark an order Paid, edit a total, or erase
--    a row. Closing that is the single highest-value change in this file.
--
--    AFTER THIS SECTION, THE BROWSER CAN NO LONGER WRITE ANY OF THESE TABLES.
--    Every write must go through the server (service_role):
--      create order      → POST  /api/orders        → create_order_v2
--      admin status      → PATCH /api/orders        (audit-logged)
--      settlement        → POST  /api/payments/livepay/webhook
--      refund            → POST  /api/orders/refund → record_refund
--    Browser code has been updated to match: AdminPortal no longer writes
--    orders.status directly.
--
--    Reads are kept for exactly the two legitimate cases: a signed-in customer
--    reading their OWN orders, and an admin reading any order.
-- ---------------------------------------------------------------------------

DO $tighten$
DECLARE
  t   TEXT;
  pol RECORD;
BEGIN
  FOREACH t IN ARRAY ARRAY['orders','order_items','payments','refunds'] LOOP
    CONTINUE WHEN to_regclass('public.' || t) IS NULL;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- Drop every existing WRITE policy, whatever its name. A permissive policy
    -- left behind would silently defeat everything below.
    FOR pol IN
      SELECT policyname FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
         AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
      RAISE NOTICE 'dropped write policy %.% ', t, pol.policyname;
    END LOOP;

    -- Drop permissive read policies too; the owner/admin policies below replace
    -- them. Names are predictable so this is safe to re-run.
    FOR pol IN
      SELECT policyname FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t AND cmd = 'SELECT'
         AND policyname IN (
           'Enable read access for all users',
           'Public read access',
           'Allow public read',
           'Orders are viewable by everyone',
           'Order items are viewable by everyone',
           'Payments are viewable by everyone'
         )
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
    END LOOP;
  END LOOP;
END
$tighten$;

-- ---- orders: read your own, or read all as an admin. Nothing else. ----------
DROP POLICY IF EXISTS "Orders: owner or admin read" ON public.orders;
CREATE POLICY "Orders: owner or admin read" ON public.orders
  FOR SELECT TO authenticated
  USING (customer_id = auth.uid() OR (SELECT public.is_admin()));

-- ---- order_items: readable only through an order you can read. --------------
DROP POLICY IF EXISTS "Order items: via visible order" ON public.order_items;
CREATE POLICY "Order items: via visible order" ON public.order_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
       WHERE o.id = order_items.order_id
         AND (o.customer_id = auth.uid() OR (SELECT public.is_admin()))
    )
  );

-- ---- payments / refunds: no browser policies at all. ------------------------
-- Deliberately empty: with RLS on and no policy, anon and authenticated see
-- nothing. The server's service_role key bypasses RLS.
DROP POLICY IF EXISTS "Payments: owner read" ON public.payments;
DROP POLICY IF EXISTS "Refunds: owner read" ON public.refunds;

-- ---- Belt and braces: privilege-level revocation. ---------------------------
-- Even if a policy were added later by mistake, these grants are gone.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.orders, public.order_items FROM anon, authenticated;
REVOKE ALL ON public.payments FROM anon, authenticated;
REVOKE ALL ON public.refunds  FROM anon, authenticated;

-- Reads must still be granted (RLS decides which rows).
GRANT SELECT ON public.orders, public.order_items TO authenticated;
GRANT ALL ON public.orders, public.order_items, public.payments, public.refunds TO service_role;

-- ---------------------------------------------------------------------------
-- 9a. Catalog writes, webhook events, and review PII.
--
--    Catalog: the storefront reads products/variants/images/categories with the
--    anon key (fine, they are public data), but WRITES must be admin-only. Any
--    policy that lets anon/authenticated write these tables is dropped here and
--    replaced by an admin-gated one, whatever it was called.
--
--    Webhook events: nothing in the browser has any business reading or writing
--    the dedupe ledger. No policies at all for anon/authenticated.
--
--    Reviews: the row-level policy is public read, which would also publish
--    `user_email`. Column privileges fix that without breaking the public feed.
-- ---------------------------------------------------------------------------
DO $catalog_policies_tighten$
DECLARE
  t   TEXT;
  pol RECORD;
BEGIN
  FOREACH t IN ARRAY ARRAY['products','product_variants','product_images','categories'] LOOP
    CONTINUE WHEN to_regclass('public.' || t) IS NULL;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- every write policy, by any name
    FOR pol IN
      SELECT policyname FROM pg_policies
       WHERE schemaname='public' AND tablename=t AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
    END LOOP;

    -- permissive reads that are not ours
    FOR pol IN
      SELECT policyname FROM pg_policies
       WHERE schemaname='public' AND tablename=t AND cmd='SELECT'
         AND policyname NOT IN (
           'Products public read','Variants public read','Images public read','Catalog public read')
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
    END LOOP;

    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', t);
  END LOOP;

  -- Public read + admin-only write, created once per table.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='products' AND policyname='Products public read') THEN
    CREATE POLICY "Products public read" ON public.products FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='products' AND policyname='Products admin write') THEN
    CREATE POLICY "Products admin write" ON public.products FOR ALL TO authenticated
      USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='product_variants' AND policyname='Variants public read') THEN
    CREATE POLICY "Variants public read" ON public.product_variants FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='product_variants' AND policyname='Variants admin write') THEN
    CREATE POLICY "Variants admin write" ON public.product_variants FOR ALL TO authenticated
      USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='product_images' AND policyname='Images public read') THEN
    CREATE POLICY "Images public read" ON public.product_images FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='product_images' AND policyname='Images admin write') THEN
    CREATE POLICY "Images admin write" ON public.product_images FOR ALL TO authenticated
      USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='categories' AND policyname='Catalog public read') THEN
    CREATE POLICY "Catalog public read" ON public.categories FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='categories' AND policyname='Catalog admin write') THEN
    CREATE POLICY "Catalog admin write" ON public.categories FOR ALL TO authenticated
      USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));
  END IF;
END
$catalog_policies_tighten$;

-- Webhook dedupe ledger: service role only. RLS on, no policies.
DO $webhook_events$
BEGIN
  IF to_regclass('public.payment_webhook_events') IS NOT NULL THEN
    ALTER TABLE public.payment_webhook_events ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.payment_webhook_events FROM anon, authenticated;
    GRANT ALL ON public.payment_webhook_events TO service_role;
  END IF;
END
$webhook_events$;

-- Reviews: publish the review, never the reviewer's email address.
DO $reviews_pii$
BEGIN
  IF to_regclass('public.reviews') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='reviews' AND column_name='user_email') THEN
    REVOKE ALL ON public.reviews FROM anon, authenticated;
    GRANT SELECT (id, product_id, user_name, rating, comment, verified_purchase, created_at)
      ON public.reviews TO anon, authenticated;
    RAISE NOTICE 'reviews: user_email is no longer selectable by anon/authenticated';
  END IF;
END
$reviews_pii$;

-- ---------------------------------------------------------------------------
-- 9b. Storage: product photos.
--
--    AdminPortal uploads product images from the browser, so the bucket needs
--    policies — and they must be admin-only. A public INSERT policy on
--    storage.objects lets ANY visitor upload arbitrary files to your bucket
--    (storage-cost abuse, and a hosting space for anything they like).
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('products', 'products', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Public read products bucket"   ON storage.objects;
DROP POLICY IF EXISTS "Public insert products bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public update products bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public delete products bucket" ON storage.objects;
DROP POLICY IF EXISTS "Admin insert products bucket"  ON storage.objects;
DROP POLICY IF EXISTS "Admin update products bucket"  ON storage.objects;
DROP POLICY IF EXISTS "Admin delete products bucket"  ON storage.objects;

CREATE POLICY "Public read products bucket" ON storage.objects
  FOR SELECT USING (bucket_id = 'products');
CREATE POLICY "Admin insert products bucket" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'products' AND (SELECT public.is_admin()));
CREATE POLICY "Admin update products bucket" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'products' AND (SELECT public.is_admin()));
CREATE POLICY "Admin delete products bucket" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'products' AND (SELECT public.is_admin()));

-- ---------------------------------------------------------------------------
-- 10. Storefront read access. The browser reads the catalog with the public
--    anon key, so those four tables need SELECT for anon. They are already
--    RLS-enabled on your database; these policies are ADDITIVE (permissive
--    SELECT policies OR together), so if you already have them this is a no-op.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.products, public.categories, public.product_variants, public.product_images TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 11. VERIFY. Every row must be 'OK'.
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
  SELECT 'trigger', 'profiles_protect_role',
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='profiles_protect_role')
  UNION ALL
  SELECT 'trigger', 'on_auth_user_created',
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='on_auth_user_created')
  UNION ALL
  SELECT 'policy', 'storage admin insert (products)',
         EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='storage' AND tablename='objects'
                    AND policyname='Admin insert products bucket')
  UNION ALL
  SELECT 'data', 'at least one admin exists',
         EXISTS (SELECT 1 FROM public.profiles WHERE role = 'admin')
  UNION ALL
  SELECT 'data', 'auth users without a profile row',
         NOT EXISTS (
           SELECT 1 FROM auth.users u
             LEFT JOIN public.profiles p ON p.id = u.id
            WHERE p.id IS NULL
         )
  UNION ALL
  SELECT 'index', 'idx_orders_customer_request_id',
         EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_orders_customer_request_id')
  UNION ALL
  SELECT 'constraint', 'payment_webhook_events_event_id_key',
         EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payment_webhook_events_event_id_key')
  UNION ALL
  SELECT 'column', 'order_items.variant_id',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='order_items' AND column_name='variant_id')
  UNION ALL
  SELECT 'enum', 'order_status has delivered',
         EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
                  WHERE t.typname='order_status' AND e.enumlabel='delivered')
  UNION ALL
  SELECT 'index', 'idx_orders_guest_session_request_id',
         EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_orders_guest_session_request_id')
  UNION ALL
  SELECT 'column', 'orders.guest_session_id',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='orders' AND column_name='guest_session_id')
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
