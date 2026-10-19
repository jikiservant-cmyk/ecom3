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
| L1 | `orders` has **no `payment_status`**; payment state is folded into `status` (`paid`, `refunded`, `completed`) | a separate `payment_status` (`pending`/`paid`/`failed`/`refunded`) | every checkout insert fails (unknown column), refunds and the webhook cannot mark anything Paid |
| L2 | `orders.status` is an **enum** (`order_status`) with lower-case labels, originally without `delivered` | the same labels, with `delivered` added | `delivered` is now in the type (you added it); no CHECK is created, because a CHECK would reject the type's own `paid`/`completed`/`refunded` |
| L3 | `payments.status` is an **enum** whose settled label is **`paid`** | an earlier draft wrote `success` for a settled payment | every settlement rejected ("invalid input value for enum") → payments stay `pending` forever. The app now writes `paid` |
| L4 | No `refunds` table; no `(provider, event_id)` uniqueness on `payment_webhook_events` | refund ledger + idempotent webhooks | refunds 500; a redelivered webhook can be processed twice |

Also missing and created by the schema script: `reviews`, `store_ratings`,
`wishlists`, `contact_messages`, `orders.{items,payment_method,pricing_snapshot,
client_request_id,refunded_minor_units,payment_note,tracking_number}`,
`payments.{settled_amount_minor_units,fee_minor_units,net_amount_minor_units,
provider_transaction_id,settled_at}`, and `profiles.email`.

### 6.1b The database is now Partially Aligned

The additive half of `lib/schemaSql.ts` has been applied. Present now: `orders.items`,
`orders.payment_status`, `orders.total_amount`, `orders.payment_note`,
`orders.refunded_minor_units`, `orders.pricing_snapshot`, `orders.client_request_id`,
`orders.payment_method`, `orders.tracking_number`, `profiles.email`, `products.origin`,
the five `payments` settlement columns, and a `refunds` table (RLS on, `anon`/
`authenticated` revoked, `service_role` granted, `ON DELETE RESTRICT`).

Deliberately **not** applied: the functions, triggers, policies, broad grants, and the
tables whose definitions looked incomplete.

**Since then you have also applied the `(provider, event_id)` unique key** on
`payment_webhook_events`, so redelivered webhooks are deduplicated by the database,
not only by the handler.

Consequences while it stays that way:

| Still missing | Runtime consequence |
|---|---|
| `orders.status` CHECK (legacy `paid`/`completed` values, no `delivered`) | **checkout insert still fails for `delivered`** — the app now writes lowercase only, but the legacy check does not list it |
| `payments.status` CHECK (legacy values) | settlement writes `success`, which the legacy check rejects |
| `create_order_v2` | checkout uses the non-atomic fallback: **oversell possible** |
| guest idempotency index | a retried guest checkout creates a **second order and a second money prompt** |
| `record_refund` | refunds work via the optimistic fallback, but not in one transaction |
| triggers + `is_admin()` | nothing stops a direct PostgREST write from flipping `payment_status` |
| tightened policies | **the browser can still INSERT/UPDATE/DELETE orders and read payments** with the public anon key |
| `reviews`, `store_ratings`, `contact_messages` | those three features return 500 |

`supabase/migrations/20261020_finish_alignment.sql` supplies **complete, reviewed**
definitions for exactly these — that is the file that finishes the job.

### 6.2 Run these files, in this order

```text
1.  lib/schemaSql.ts                          (Admin Portal → Cloud Sync → Copy Complete SQL Schema)
      ↳ creates the missing tables, adds the missing columns, installs the RPCs,
        triggers, RLS policies and grants. Idempotent.

2.  supabase/migrations/20261020_finish_alignment.sql   ← run this next
      ↳ complete definitions of everything the partial run skipped: the CHECK
        constraint replacement, the guest-safe idempotency index, the webhook
        unique key, `create_order_v2`, `record_refund`, `is_admin()`, all four
        triggers, and `reviews` / `store_ratings` / `contact_messages` with
        least-privilege policies. Ends with a checklist query.

3.  supabase/migrations/20261019_align_live_db.sql      (optional)
      ↳ only needed if you still hold rows whose `status` uses the legacy
        vocabulary (`paid`, `completed`, `refunded`). It normalises those values.
        Step 2 already replaced the constraints, so this can run before or after.
```

