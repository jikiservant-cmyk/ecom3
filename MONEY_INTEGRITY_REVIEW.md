# Money-Handling Integrity Review — Drum Palace (`ecom3`)

**Date:** 2026-10-19 · **Branch:** `arena/042c77f0-ecom3` @ `e718905`
**Scope:** every path where money is *quoted, charged, recorded, reconciled, refunded or reported*.
**Method:** adversarial read of the payment/likely-money code + **10 executable probes**
(`tests/moneyIntegrity.challenge.test.ts`) that drive the real route handlers and pure
functions. Run them with:

```bash
npx vitest run tests/moneyIntegrity.challenge.test.ts
```

**Bottom line:** the *inbound* forgery defences are genuinely strong — HMAC webhook,
server-side catalog re-pricing, DB-sourced amounts, fail-closed gateway. The problem is
everything *around* that: the **ledger is not a ledger** (no settled amounts, no refund
records, no terminal states), **one authenticated user can mint orders at any price**, and
**the storefront advertises prices and discounts that the checkout does not honour**.
Money can be lost in six independent ways, and four of them are silent.

---

## 1. Findings at a glance

| # | Sev | Finding | Money impact |
|---|---|---|---|
| MI-01 | **High** | A later `Failed` notification rewrites an already-**Paid** order to `Failed` | Revenue vanishes from reports; paid goods never ship |
| MI-02 | **High** | Any signed-in user can call `create_order_v2` with arbitrary totals; COD orders are *never* price-checked | Pay 1 UGX cash for a 1.5 M UGX drum; drain stock |
| MI-03 | **High** | Admin finance view collapses `Failed`/`Refunded` → `Pending`, turns 0 into **99**, and (per RLS) the orders query fails outright | You cannot see unpaid, failed or refunded money |
| MI-04 | **High** | "Refund" is a status flip: no gateway refund, no amount, no `payments` row, allowed on unpaid orders | Refunds are untracked cash out; books never balance |
| MI-05 | Med-High | `Cancelled` and `Refunded` orders are still chargeable; paying one silently un-cancels it | Charged for cancelled goods; refund + re-charge loops |
| MI-06 | Med-High | Promotions are cosmetic: hot-deal "% OFF" prices are not honoured at checkout; anchor prices are synthesised; free-shipping attribute ignored | Bait-and-switch pricing → chargebacks, consumer-protection exposure |
| MI-07 | Medium | No overcharge ceiling: a stale/inflated total is charged *and* marked Paid; any catalog price rise or any discount makes an order permanently unpayable | Systematic over/under-charging; stranded paid-but-unmarked orders |
| MI-08 | Medium | Totals with cents are charged (rounded to whole UGX) then fail reconciliation **forever** | Customer debited, order stuck `Pending`, manual rescue only |
| MI-09 | Medium | `payments.amount_minor_units` is the *requested* amount, never the settled amount; gateway `charge`/net is ignored; manual `Paid` writes create no payment row | Ledger ≠ bank. Reconciliation always drifts |
| MI-10 | Medium | Two sources of truth for "the amount" (`total_amount` vs `total_minor_units`) and order value is re-derived from *mutable, ambiguous* state (product **name**, current shipping constant) | Nondeterministic accept/refuse; price-change breakage |
| MI-11 | Medium | `order_items` can be appended by **any** authenticated user to **any** pending order, and line prices are never reconciled to the order total | Kill a rival/own payment (valuation now mismatches); forged line items shown to ops |
| MI-12 | Low-Med | No checkout idempotency key: a timed-out response re-creates the order | Double order, double mobile-money prompt, double charge |
| MI-13 | Low | Zero-quantity lines valuate to `0` and return `ok` | Edge-case bypass of the "order must be worth something" rule |
| MI-14 | Low | Webhook coercion: missing currency tolerated, `Number()` accepts `"1e3"`/whitespace/unsafe ints | Lenient parsing on the one field that is *not* signed |
| MI-15 | Low | Public order tracking returns the order `id` — the exact key needed for MI-11 | Enables the order_items injection |

