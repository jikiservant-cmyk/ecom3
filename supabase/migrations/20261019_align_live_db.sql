-- ============================================================================
--  Align an EXISTING Drum Palace database with the application.
--
--  Your live `public` schema was created from an earlier, normalized design:
--  13 tables, `orders.status` carrying BOTH fulfilment and payment state,
--  `payments.status` using ('pending','processing','paid','failed',
--  'cancelled','refunded'), and no `refunds` table.
--
--  The application needs: a separate `payment_status`, the money ledger tables,
--  an idempotency key, a pricing snapshot, and the atomic RPCs.
--
--  RUN ORDER — both steps are required and idempotent:
--
--    1. lib/schemaSql.ts      (Admin Portal → Cloud Sync → “Copy Complete SQL
--                              Schema”) — adds the missing tables/columns,
--                              RPCs, triggers, RLS and grants.
--    2. THIS FILE             — converts the legacy data and REPLACES the old
--                              CHECK constraints that step 1 cannot alter.
--
--  Running this file alone is safe: every statement is guarded, and it exits
--  quietly if the new columns are not there yet (i.e. step 1 was skipped).
--
--  BEFORE YOU RUN: take a Supabase backup / snapshot. Step 2 rewrites status
--  values on existing rows.
-- ============================================================================

DO $align$
DECLARE
  v_missing TEXT;
