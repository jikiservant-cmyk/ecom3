-- ============================================================================
--  Drum Palace — enum labels (run this FIRST, on its own)
--
--  `orders.status` is a Postgres ENUM (`order_status`), not text. The app writes
--  `pending`, `processing`, `shipped`, `delivered`, `cancelled`. If `delivered`
--  is not a label of the type, every "mark as delivered" fails with
--
--      invalid input value for enum order_status: "delivered"
--
--  WHY THIS IS A SEPARATE FILE: in PostgreSQL a label added by ALTER TYPE ...
--  ADD VALUE cannot be USED in the same transaction that added it. Supabase's
--  SQL editor runs a pasted script as one batch, so adding the label and then
--  writing orders in the same paste would fail with
--
--      unsafe use of new value "delivered" of enum type order_status
--
--  Running this file as its own query adds the label; the main migration then
--  runs in a later batch and can use it.
--
--  You have already added `delivered` by hand — this file is therefore a no-op
--  for you, and it is here so the step is recorded and repeatable on a rebuild.
--  ADD VALUE IF NOT EXISTS is supported from PostgreSQL 12.
-- ============================================================================

-- 1. orders.status
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'pending';
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'processing';
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'shipped';
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'delivered';
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'cancelled';

-- 2. payments.status — the ledger label for a settled payment is `paid`.
--    `success` is deliberately NOT added: it is not part of this vocabulary, and
--    the application now writes `paid`.
DO $payments_enum$
DECLARE
  v_type TEXT;
BEGIN
  SELECT c.udt_name INTO v_type
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'payments' AND c.column_name = 'status';

  IF v_type IS NULL THEN
    RAISE NOTICE 'public.payments.status not found - skipping';
  ELSIF v_type IN ('text', 'varchar') THEN
    RAISE NOTICE 'payments.status is %, not an enum - nothing to add', v_type;
  ELSE
    EXECUTE format('ALTER TYPE public.%I ADD VALUE IF NOT EXISTS %L', v_type, 'pending');
    EXECUTE format('ALTER TYPE public.%I ADD VALUE IF NOT EXISTS %L', v_type, 'paid');
    EXECUTE format('ALTER TYPE public.%I ADD VALUE IF NOT EXISTS %L', v_type, 'failed');
    EXECUTE format('ALTER TYPE public.%I ADD VALUE IF NOT EXISTS %L', v_type, 'refunded');
  END IF;
END
$payments_enum$;

-- 3. Show the result. Every label the app writes must appear below.
SELECT t.typname AS enum_type, e.enumlabel AS label, e.enumsortorder AS sort_order
  FROM pg_enum e
  JOIN pg_type t ON t.oid = e.enumtypid
  JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE n.nspname = 'public'
   AND t.typname IN ('order_status')
 ORDER BY t.typname, e.enumsortorder;

SELECT c.udt_name AS payments_status_type
  FROM information_schema.columns c
 WHERE c.table_schema = 'public' AND c.table_name = 'payments' AND c.column_name = 'status';
