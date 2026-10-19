# Database alignment

> **Update (live inventory received):** the real database is an earlier, normalized
design — 13 `public` tables, no `refunds`/`reviews`/`store_ratings`/`wishlists`/
`contact_messages`, no `payment_status`, and `orders.status` carrying payment
state. Section 6 covers exactly what to run. `npm run schema:live` diffs the code
against the reported inventory (`tools/live-schema.json`).

**Question:** does the application perfectly align with what is in the database?

**Answer:** the code and the canonical schema (`lib/schemaSql.ts`) now match exactly — every
column, table and RPC the code touches exists in the schema, and both RPC call sites match
their function signatures argument-for-argument. Reaching that state required fixing **three
real misalignments**, two of which would have cost money or orders. It does **not** prove your
*live* Supabase project matches: that depends on having applied the schema. Section 4 gives you
a one-file SQL check to run there.

Checked with a repo tool rather than by eye:

```bash
npm run schema:check        # static: code ⇄ canonical schema (exit 1 on drift)
npm run schema:verify-sql   # regenerates tools/verify-db.sql for a live database
```

Latest run: **17 tables, 9 functions, 49 code files, 0 unknown columns, 2/2 RPCs matching.**

---

## 1. Misalignments found and fixed

### DB-01 — `store_settings` writes columns that do not exist (HIGH, silent)

The schema defines exactly:

```sql
CREATE TABLE public.store_settings (
  id          TEXT PRIMARY KEY DEFAULT 'default_settings',
  settings    JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
```

`saveStoreSettings()` inserted `key`, `value`, `settings` and `created_at`, and updated
`key`/`value`. PostgREST rejects the **entire row** when any column is unknown (PGRST204), so
every settings save failed. The admin UI only showed a generic "run the schema again" alert, so
it looked like an RLS problem.

Money impact: store settings carry the **hot-deal discounts**. A failed save means a promo the
admin created never took effect (or reverted on reload), while the UI said it was applied.

Fixed: writes now touch only `id`, `settings`, `updated_at`.

### DB-02 — idempotency key uniqueness was global, the lookup is per customer (MEDIUM)

The schema had:

```sql
CREATE UNIQUE INDEX idx_orders_client_request_id ON public.orders (client_request_id);
```

The checkout replay lookup is scoped to the caller (`customer_id = <me>`, or `IS NULL` for
guests) — that scoping was itself a security fix (guessed keys must not leak another order).
The mismatch: a global unique index means if any customer's key collides with yours, your insert
fails as a duplicate while your scoped lookup finds nothing, so checkout fails permanently for
that browser — a cheap denial-of-checkout for anyone who can guess a key.

Fixed, with `NULL`s handled (they are distinct in a unique index, so guests are folded into one
scope explicitly):

```sql
DROP INDEX IF EXISTS public.idx_orders_client_request_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_customer_request_id
  ON public.orders (COALESCE(customer_id::text, 'guest'), client_request_id)
  WHERE client_request_id IS NOT NULL;
```

### DB-03 — the card webhook could not identify its own payment (HIGH)

LivePay's card docs show the request carrying `reference: "INVOICE123456789"` but the response
echoing **`reference: "REF-MVE60LII-DVFWSB"`** — the gateway can assign its own reference. The
webhook then arrives with `customer_reference` being either value. The resolver only matched
`payments.provider_reference`, so a gateway-assigned echo would resolve nothing: the webhook
answers 200 `matched:false`, and money is collected with the order never marked Paid.

Two secondary problems in the same lookup:

- Mobile Money retries reuse one reference, so several `payments` rows can share it.
  `.maybeSingle()` **errors** on multiple rows rather than returning one.
- There was no index on `(provider, provider_reference)`.

Fixed:

- the card route stores the gateway's own reference (`raw_payload.gateway_reference`) and its
  transaction id, next to the reference we sent;
- the webhook tries, in order, `provider_reference` → `provider_transaction_id` →
  `raw_payload->>gateway_reference`, newest first with `limit(1)`;
- added `idx_payments_provider_reference`.

---

## 2. What aligns (verified, not assumed)