Step 1a (`20261020a_enum_labels.sql`) must be run **on its own, before** the main
migration: a label added by `ALTER TYPE ... ADD VALUE` cannot be used in the same
transaction that added it, and the SQL editor runs a paste as one batch. You have
already added `delivered`, so for you it is a no-op — it exists so the step is
repeatable on a rebuild.

Step 2 refuses to run (with a clear message) if step 1 has not been applied or if
the enum still lacks `delivered`, and every statement in it is guarded, so it is
safe to re-run. **Take a backup first**
— step 1b rewrites the values the old client wrote. Nothing is re-cased: the
vocabulary is the database's own, lowercase. What changes is which column holds
what:

| before | after `status` | after `payment_status` |
|---|---|---|
| `Pending` | `pending` | `pending` |
| `Processing` | `processing` | unchanged |
| `Shipped` | `shipped` | unchanged |
| `Delivered` | `delivered` | unchanged |
| `Cancelled` | `cancelled` | unchanged |
| `paid` | `processing` | **`paid`** |
| `completed` | `delivered` | **`paid`** |
| `refunded` | `cancelled` | **`refunded`** |

`payments.status`: `paid|succeeded|completed → success`, `processing → pending`,
`cancelled → failed`. Those rows are the ledger's; the order's own payment state
is `payment_status`.

### 6.3 Verify