Fair credit (verified, and not to be undone): signature verification with a replay window,
catalog re-pricing at checkout, DB-sourced charge amount, idempotency markers with release on
refusal, no simulated-success fallback, per-order + merchant-level rate limits. The
architecture is right; the *accounting* around it is missing.

---

## 2. Detailed findings

### MI-01 · High — a `Failed` notification can un-pay a Paid order
**Evidence:** `app/api/payments/livepay/webhook/route.ts:246-258`

```ts
const orderUpdate: Record<string, unknown> = { updated_at: now };
if (outcome === 'paid') {
  orderUpdate.payment_status = 'Paid';
  if (order.payment_status !== 'Paid') orderUpdate.status = 'Processing';
} else {
  orderUpdate.payment_status = 'Failed';   // ← no guard on the CURRENT state
}
```

The Paid branch checks the current state; the `Failed` branch does not. The idempotency key
includes the outcome (`${internal}|${customer}|${outcome}`), so a failure notification is a
*different* event from the success and is processed normally. The DB trigger does not save
you: `orders_protect_payment_status` (`lib/schemaSql.ts:492-503`) only asks *who* is writing
(`service_role`), never *what* the old value was — and the webhook writes as service role.

**Repro:** *PROBE 5a* — order row `payment_status: 'Paid'`, signed `status: 'Failed'` payload
⇒ the handler issues `update { payment_status: 'Failed' }`. Test passes (i.e. the bug is real).

**Impact:** a paid order silently reverts. It disappears from `totalRevenue`
(`components/AdminPortal.tsx:932` counts only `Paid`), it stops moving through fulfilment, and
the customer's money is on your merchant account with no order to show for it.

**Fix:** make payment state a monotonic state machine, ideally at both layers:
```ts
// webhook
if (order.payment_status === 'Paid' && outcome !== 'paid') {
  logger.warn('webhook_late_failure_ignored', { orderId: order.id });
  return NextResponse.json({ received: true, ignored: 'already paid' });
}
// and only ever Pending -> Paid | Failed
```
```sql
-- and enforce it, so no client bug can rewrite history
CREATE OR REPLACE FUNCTION public.orders_payment_transition() ... 
IF OLD.payment_status = 'Paid' AND NEW.payment_status = 'Failed' THEN RAISE EXCEPTION ...;
```
Record refunds as a separate ledger, never by rewriting `payment_status` backwards.

---

### MI-02 · High — `create_order_v2` is executable by any signed-in user, at any price
**Evidence:** `lib/schemaSql.ts:461`

```sql
GRANT EXECUTE ON FUNCTION public.create_order_v2(...) TO authenticated;
```

The function is `SECURITY DEFINER`, does **no** `auth.uid()`/`is_admin()` check, takes
`p_total_minor_units`, `p_items` (with caller-supplied `price`) and `p_subtotal/shipping` as
arguments, writes them verbatim (`lib/schemaSql.ts:404-440`), and decrements inventory. The
comment above it says "Revoked from anon" — it was revoked from anon and **granted to
authenticated**, which is anybody who clicks "Sign up". RLS `Orders insert`
(`lib/schemaSql.ts:623`, `WITH CHECK (public.is_admin())`) is bypassed because the function
runs as its definer.

**Exploit:**
```bash
curl -X POST "$SUPABASE_URL/rest/v1/rpc/create_order_v2" \
  -H "apikey: $ANON" -H "Authorization: Bearer $USER_JWT" \
  -d '{"p_order_number":"DP-FAKE-0001","p_customer_name":"x","p_customer_email":"x@x.ug",
       "p_items":[{"productName":"Engoma Drum","quantity":1,"price":0.01}],
       "p_subtotal_minor_units":1,"p_shipping_minor_units":0,"p_total_minor_units":1,
       "p_created_at":"2026-10-19T00:00:00Z"}'
```

Why the payment route doesn't save you: it re-values the order against the catalog
(`app/api/payments/livepay/route.ts:108-160`) and would refuse a 1-UGX total. But
**Cash-on-Delivery never touches that route** — no gateway call, no webhook, no valuation.
The order sits there at 1 UGX, the customer hands over 1 UGX to the courier, and the admin UI
shows a 1-UGX total next to a real drum. Repeat it and you also drain
`inventory_quantity` (the RPC decrements stock for every order), which is a cheap way to
take the catalog offline.