| Area | Code | Schema | Status |
|---|---|---|---|
| Orders | 25 columns read/written by checkout, admin, tracking, refund | `orders` (25) | ✅ |
| Order lines | `order_items` insert + nested selects | `order_items` (11) | ✅ |
| Payments ledger | 15 columns (settled/fee/net/reference/FX payload) | `payments` (15) | ✅ |
| Refunds | `refunds` insert + negative `payments` row | `refunds` (11) | ✅ |
| Webhook dedupe | `(provider, event_id)` insert | unique constraint `payment_webhook_events_event_id_key` | ✅ |
| Checkout RPC | 16 named args | `create_order_v2(...)` (16 params, `service_role` only) | ✅ |
| Refund RPC | 7 named args | `record_refund(...)` (7 params, `service_role` only) | ✅ |
| `payment_method` | `'momo' \| 'card' \| 'cod'` | `CHECK (payment_method IN (...))` + migration | ✅ |
| Money invariants | whole shillings, totals add up, refunds ≤ total | 3 named `CHECK` constraints | ✅ |
| Trigger compatibility | webhook/admin/refund write `Paid`/`Refunded` as `service_role` | `orders_protect_payment_status` allows exactly that | ✅ |

Two things worth stating explicitly because they are easy to get wrong:

- **`CREATE TABLE IF NOT EXISTS` never alters an existing table.** Every column added after the
  first install therefore has a matching `ALTER TABLE … ADD COLUMN IF NOT EXISTS`; the
  card method additionally replaces the old two-value `CHECK`.
- **`create_order_v2` legacy signatures are dropped before the new one is created.** Leaving the
  old 12-argument version in place would register an *overload*, and PostgREST would refuse the
  call as ambiguous (`PGRST203`) — the app would silently fall back to its non-atomic path.

---

## 3. Money-path column map

```
orders.id ──┬── order_items.order_id            (what was bought)
            ├── payments.order_id               (what was charged / settled)
            │     ├── provider_reference        (the reference we sent)
            │     ├── provider_transaction_id   (the gateway's id)
            │     ├── raw_payload.gateway_reference (the reference IT assigned)
            │     └── amount_minor_units        (in `currency`: UGX, or USD cents for card)
            └── refunds.order_id                (money returned, ≤ total_minor_units)
```

Ledger units:

- `orders.*_minor_units` — **always UGX minor units**, whole shillings (`% 100 = 0`).
- `payments.amount_minor_units` — in that row's `currency` (UGX for MoMo, USD cents for card).
- `payments.settled/fee/net_amount_minor_units` — **always UGX**, so revenue stays additive.
- `refunds.amount_minor_units` — UGX whole shillings (`CHECK amount > 0 AND amount % 100 = 0`).

---

## 4. Verify your live database (2 minutes)

1. Supabase → SQL Editor → paste the whole of `tools/verify-db.sql` → run.
2. Rows returning `MISSING` are drift. The list covers all 159 columns, 9 functions, the
   indexes and the named constraints.
3. If anything is missing, run the full `lib/schemaSql.ts` (Admin Portal → Cloud Sync → *Copy
   Complete SQL Schema*). It is idempotent.

Expected upgrade effects of the latest schema, if you are coming from the previous version:

| Change | Effect |
|---|---|
| `orders_payment_method_valid` replaces `orders_payment_method_check` | `'card'` becomes a legal method |
| `idx_orders_customer_request_id` replaces `idx_orders_client_request_id` | idempotency scoped per customer |
| `idx_payments_provider_reference` added | fast webhook lookup |
| `record_refund(...)` created / replaced | atomic, row-locked refunds |
| `create_order_v2(...)` replaced (same signature) | accepts `card` |

---

## 5. What this audit cannot prove

| Gap | Why | Do this |
|---|---|---|
| The **live** database's actual columns/constraints | No credentials here | Run `tools/verify-db.sql` (above) |
| RLS as a real `anon` / `authenticated` role | Needs a live project | `set role anon; select * from payments;` must return 0 rows |
| Trigger bodies executing | No Postgres in this environment | Apply the schema to staging, then attempt `update orders set payment_status='Paid'` as `anon` — it must raise |
| Backfilled historical rows | `NOT VALID` constraints skip existing rows | `select count(*) from orders where total_minor_units % 100 <> 0;` |