```bash
npm run schema:live       # code vs the reported live inventory (should print 0 broken)
npm run schema:sql-lint   # every .sql and the embedded schema parses under libpg_query
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

---

## 7. Status vocabulary, variant pricing and write ownership

Three questions were open when the partial run stopped. All three are now closed
in code, and one of them still needs section 1b above.

### 7.1 One vocabulary, and it is the database's

`lib/status.ts` is the single source of status strings:

```ts
ORDER_STATUS   = { pending, processing, shipped, delivered, cancelled }
PAYMENT_STATUS = { pending, paid, failed, refunded }        // orders.payment_status
PAYMENT_ROW_STATUS = { pending, success, failed, refunded } // payments.status (ledger)
```

`success` is not a typo and `paid` is not a duplicate: they are two different
tables with two different meanings. An **order** is *paid*; the **payment row**
that settled it is *success*. Every write site imports these constants, so a
literal like `'Pending'` cannot creep back in — `tests/variantAndStatus.test.ts`
fails the build if one appears in the migration.

Incoming requests are still accepted in any casing (`normaliseOrderStatus`), so
an old browser tab cannot break checkout, but only the lowercase value is stored.

### 7.2 Checkout takes a `variant_id`, and the server prices it

`POST /api/orders` accepts `variantId` per line:

* it must be a UUID — a malformed id is **rejected**, not ignored (ignoring it
  would silently fall back to the product's primary price);
* the variant must exist, be `active`, and belong to the `productId` on the same
  line — otherwise `400`;
* that variant's `price_minor_units` becomes the line price. The product's
  primary price is the fallback only when no variant is named;
* the client's `price` field is still ignored, and the claimed total must match
  the server's computation.

`create_order_v2` mirrors this: it resolves the variant, decrements **that
variant's** `inventory_quantity` with a conditional `UPDATE` (so the last unit
cannot be sold twice), and records `order_items.variant_id`. The non-atomic
fallback has the same variant-aware stock pre-check.

The storefront now sends it: `product_variants` are surfaced as
`variantOptions` on each product, the product page shows an option selector, and
the cart keeps the variant as part of the line identity (same drum, two sizes =
two lines).

### 7.3 Every money write is server-side

| Operation | Path | Credential |
|---|---|---|
| create order | `POST /api/orders` → `create_order_v2` | `service_role` |
| settlement | `POST /api/payments/livepay/webhook` | `service_role` |
| refund | `POST /api/orders/refund` → `record_refund` | `service_role` |
| admin status / tracking | `PATCH /api/orders` | admin JWT, audit-logged |

The one exception was `AdminPortal`'s status dropdown, which wrote
`orders.status` straight from the browser with the anon key — and in the wrong
casing. It now calls `PATCH /api/orders`, like the tracking editor already did.

Section 9 of the migration closes the hole underneath it:

* `orders` and `order_items` keep a **SELECT-only** policy (owner or admin);
  `INSERT`/`UPDATE`/`DELETE` grants are revoked from `anon` and `authenticated`;
* `payments` and `refunds` have **no** policies at all for those roles;
* every existing permissive write policy on the four tables is dropped by name
  discovery, so a policy someone added by hand cannot survive.

**Order matters:** deploy the application before running section 9, or the admin
dashboard's status buttons will fail with a permission error (which is the
correct behaviour, but confusing during a deploy).

### 7.4 The admin portal's two database dependencies

The portal authenticates properly (server-verified role, throttled sign-in, no
offline fallback), so the only way in is a `profiles.role = 'admin'` row. Two
triggers decide whether that is trustworthy:

| Trigger | Without it |
|---|---|
| `protect_profile_role` (§7f) | `profiles` allows a user to edit their own row, so a signed-in customer can PATCH `role = 'admin'` and sign into the portal |
| `handle_new_user` (§7e) | A new sign-up has no profile row: the portal cannot recognise them, and `orders.customer_id REFERENCES profiles(id)` makes their checkout fail |

Both were in `lib/schemaSql.ts` but **not** in the additive half you ran, so they
are now section 7e/7f of the migration, with the existing users backfilled. The
role guard permits a role change when the request carries **no** JWT — that is the
SQL editor, i.e. how the first admin is provisioned:

```sql
UPDATE public.profiles SET role = 'admin' WHERE email = 'you@example.com';
```

### 7.5 What changed after the enum review

The first draft of the migration was written against a TEXT-with-CHECK schema. It
is not, and four things followed from that:

| Was | Now |
|---|---|
| `success` written to `payments.status` | `paid` — the enum label that actually exists; `lib/status.ts` refuses to define `success` at all |
| `orders_status_valid` / `payments_status_valid` CHECKs | removed; the type is the validator, and a CHECK would reject `paid`/`completed`/`refunded` |
| `ALTER TYPE ... ADD VALUE` inside the main script | moved to `20261020a_enum_labels.sql` (own batch), with a preflight that stops the main script if `delivered` is missing |
| guest idempotency scoped to the literal `'guest'` | scoped to `(guest_session_id, client_request_id)`; the customer-scoped index is kept, not dropped |

Three more corrections in the same pass:

* **`create_order_v2` no longer trusts `item.price`.** It resolves the product and
  variant from the database, takes the price from `product_variants`, and then
  reconciles: subtotal must equal Σ(catalog × qty), a line price may discount but
  never exceed the catalog price, and Σ(line prices) must equal subtotal −
  discount. A line without a valid, active product **and** variant is refused.
* **Section 2 never deletes.** The webhook unique index already exists, so it is
  verified and left alone; if duplicates were ever found it reports them instead
  of destroying audit rows.
* **The auth trigger is never dropped.** If `auth.users` already has an AFTER
  INSERT trigger, the migration says so and leaves it alone rather than silently
  removing whatever else it did.

Also tightened: catalog writes (`products`, `product_variants`, `product_images`,
`categories`) are admin-only, `payment_webhook_events` is service-role only, and
`reviews` grants column-level SELECT that excludes `user_email` — a public read
policy on the row would have published every reviewer's address.