**Fix (do all three):**
1. `REVOKE EXECUTE ON FUNCTION public.create_order_v2(...) FROM authenticated, anon;`
   (service role only — the API server is the only caller).
2. Add `IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION ... END IF;` at
   the top of the function so a future grant cannot re-open it.
3. Give COD the same price authority as MoMo: persist a `pricing_snapshot` (server-computed
   total + per-line unit price) at creation and **re-verify it before the order can leave
   `Pending`**, including on manual `Paid`.

---

### MI-03 · High — the admin finance view is not just wrong, it is probably empty
**Evidence:** `lib/supabaseDb.ts:770-840`

```ts
paymentStatus: (o.payment_status?.toLowerCase() === 'paid' ? 'Paid' : 'Pending') as any,
total: total > 0 ? total : 99,
items: items.length > 0 ? items : [{ productName: 'Drum Palace Order Item', quantity: 1, price: total }],
```

* `Refunded` → `Pending`, `Failed` → `Pending`. A refunded order looks unpaid-and-waiting; a
  failed mobile-money attempt looks like an abandoned checkout. The two states an operator
  most needs are erased.
* A 0-value order becomes **99** — someone else's currency, invented out of nothing — and a
  fabricated line item is injected into the order.
* `totalRevenue` (`components/AdminPortal.tsx:932`) is computed from this transformed array,
  i.e. the dashboard figure is derived from lossy display mapping, not from the ledger.

And the query above it is likely to fail entirely: it embeds `payments (...)` in the select
(`lib/supabaseDb.ts:797`) while the hardened schema **revokes all grants on `public.payments`
from `anon`/`authenticated`** (`lib/schemaSql.ts:286-311`). PostgREST requires SELECT
privilege on an embedded relation; without it the whole request errors, `normErr` is set, and
`getOrdersFromDb` falls through to `return []`. The admin portal then renders zero orders and
zero revenue — the same moment it is supposed to be the control of record.

**Repro:** *PROBE 6* — feeding two rows (`Refunded`, `Failed`) through `getOrdersFromDb`
yields `paymentStatus: 'Pending'`, `total: 99`, and a synthesised line item.

**Fix:** stop mapping money in the client. Expose a server route (or SQL view) that returns
raw, typed columns (`payment_status`, `total_minor_units`, `paid_minor_units`,
`refunded_minor_units`) and render those. Never default a monetary value to a non-zero
constant; render `—` or `0` and flag the row.

---

### MI-04 · High — refunds are not money movements
**Evidence:** `app/api/orders/route.ts:288-310`; `lib/schemaSql.ts:147-159`

Marking an order `Refunded` writes `payment_note` + `payment_status` and nothing else. There
is:

* no gateway refund call (LivePay is momo-only — fine — but then a refund is *your* cash out
  and must be recorded as such),
* no refund **amount** (partial refunds are impossible),
* no row in `payments` (`status` has a `'refunded'` enum member that nothing ever writes),
* no link to the mobile-money transaction being refunded,
* no check that the order was ever **Paid** — you can "refund" an unpaid order and the books
  now show a refund with no receipt,
* no historical record: `payment_note` is overwritten on the next write and the audit trail is
  a `logger.info` line on stdout.

**Impact:** the only place money-out exists is a mutable status column. Month-end
"collected − refunded" cannot be computed from the database at all.

**Fix:** a `refunds` table (`order_id`, `payment_id`, `amount_minor_units`, `reason`,
`actor_id`, `gateway_ref`, `created_at`), written before the order status changes; refunds
reduce a derived `net_paid_minor_units`, and `Refunded` becomes a *derived* state, not a
hand-set one.

---

### MI-05 · Med-High — cancelled and refunded orders stay chargeable
**Evidence:** `app/api/payments/livepay/route.ts:95-99`

```ts
if (!order) return jsonError('Order not found', 404);
if (order.payment_status === 'Paid') return jsonError('This order has already been paid', 409);
```