---

## 6. Your live database (13 public tables)

The inventory you supplied is an **earlier, normalized** design, not the schema in
`lib/schemaSql.ts`. It is a good design — prices live in `product_variants`,
images in `product_images`, ids are UUIDs — and the storefront already reads it
that way (`getProductsFromDb` queries variants, images and categories, and falls
back to individual table queries). The money path, however, assumes columns that
do not exist yet.

### 6.1 The four real conflicts

| # | Live database | What the app needs | Consequence if unchanged |
|---|---|---|---|
| L1 | `orders` has **no `payment_status`**; payment state is folded into `status` (`paid`, `refunded`, `completed`) | a separate `payment_status` (`Pending`/`Paid`/`Failed`/`Refunded`) | every checkout insert fails (unknown column), refunds and the webhook cannot mark anything Paid |
| L2 | `orders.status` CHECK allows **lowercase** `pending…refunded`, and has `paid`/`completed` but **no `Delivered`** | `Pending`/`Processing`/`Shipped`/`Delivered`/`Cancelled` | inserts rejected; admin status buttons fail |
| L3 | `payments.status` CHECK allows `pending/processing/paid/failed/cancelled/refunded` | the ledger writes **`success`** for a settled payment | the settlement update is rejected → payments stay `pending` forever |
| L4 | No `refunds` table; no `(provider, event_id)` uniqueness on `payment_webhook_events` | refund ledger + idempotent webhooks | refunds 500; a redelivered webhook can be processed twice |

Also missing and created by the schema script: `reviews`, `store_ratings`,
`wishlists`, `contact_messages`, `orders.{items,payment_method,pricing_snapshot,
client_request_id,refunded_minor_units,payment_note,tracking_number}`,
`payments.{settled_amount_minor_units,fee_minor_units,net_amount_minor_units,
provider_transaction_id,settled_at}`, and `profiles.email`.

### 6.2 Run these two files, in this order

```text
1.  lib/schemaSql.ts                          (Admin Portal → Cloud Sync → Copy Complete SQL Schema)
      ↳ creates the missing tables, adds the missing columns, installs the RPCs,
        triggers, RLS policies and grants. Idempotent.

2.  supabase/migrations/20261019_align_live_db.sql
      ↳ backfills payment_status from the legacy status, rewrites status values to
        the app's vocabulary, REPLACES the three CHECK constraints (schemaSql cannot
        alter an existing table's constraint), de-duplicates webhook events and adds
        their unique key, and drops stale RPC overloads.
```

Step 2 refuses to run (with a clear message) if step 1 has not been applied, and
every statement in it is guarded, so it is safe to re-run. **Take a backup first**
— step 2 rewrites existing `orders.status` values:

| legacy `status` | new `status` | new `payment_status` |
|---|---|---|
| `pending` | `Pending` | `Pending` |
| `paid` | `Processing` | `Paid` |
| `processing` | `Processing` | unchanged (`Pending`) |
| `shipped` | `Shipped` | unchanged |
| `completed` | `Delivered` | `Paid` |
| `cancelled` | `Cancelled` | unchanged |
| `refunded` | `Cancelled` | `Refunded` |

`payments.status`: `paid|succeeded|completed → success`, `processing → pending`,
`cancelled → failed`.

### 6.3 Verify

```bash
npm run schema:live     # code vs the reported live inventory (should print 0 broken)
npm run schema:verify-sql
```

Then paste `tools/verify-db.sql` into the Supabase SQL editor: every row must say
`OK`. The migration ends with a count query whose `bad_rows` must all be `0`.

### 6.4 Id types now match the live database

The schema previously declared `TEXT` ids for products, orders, order items,
payments and refunds, while your database uses `UUID` with foreign keys. That was
not cosmetic: `create_order_v2(p_order_id TEXT)` inserting into a `UUID` column
raises *"column is of type uuid but expression is of type text"*, so the atomic
path would fail and checkout would silently use the non-atomic fallback. The
schema and both RPCs now use `UUID`, and the JSONB line-item product id is cast
explicitly (`::uuid`).