BEGIN
  -- ---------------------------------------------------------------- guards --
  SELECT string_agg(c, ', ')
    INTO v_missing
  FROM unnest(ARRAY['payment_status', 'payment_method', 'client_request_id', 'pricing_snapshot']) AS c
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = c
  );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'Run lib/schemaSql.ts first: public.orders is missing [%]. Nothing was changed.',
      v_missing;
  END IF;

  ---------------------------------------------------------------------------
  -- 1. Backfill payment state from the legacy combined `status`.
  --
  --    Legacy meaning: status='paid' meant the money arrived, 'refunded' meant
  --    it went back, 'completed' meant delivered. The new model keeps those
  --    in `payment_status` and uses `status` for fulfilment only.
  ---------------------------------------------------------------------------

  -- The protection triggers would reject a service-role write from the SQL
  -- editor (auth.role() is NULL here), so they are parked for the backfill.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'orders_protect_payment_status') THEN
    ALTER TABLE public.orders DISABLE TRIGGER orders_protect_payment_status;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'orders_protect_amounts') THEN
    ALTER TABLE public.orders DISABLE TRIGGER orders_protect_amounts;
  END IF;

  -- 1a. Money that arrived but was never recorded as paid.
  UPDATE public.orders
     SET payment_status = 'Paid'
   WHERE lower(COALESCE(payment_status, 'pending')) = 'pending'
     AND lower(COALESCE(status, '')) IN ('paid', 'completed');

  -- 1b. Money that was returned.
  UPDATE public.orders
     SET payment_status = 'Refunded'
   WHERE lower(COALESCE(payment_status, 'pending')) <> 'refunded'
     AND lower(COALESCE(status, '')) = 'refunded';

  -- 1c. Orders that were abandoned at the gateway (nothing to do for the
  --     legacy vocabulary, which had no 'failed'; kept for future re-runs).
  UPDATE public.orders
     SET payment_status = 'Failed'
   WHERE lower(COALESCE(payment_status, 'pending')) = 'pending'
     AND lower(COALESCE(status, '')) = 'failed';

  -- 1d. Fulfilment status → the app's vocabulary (capitalised, with
  --     'Delivered' replacing the old 'completed').
  UPDATE public.orders
     SET status = CASE lower(COALESCE(status, ''))
                    WHEN 'pending'    THEN 'Pending'
                    WHEN 'processing' THEN 'Processing'
                    WHEN 'paid'       THEN 'Processing'
                    WHEN 'shipped'    THEN 'Shipped'
                    WHEN 'completed'  THEN 'Delivered'
                    WHEN 'delivered'  THEN 'Delivered'
                    WHEN 'cancelled'  THEN 'Cancelled'
                    WHEN 'canceled'   THEN 'Cancelled'
                    WHEN 'refunded'   THEN 'Cancelled'
                    ELSE 'Pending'
                  END
   WHERE status IS DISTINCT FROM CASE lower(COALESCE(status, ''))
                    WHEN 'pending'    THEN 'Pending'
                    WHEN 'processing' THEN 'Processing'
                    WHEN 'paid'       THEN 'Processing'
                    WHEN 'shipped'    THEN 'Shipped'
                    WHEN 'completed'  THEN 'Delivered'
                    WHEN 'delivered'  THEN 'Delivered'
                    WHEN 'cancelled'  THEN 'Cancelled'
                    WHEN 'canceled'   THEN 'Cancelled'
                    WHEN 'refunded'   THEN 'Cancelled'
                    ELSE 'Pending'
                  END;

  -- 1e. Same normalisation for payment_status casing.
  UPDATE public.orders
     SET payment_status = initcap(lower(payment_status))
   WHERE payment_status IS NOT NULL
     AND payment_status <> initcap(lower(payment_status));

  -- 1f. Defaults for future rows.
  ALTER TABLE public.orders ALTER COLUMN status SET DEFAULT 'Pending';
  ALTER TABLE public.orders ALTER COLUMN payment_status SET DEFAULT 'Pending';

  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'orders_protect_payment_status') THEN
    ALTER TABLE public.orders ENABLE TRIGGER orders_protect_payment_status;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'orders_protect_amounts') THEN
    ALTER TABLE public.orders ENABLE TRIGGER orders_protect_amounts;
  END IF;

  ---------------------------------------------------------------------------
  -- 2. Replace the legacy CHECK constraints.
  --
  --    The old constraints were created inline by `CREATE TABLE`, so their
  --    names are whatever Postgres generated. Find them by definition rather
  --    than by name.
  ---------------------------------------------------------------------------
  DECLARE
    r RECORD;
  BEGIN
    FOR r IN
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       WHERE ns.nspname = 'public'
         AND rel.relname = 'orders'
         AND con.contype = 'c'
         AND (
              pg_get_constraintdef(con.oid) ILIKE '%payment_status%'
           OR (pg_get_constraintdef(con.oid) ILIKE '%status%'
               AND pg_get_constraintdef(con.oid) NOT ILIKE '%payment_status%')
         )
    LOOP
      EXECUTE format('ALTER TABLE public.orders DROP CONSTRAINT %I', r.conname);
    END LOOP;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'orders_status_valid' AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_status_valid
      CHECK (status IN ('Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled',
                        'pending', 'processing', 'shipped', 'delivered', 'cancelled'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'orders_payment_status_valid' AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_payment_status_valid
      CHECK (payment_status IN ('Pending', 'Paid', 'Failed', 'Refunded',
                                'pending', 'paid', 'failed', 'refunded'))
      NOT VALID;
  END IF;

  ---------------------------------------------------------------------------
  -- 3. payments.status: the ledger now records a SETTLEMENT ('success'), not
  --    the provider's own wording ('paid'). Old rows are converted first.
  ---------------------------------------------------------------------------
  UPDATE public.payments
     SET status = CASE lower(COALESCE(status, 'pending'))
                    WHEN 'paid'       THEN 'success'
                    WHEN 'succeeded'  THEN 'success'
                    WHEN 'completed'  THEN 'success'
                    WHEN 'processing' THEN 'pending'
                    WHEN 'cancelled'  THEN 'failed'
                    WHEN 'canceled'   THEN 'failed'
                    ELSE lower(COALESCE(status, 'pending'))
                  END
   WHERE lower(COALESCE(status, 'pending')) IN
         ('paid', 'succeeded', 'completed', 'processing', 'cancelled', 'canceled');

  DECLARE
    r RECORD;
  BEGIN
    FOR r IN
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       WHERE ns.nspname = 'public' AND rel.relname = 'payments' AND con.contype = 'c'
         AND pg_get_constraintdef(con.oid) ILIKE '%status%'
    LOOP
      EXECUTE format('ALTER TABLE public.payments DROP CONSTRAINT %I', r.conname);
    END LOOP;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'payments_status_valid' AND conrelid = 'public.payments'::regclass
  ) THEN
    ALTER TABLE public.payments ADD CONSTRAINT payments_status_valid
      CHECK (status IN ('pending', 'success', 'failed', 'refunded')) NOT VALID;
  END IF;

  ---------------------------------------------------------------------------
  -- 4. Webhook idempotency. The live table had no unique key, so a redelivered
  --    event could be processed twice. De-duplicate, then enforce it.
  ---------------------------------------------------------------------------
  DELETE FROM public.payment_webhook_events a
   USING public.payment_webhook_events b
   WHERE a.provider = b.provider
     AND a.event_id = b.event_id
     AND a.ctid > b.ctid;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'payment_webhook_events_event_id_key'
       AND conrelid = 'public.payment_webhook_events'::regclass
  ) THEN
    ALTER TABLE public.payment_webhook_events
      ADD CONSTRAINT payment_webhook_events_event_id_key UNIQUE (provider, event_id);
  END IF;

  ---------------------------------------------------------------------------
  -- 5. Old RPC overloads. A stale signature makes PostgREST answer PGRST203
  --    ("could not choose the best candidate function") and the app silently
  --    falls back to its non-atomic path.
  ---------------------------------------------------------------------------
  BEGIN
    DROP FUNCTION IF EXISTS public.create_order_v2(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BIGINT, BIGINT, BIGINT, BIGINT, JSONB, TEXT, TEXT, TIMESTAMPTZ);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    DROP FUNCTION IF EXISTS public.record_refund(TEXT, BIGINT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RAISE NOTICE 'Drum Palace schema aligned. Run tools/verify-db.sql to confirm.';
END
$align$;

-- ---------------------------------------------------------------------------
-- Verification: every row should be 'OK'. Anything MISSING means step 1 was
-- skipped or only partly applied.
-- ---------------------------------------------------------------------------
SELECT 'orders.payment_status is never NULL' AS check,
       COUNT(*) FILTER (WHERE payment_status IS NULL) AS bad_rows
  FROM public.orders
UNION ALL
SELECT 'orders.status uses the app vocabulary',
       COUNT(*)
  FROM public.orders
 WHERE status NOT IN ('Pending','Processing','Shipped','Delivered','Cancelled',
                      'pending','processing','shipped','delivered','cancelled')
UNION ALL
SELECT 'payments.status uses the ledger vocabulary',
       COUNT(*)
  FROM public.payments
 WHERE status NOT IN ('pending','success','failed','refunded')
UNION ALL
SELECT 'orders marked Paid have a payment row',
       COUNT(*)
  FROM public.orders o
 WHERE lower(o.payment_status) = 'paid'
   AND NOT EXISTS (SELECT 1 FROM public.payments p WHERE p.order_id = o.id);