`status` is not selected and not checked, and `payment_method` is not checked either. So:

* a **Cancelled** order can be paid; the webhook then sets `status: 'Processing'`
  (`route.ts:250-253`) — the cancellation is silently undone;
* a **Refunded** order can be paid again (`payment_status !== 'Paid'`), with the same
  `ORD{order_number}` reference the gateway has already seen;
* a **COD** order can be paid online, leaving `payment_method: 'cod'` on a Paid order, so the
  courier can also collect cash for it.

**Fix:** `select` and gate on `status`; allow payment only for
`status IN ('Pending','Processing')` **and** `payment_status IN ('Pending','Failed')` **and**
`payment_method = 'momo'`. Add an explicit `Cancelled` terminal check in the webhook too.

---

### MI-06 · Med-High — the storefront advertises prices the checkout does not honour
Three separate mechanisms, all visible to customers:

1. **Hot deals** (`app/page.tsx:1056-1070, 1146-1152`). The card shows
   `dealPrice = deal.customPrice ?? prod.price` with a struck-through
   `originalPrice = dealPrice / (1 - discount/100)` and a `"{n}% OFF"` badge. "Claim Deal"
   calls `addToCart(prod.id, 1)`, and the cart prices the line at `prod.price`
   (`app/page.tsx:482-485`). So:
   * `customPrice` set lower than the catalog ⇒ the customer is shown, and clicks, the
     **discounted** price and is charged the **full** price;
   * `customPrice` unset ⇒ the card shows "25% OFF" against a **synthesised** anchor price
     (`price / 0.75`) — a discount that never existed, at a price that is the list price.
2. **Server-side, discounts are impossible by construction.** Any total below catalog value is
   rejected (`lib/server/orders.ts:105-108` and *PROBE 2b*) — so there is no way to honour a
   promo, a voucher, a loyalty price or a negotiated deal. The `discount_minor_units` column
   exists and is always 0 (`lib/schemaSql.ts:418`).
3. **Shipping is advertised as free and always charged.** `free_shipping` defaults to TRUE in
   the schema and `freeShipping` defaults true on every product
   (`lib/supabaseDb.ts:200,272,348,495`), while the checkout hard-codes a 25,000 UGX flat fee
   in two places (`app/page.tsx:487`, `lib/server/orders.ts:21`). `freeShippingThreshold`
   exists in `storeSettings` and is read by nothing.

**Impact:** this is the finding most likely to produce a chargeback, a public complaint or a
consumer-protection complaint, because the customer has *evidence* of the price they were
shown. The server re-pricing that protects you from forged totals also guarantees the
displayed discount is never applied.

**Fix:** pick one. Either (a) implement promotions server-side — a `promotions`/`coupon`
table, applied to the catalog price *before* the total is persisted, and pass the promo id in
the order payload so the webhook's valuation uses the same discounted basis; or (b) remove the
deal badge/`customPrice`/strike-through UI entirely. Never compute an anchor price on the
client. Make shipping a single server-owned rule (a settings row read by both the checkout
preview and `computeOrderTotals`) and honour `freeShippingThreshold`.

---

### MI-07 · Medium — no overcharge ceiling; any price movement breaks in-flight orders
**Evidence:** `lib/server/orders.ts:98-112`, `app/api/payments/livepay/route.ts:98`

`valueOrderAgainstCatalog` only computes `shortByMinor = max(0, catalog − stored)` and calls
the order `ok` when that is 0. A stored total **above** catalog is explicitly allowed. The
payment route then charges the *stored* total, and `reconcilePaymentAmount` demands an exact
match to the stored total — so an inflated/stale total is charged and happily marked Paid:
no upper bound anywhere.

**Repro:** *PROBE 2a* — order stored at 20,000 UGX, catalog is 15,000 ⇒ `ok: true`,
`catalogTotal 17,500`, customer charged 20,000, webhook `amountOk: true`.

The same rigidity cuts the other way:
* *PROBE 2b* — a 10 % discount ⇒ `ok: false` ⇒ the order can never be paid.
* *PROBE 2c* — the catalog price rises after the order is placed ⇒ `ok: false` ⇒ the customer
  gets "The total on this order no longer matches our catalog" and cannot pay the order they
  placed. Meanwhile the webhook refuses the payment if they somehow paid it.
* changing `FLAT_DELIVERY_FEE_MINOR_UNITS` (or implementing the free-shipping threshold)
  retroactively invalidates every pending order, because shipping is re-derived at payment
  time from a live constant rather than read from the order row.

**Fix:** the order must carry its own immutable pricing basis — a `pricing_snapshot` JSONB
(`{lines:[{product_id, name, unit_minor_units, quantity}], shipping_minor_units, discount_minor_units}`)
written at creation — and valuation must compare the *payment* against that snapshot (plus a
bounded tolerance for gateway rounding), not against today's catalog. Keep the live-catalog
check as an *additional* fraud signal, never as the sole ledger.

---

### MI-08 · Medium — fractional-shilling totals are charged, then never reconcile
**Evidence:** pay `route.ts:98` rounds the charge to whole UGX; `reconcilePaymentAmount`
(`lib/server/orders.ts:169-183`) demands `round(total_amount*100) == round(payload.amount*100)`.

`amountUgx = Math.round(total_amount)` while `expectedMinor = Math.round(total_amount * 100)`.
If `total_amount` carries cents (a `price_minor_units` that is not a multiple of 100, a
discount, an FX-converted price, a hand-entered deal price), the collected amount can never
equal the expected amount.

**Repro:** *PROBE 1* — 99 out of 99 cent-values fail. The customer **is** debited, the order
stays `Pending` forever, and the only recovery is an admin noticing a log line.

**Fix:** decide the currency's granularity once. UGX has no circulating subunit, so:
`CHECK (total_minor_units % 100 = 0)` on `orders`, reject non-whole-shilling prices at
catalog write time, and derive the charge from the *same* integer you later reconcile
(`amountUgx = totalMinorUnits / 100`, assert `Number.isInteger`). Then have the webhook compare
`paidMinor` to `totalMinorUnits` (one source), not to a re-derived `total_amount`.

---

### MI-09 · Medium — the payments table records intentions, not settlements
**Evidence:** `app/api/payments/livepay/route.ts:190-205` inserts
`amount_minor_units: amountUgx * 100` with `status: 'pending'` **before** calling the gateway.
On success the webhook updates only `status`, `provider_reference`, `raw_payload`
(`webhook/route.ts:232-246`). Nothing ever:

* stores what the gateway says it **collected** for this transaction,
* stores the gateway's `charge` (fee) or computes **net**,
* stores `provider_transaction_id` / `completed_at` as columns (they are only buried in
  `raw_payload`),
* writes a `payments` row at all when an admin marks an order Paid by hand — so manually
  reconciled money has no payment record and the order's `payments` list is empty,
* writes a `refunded` row (see MI-04).

Also, the webhook's payment-row update is keyed on `provider_reference = customer_reference`,
which the pay route set to `ORD{order_number}` — while the *gateway's* `internal_reference` is
the thing that actually identifies the transaction. You cannot join your ledger to the
gateway's settlement report by `internal_reference` because it is only stored inside JSON.

**Impact:** `SELECT sum(amount_minor_units) FROM payments` (the obvious revenue query) sums
*attempts*, not collections, at the *requested* amount, with no fees and no refunds. It will
never equal the bank.

**Fix:** add `settled_amount_minor_units`, `fee_minor_units`, `net_amount_minor_units`,
`provider_transaction_id`, `settled_at` to `payments`; populate them from the verified webhook
payload; write a zero-amount/`manual` payment row (or a `manual_adjustments` row) when an admin
forces a status. Derive revenue from `net_amount_minor_units − refunds`, never from
`orders.total_amount`.

---

### MI-10 · Medium — two sources of truth for "the amount", and mutable valuation inputs
**Evidence:**
* `reconcilePaymentAmount` prefers `total_amount` (`lib/server/orders.ts:169-172`);
  `valueOrderAgainstCatalog` is fed `total_minor_units` (`livepay/route.ts:135`). The same
  request can therefore validate one number and charge another; the two columns are written
  independently by three code paths (`create_order_v2` line 419, `createOrderServer` lines
  373-378, dead `createOrderInDb` lines 634-640) and only one of them is `ROUND(...,2)`.
* Order value at payment time is re-derived from the product **name**
  (`lib/server/orders.ts:88-96`), because `order_items` has no `product_id` column
  (`lib/schemaSql.ts:134-146`). `buildCatalogPriceIndex` lets "the first product win a name"
  over a `.in('name', …)` query with **no `ORDER BY`** — so two products sharing a name make
  the verdict depend on Postgres row order.
* Shipping is re-derived from a constant at payment time (see MI-07).

**Repro:** *PROBE 3* — identical order, identical catalog, opposite verdicts depending only on
the order of the rows returned. In production, a legitimate order can be refused (customer
stranded) or, in the cheaper-row case, overcharged — nondeterministically.

**Fix:** one amount column. Persist `total_minor_units` and derive/`GENERATED` the rest (or
drop `total_amount`); add `CHECK (total_minor_units = subtotal_minor_units - discount_minor_units + shipping_minor_units + tax_minor_units)`.
Add `product_id` to `order_items` and value by id; add `ORDER BY` and a uniqueness rule on
`products(name)` (or explicitly model variants instead of names).

---

### MI-11 · Medium — `order_items` is writable by anyone, on any order, and never reconciled
**Evidence:** `lib/schemaSql.ts:638-641`

```sql
CREATE POLICY "Order items insert" ON public.order_items FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id)
);
```

No ownership check, no admin check, and `GRANT SELECT, INSERT ON public.order_items TO
authenticated` (`lib/schemaSql.ts:300`). The only guard is "the order is still Pending"
(`order_items_require_pending_order`, lines 515-538) — which is exactly the window that
matters. Combined with `publicOrderView` returning the order `id` for any known order number
(`app/api/orders/route.ts:17-33`), any signed-in user can append lines to any pending order
they can name.

**Impact:** blank-line DoS on payment — appending a 20× drum line raises the catalog valuation
above the stored total, so the pay endpoint returns 409 and the webhook refuses; the victim's
order can never be paid. The appended rows also render in the admin order detail and in the
fulfilment pick list. Separately, nothing ever checks that
`sum(order_items.line_total_minor_units) == orders.total_minor_units`, so the line-item ledger
and the order ledger can disagree silently.

**Fix:** `WITH CHECK (public.is_admin() OR EXISTS (SELECT 1 FROM orders o WHERE o.id = order_id
AND o.customer_id = auth.uid() AND o.payment_status = 'Pending'))` — or simply revoke INSERT
from `authenticated` and let only the service role write items (the API already does this).
Add the sum-vs-total invariant as a deferred constraint or an `order_totals_consistent()` check.

---

### MI-12 · Low-Medium — no checkout idempotency
`app/page.tsx:710-760` posts to `/api/orders` with no client-generated idempotency key, and
`createOrderServer` has none either. A mobile-network timeout on the POST, followed by the user
tapping "Pay" again, creates a second order with a new `order_number` ⇒ a **new gateway
reference** ⇒ a second live collection is permitted. Two mobile-money prompts, two charges,
two orders.

**Fix:** client sends `Idempotency-Key` (UUID) stored in `orders.client_request_id` with a
`UNIQUE` index; the API returns the existing order on conflict.

---

### MI-13 · Low — zero-quantity lines are "ok" and worth 0
*PROBE 4:* `valueOrderAgainstCatalog` clamps quantity with `Math.max(0, …)`, so a line of
quantity 0 contributes 0, the subtotal is 0, **shipping becomes 0** (the `subtotal > 0` rule),
and `ok: true` with `catalogTotalMinor: 0`. The API validates quantity 1..20, so this needs a
non-API writer (MI-02) — but the invariant "an order is worth what its lines are worth" should
reject `quantity <= 0` outright rather than silently valuing it at zero.

---

### MI-14 · Low — lenient coercion on the one field the signature does not cover
`reconcilePaymentAmount` accepts `payloadCurrency` absent/empty as a match
(`lib/server/orders.ts:186-188`) and runs `Number(payloadAmount)` on any string: `"1e3"`,
`" 175000 "`, `"0x2AB00"` all parse; values beyond `Number.MAX_SAFE_INTEGER` silently lose
precision. The signature covers `customer_reference/internal_reference/status` only, so
`amount`/`currency` are attacker-influenced if the webhook secret ever leaks or a proxy is
misconfigured. Require `/^\d{1,15}$/`, require the currency to be present and `UGX`, and
reject `> Number.MAX_SAFE_INTEGER`.

---

### MI-15 · Low — public tracking is a capability, and it leaks the order id
`app/api/orders/route.ts:17-33` returns `id` plus `total`, item names and payment status for
any order number. `DP-XXXX-XXXX` over a 32-symbol alphabet is 32⁸ ≈ 1.1 × 10¹² — not
enumerable at the rate limiter's budget, but order numbers are also the gateway reference and
travel through support chats and screenshots. Returning `id` turns a low-value disclosure into
the key for MI-11. Drop `id` from the public view.

---

## 3. What I could not verify from the repo

| Item | Needed |
|---|---|
| Whether the live DB has the hardened schema applied (MI-02/MI-11 severity depends on it) | Supabase access |
| Whether PostgREST actually rejects the embedded `payments` select (MI-03) | A live Supabase project |
| LivePay's handling of fractional amounts and duplicate references (MI-05/MI-08) | Merchant account / sandbox |
| Real settlement reports (fees, `charge`, refunds) to reconcile MI-09 | LivePay dashboard |

Everything above marked with a PROBE number **is** verified by execution against the real
handler code, not by reasoning alone.

---

## 4. Fix order (money at risk first)

| # | Change | Closes |
|---|---|---|
| 1 | Revoke `create_order_v2` from `authenticated`; add a `service_role` guard inside it | MI-02 |
| 2 | Webhook: block `Paid → Failed`; DB trigger for monotonic transitions; only `Pending → Paid/Failed` | MI-01 |
| 3 | Gate payment on `status`/`payment_method`; `Cancelled`/`Refunded` are terminal for collection | MI-05 |
| 4 | Immutable `pricing_snapshot` on the order; value the payment against it, not today's catalog; add `product_id` to `order_items` | MI-07, MI-10 |
| 5 | `refunds` table + `settled_amount/fee/net/provider_transaction_id` on `payments`; revenue = net − refunded | MI-04, MI-09 |
| 6 | Replace `getOrdersFromDb` money mapping with a server route/view of raw typed columns; fix the `payments` embed privilege | MI-03 |
| 7 | Whole-shilling invariant (`total_minor_units % 100 = 0`) + single amount column + arithmetic `CHECK` | MI-08, MI-10 |
| 8 | Server-side promotions **or** delete the deal/anchor-price UI; honour `freeShippingThreshold`; one shipping rule | MI-06 |
| 9 | `order_items` INSERT → service role only; sum-vs-total invariant | MI-11, MI-13 |
| 10 | `Idempotency-Key` on checkout; strict integer/currency parsing in the webhook; drop `id` from public tracking | MI-12, MI-14, MI-15 |

---

## 5. Appendix — probe results

```
npx vitest run tests/moneyIntegrity.challenge.test.ts

PROBE 1 — fractional-shilling order is debited and can never be marked Paid   (2 tests)
PROBE 2 — no upper bound: a stale/overstated total is charged and accepted     (3 tests)
PROBE 3 — post-hoc valuation keys on product NAME, not id                      (1 test)
PROBE 4 — a zero-quantity line makes the order worth nothing, and "ok"         (1 test)
PROBE 5 — payment state machine is not monotonic or terminal                   (2 tests)
PROBE 6 — getOrdersFromDb corrupts the payment ledger it feeds the dashboard   (1 test)

Tests  10 passed (10)   ·   full suite: 115 passed (115)
```

The probes are written as executable documentation of the *current* behaviour: each one
asserts the bug, so a fix will turn it red and force a deliberate update.
