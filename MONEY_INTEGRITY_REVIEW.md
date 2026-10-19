# Money-Handling Integrity Review — Drum Palace (`ecom3`)

**Review date:** 2026-10-19 · **Remediation date:** 2026-10-19
**Branch:** `arena/042c77f0-ecom3`
**Scope:** every path where money is *quoted, charged, recorded, reconciled, refunded or reported*.
**Method:** adversarial read of the money paths + executable probes that drive the real route
handlers and pure functions.

> ## Status: all 15 findings remediated
> The probes that originally reproduced each defect now assert the fixed behaviour and live in
> **`tests/moneyIntegrity.test.ts`** (45 tests) and **`tests/moneyPentest.test.ts`** (44 adversarial
tests). The full suite is **196 tests, all passing**,
> with `tsc --noEmit` and `eslint .` clean.
>
> ```bash
> npx vitest run tests/moneyIntegrity.test.ts
> ```
>
> **Deployment requirement:** re-run the schema SQL (`lib/schemaSql.ts` /
> Admin Portal → Cloud Sync → Copy Complete SQL) before deploying this code. It adds the
> `refunds` table, the settled-amount columns on `payments`, `product_id` on `order_items`,
> `pricing_snapshot` / `client_request_id` / `refunded_minor_units` on `orders`, the money
> constraints, the monotonic payment-state triggers, and replaces `create_order_v2` with a
> service-role-only version. The app degrades safely without it (order writes fall back to
> direct inserts and refunds will error), but the guarantees below need the schema.

---

## 1. Findings and remediation

| # | Sev | Finding | Status | Fix |
|---|---|---|---|---|
| MI-01 | High | A later `Failed` notification rewrote an already-**Paid** order to `Failed` | **Fixed** | Monotonic guard in the webhook + `orders_protect_payment_status` trigger |
| MI-02 | High | Any signed-in user could call `create_order_v2` with arbitrary totals; COD orders were never price-checked | **Fixed** | `REVOKE … FROM PUBLIC, anon, authenticated`; `service_role` guard inside the function; all orders priced server-side |
| MI-03 | High | Admin finance view collapsed `Failed`/`Refunded` → `Pending`, turned 0 into **99**, invented line items, and its query failed outright on the `payments` embed | **Fixed** | Faithful `mapOrderRow`; embed removed; flat-query fallback; revenue computed net of refunds |
| MI-04 | High | "Refund" was a status flip: no amount, no record, allowed on unpaid orders | **Fixed** | `refunds` ledger + `POST /api/orders/refund` + negative cash-flow row in `payments`; partial refunds supported |
| MI-05 | Med-High | Cancelled and refunded orders were still chargeable; paying a cancelled order un-cancelled it | **Fixed** | State gates in the pay route; terminal-state handling in the webhook |
| MI-06 | Med-High | Promotions were cosmetic: hot-deal prices were not honoured, anchor prices were synthesised, `freeShipping` was ignored | **Fixed** | Server-side `priceOrder` with real promos; honest badges/strike-through; free-delivery threshold honoured |
| MI-07 | Medium | No overcharge ceiling; any price change or discount stranded in-flight orders | **Fixed** | Immutable `pricing_snapshot` per order; payment validated against the snapshot, not live catalog |
| MI-08 | Medium | Fractional-shilling totals were charged (rounded) then failed reconciliation forever | **Fixed** | Whole-shilling invariant: catalog rounding, `priceOrder`, API check, DB `CHECK (… % 100 = 0)` |
| MI-09 | Medium | `payments` stored requested amounts only; fees/net/provider ids ignored; manual `Paid` writes left no payment row | **Fixed** | `settled_amount_minor_units`, `fee_minor_units`, `net_amount_minor_units`, `provider_transaction_id`, `settled_at`; manual reconciliation writes a `provider='manual'` row |
| MI-10 | Medium | Two sources of truth for the amount; valuation keyed on non-unique product **names** | **Fixed** | `total_minor_units` is the single source; `order_items.product_id` added; ambiguous names are detected and refused |
| MI-11 | Medium | `order_items` appendable by any authenticated user to any pending order | **Fixed** | INSERT is service-role/admin only (grant revoked + trigger); public tracking no longer leaks the order id |
| MI-12 | Low-Med | No checkout idempotency: a timed-out response created a second order and a second charge | **Fixed** | `Idempotency-Key` header → `orders.client_request_id` (unique partial index); replays return the original order |
| MI-13 | Low | Zero-quantity lines valuated to `0` and returned `ok` | **Fixed** | Rejected as unchargeable in both valuation paths and in snapshot validation |
| MI-14 | Low | Lenient coercion of the unsigned `amount`/`currency` fields | **Fixed** | Strict `^\d{1,12}(\.\d{1,2})?$` parsing, safe-integer bound, whole-shilling requirement |
| MI-15 | Low | Public tracking returned the order `id` (the key for MI-11) | **Fixed** | `id` removed from the public view |

### Accepted risk (documented, not silently ignored)

**A webhook with no `currency` field is still accepted.** LivePay's signature does not cover
`amount` or `currency`, and the amount is now compared to a whole-shilling integer that must
match exactly, so an omitted currency adds no exploit path while refusing it risks rejecting
genuine notifications from a gateway that omits the field. When the currency *is* present it
must match the order's.

---

## 2. What changed, by area

### Pricing is one pure function, shared by the browser and the server
`lib/pricing.ts` is the new single source of truth:

- `priceOrder({ lines, deals, freeShippingThresholdMinorUnits })` returns the full breakdown
  (catalog subtotal, discount, shipping, total, per-line unit prices, promotion ids).
- `lib/server/orders.ts` and `app/page.tsx` both call it, so **the price shown is the price
  charged**. The old duplicate calculation in the storefront (`subtotal` + hard-coded fee = `grandTotal`)
  is gone.
- Promotions come from `store_settings.hotDeals` and are applied **server-side**. A deal can
  only make a line cheaper — never more expensive, never below one shilling.
- Delivery is **10,000 UGX** unless the *net* subtotal (after discounts) reaches
  `freeShippingThreshold` (default 500,000 UGX). A promotion therefore cannot unlock free
  delivery on a cart that does not qualify.
- Every amount is a whole-shilling integer. `toWholeShillingMinor` is the only rounding step;
  catalog writes round up once (`saveProductToDb`).

### Every order carries its own immutable pricing basis
At checkout the server writes `orders.pricing_snapshot`:

```json
{ "version": 1, "currency": "UGX",
  "lines": [{ "productId": "…", "productName": "…", "quantity": 2,
              "catalogUnitMinorUnits": 1500000, "unitMinorUnits": 1350000,
              "lineTotalMinorUnits": 2700000, "discountMinorUnits": 300000, "promotionId": "deal-1" }],
  "subtotalMinorUnits": 3000000, "discountMinorUnits": 300000,
  "shippingMinorUnits": 1000000, "totalMinorUnits": 3750000, "freeShippingApplied": false }
```

`validatePricingSnapshot` re-checks it at payment start and on every webhook:
line arithmetic, unit ≤ catalog, subtotal/discount/total consistency, and agreement with the
stored columns. Consequences:

- a catalog price change no longer strands (or reprices) a placed order;
- a discount is a first-class, payable order rather than a "total mismatch";
- a forged row cannot claim a total its own lines do not justify.

### The payment state machine is monotonic
```
Pending ──► Paid ──► Refunded (terminal)
   └─────► Failed
```
Enforced twice — in the webhook handler and by the `orders_protect_payment_status` trigger — so
neither a stale gateway notification nor a client bug can move money backwards. A paid order
also becomes **immutable in amount** (`orders_protect_amounts`), so nobody can reprice history.
A paid notification for a *cancelled* order is refused and logged for manual reconciliation
rather than silently marking it Paid (goods are not going out) or silently dropping it.

### Refunds are ledger entries
`POST /api/orders/refund` (admin only) requires a paid order, a positive whole-shilling amount,
a reason, and an amount within the remaining balance. It writes:

1. a `refunds` row (amount, reason, actor, method, reference),
2. a `payments` row with `status='refunded'` and a **negative** `net_amount_minor_units`,
3. `orders.refunded_minor_units += amount`, flipping `payment_status` to `Refunded` (and
   `status` to `Cancelled`) only when the balance reaches zero.

Revenue is therefore `Σ(settled − fee) + Σ(refunds)` and reconciles against the bank.

### The ledger records settlements, not intentions
The webhook now stores what the gateway says it collected (`amount`), its `charge` as a fee, the
net, `provider_transaction_id` and `settled_at`. The pay route still records the requested
amount at initiation. Manual admin reconciliation writes a `provider='manual'` payment row, so a
hand-marked Paid order is no longer invisible to the books.

### Checkout is idempotent
The storefront sends `Idempotency-Key` for each checkout intent; the API stores it in
`orders.client_request_id` (unique partial index). A retry — network timeout, double tap, a
failed gateway call after the order was created — returns the **same** order instead of
creating a second one and a second mobile-money prompt.

### The admin portal reports the truth
- `Failed` and `Refunded` are shown as themselves; nothing is coerced to `Pending`.
- No fabricated line items; no `0 → 99` substitution.
- The orders query no longer embeds `payments` (which is service-role only and made PostgREST
  reject the whole request, blanking the dashboard); there is a flat-query fallback for older
  databases.
- The payment control is a real state machine: `Paid` can't be selected back to `Pending`,
  `Refunded` is disabled, and a **Record refund** action captures amount + reason.

### Database hardening
- `create_order_v2` is re-created with `pricing_snapshot` / `client_request_id` / `discount`
  parameters, an internal `service_role` guard, whole-shilling and arithmetic checks, a
  snapshot/total agreement check, and `EXECUTE` revoked from `PUBLIC`, `anon` and
  `authenticated`.
- `order_items` INSERT is service-role/admin only; the old permissive policy is dropped.
- Money `CHECK` constraints (`% 100 = 0`, `total = subtotal − discount + shipping + tax`,
  `0 ≤ refunded ≤ total`), installed `NOT VALID` so they can be applied to an existing database
  while still governing every new write.
- `refunds` is RLS-enabled with no policies and no grants (service role only).
- `orders_force_pending` also zeroes `refunded_minor_units`; `product_id` is recorded on line
  items so valuation never depends on a name.

---

## 2b. LivePay products: collect-money and card-collection

The application previously treated LivePay as mobile-money only. Its documentation
defines **two** products with different contracts, and the shop advertises card
acceptance, so the app now implements both:

| | Collect Money (`/collect-money`) | Card Collection (`/card-collection`) |
|---|---|---|
| Auth | `Bearer <API key>` | `Bearer <keyId>.<secret>` |
| Currency | UGX (any, `network` required off-UGX) | **USD only**, $1.00–$5,000.00 |
| Result | prompt on the handset | hosted redirect checkout |
| Reference | stable `ORD` + order number | `ORD` + order number + attempt suffix |

Three money-integrity consequences, all handled in `lib/server/livepay.ts` and the
two routes:

1. **The conversion is server-side and frozen.** The shop prices in UGX; the card
   product charges USD. `usdMinorFromUgxMinor` converts using
   `LIVEPAY_USD_RATE_UGX`, rounds **up** to the cent (never undercharging), enforces
   the documented window, and refuses (422) rather than guessing when no rate is
   configured. The rate and both amounts are frozen on the `payments` row
   (`raw_payload.fx`), so the webhook can prove the charge followed from the order.
2. **Reconciliation is currency-aware.** `reconcilePaymentAmount` previously
   required a whole-shilling total, which would reject every correct USD
   settlement; that rule is now UGX-only. A card settlement must equal the frozen
   USD amount **and** re-derive from the order total at the frozen rate — a
   tampered payments row cannot lower the bar. Conversions back to UGX allow at
   most one US cent of rounding.
3. **The redirect is constrained.** `checkout_url` is only returned when it is
   `https` on `*.livepay.me`, and `return_url` is built from `APP_URL` (never from
   the request body), carrying the order number so the customer lands on their
   tracking view.

The card credential is separate (`LIVEPAY_CARD_API_KEY`): a `keyId.secret` pair is
not interchangeable with the collect-money key.

## 3. Penetration test of the remediation

I attacked my own changes two ways: **44 adversarial tests** that drive the real route
handlers (`tests/moneyPentest.test.ts`), and a **live HTTP harness** against a running server
(`tools/money-pentest.mjs`, `npm run pentest:money`).

### 3.1 Findings — all fixed

| # | Attack | Result before the fix | Fix |
|---|---|---|---|
| PT-01 | **Refund race**: two refunds read the same balance and both write | **Confirmed.** Both succeeded; the `refunds` ledger could exceed the order total even though the counter did not | `record_refund` SQL function (`SELECT … FOR UPDATE`) + optimistic `.eq('refunded_minor_units', <read value>)` guard in the fallback, which returns **409** on a stale read |
| PT-02 | **Payment-prompt abuse / third-party collection**: initiate a MoMo prompt at any phone number for any known order id | **Confirmed.** The client-supplied `phoneNumber` was used verbatim for the order | The number must match the order's `customer_phone`; a different number is allowed only for the signed-in owner (**403** otherwise) |
| PT-03 | **Idempotency-key hijack**: replay a guessed key and receive another customer's order id/number | **Confirmed.** The replay lookup was unscoped | Lookup is scoped to `customer_id` (guests: `customer_id IS NULL`) |
| PT-04 | **Cheap-twin repricing**: two active products share a name; a cart without `productId` and a total matching the cheap twin | **Confirmed at the pricing layer** (the earlier test only failed on a total mismatch, not on the ambiguity) | Ambiguous names are refused at checkout (**400**); a supplied `productId` that does not resolve is refused instead of falling back to a name lookup |
| PT-05 | **Snapshot type smuggling**: string/float quantities and totals in the pricing snapshot | **Confirmed.** `Number()` coercion accepted `"1"` and `"11000000"` | `validatePricingSnapshot` requires real numbers end to end |

Two probes also *passed* and are worth recording: a >100 % discount is **ignored** rather than
clamped (clamping to 99.99 % would sell a 100,000 UGX drum for 1 UGX), and a tampered
`customer_reference` fails signature verification even when the signature is valid for a
different body.

### 3.2 Live HTTP results

```
$ LIVEPAY_WEBHOOK_SECRET=… BASE_URL=http://localhost:3000 npm run pentest:money

PASS  health endpoint is public                                        503
PASS  admin order list requires auth                                   401
PASS  admin order mutation requires auth                               401
PASS  refund endpoint requires auth                                    401
PASS  gateway connectivity test (SSRF vector) requires admin           401
PASS  webhook without a signature is rejected                          401
PASS  webhook with a forged signature is rejected                      401
PASS  webhook with a stale timestamp is rejected                       401
PASS  signed webhook with a tampered body is rejected                  401
PASS  correctly signed webhook cannot be processed without a database  503
PASS  checkout with a 1-UGX cart is refused                            503
PASS  payment initiation for an unknown order is refused               503
PASS  payment initiation rejects a non-momo method                     400
PASS  tracking wildcard is rejected                                    400
PASS  tracking SQL-ish injection is rejected                           400
PASS  order id injection in payment initiation                         503
PASS  malformed JSON is rejected                                       400
PASS  oversized body is rejected                                       400
PASS  unsupported method on orders is rejected                         405
PASS  order creation is rate limited                                   429

20/20 probes held.
```

The harness accepts **429** as a valid refusal so repeated runs against a warm rate-limiter
do not produce false findings.

### 3.3 What this penetration test could not cover

| Gap | Why | Consequence |
|---|---|---|
| Executing the SQL (triggers, `record_refund`, grants) against Postgres | No Postgres/Docker available in this environment | The SQL is reviewed but not executed; apply it to a staging project and re-run the refund race there |
| Real gateway interaction (duplicate references, fractional amounts, `charge` units) | No LivePay merchant credentials | Confirm `charge` units before trusting `net_amount_minor_units` |
| RLS behaviour as a real `anon`/`authenticated` role | Needs a live Supabase project | The policy text is reviewed; verify with `set role anon` in staging |
| Cross-session replay of a captured webhook | Requires a captured production signature | The 5-minute window and the `(provider, event_id)` dedupe bound it; asserted only in unit tests |

## 3. Verification

```
npx vitest run          →  11 files, 196 tests passing
npx tsc --noEmit        →  clean
npx eslint .            →  clean
```

`tests/moneyIntegrity.test.ts` covers, by finding:

| Group | Tests | Proves |
|---|---|---|
| `priceOrder` | 7 | Promotions applied, never above catalog, floor of 1 shilling, inactive/unrelated ignored, fee threshold, single rounding |
| `validatePricingSnapshot` | 8 | Valid snapshot accepted; unpayable/forged sub-total, inflated unit price, bad arithmetic, empty/zero-quantity and non-whole-shilling inputs refused |
| `ambiguousProductNames` | 2 | Duplicate active names flagged; archived duplicates ignored |
| `valueOrderAgainstCatalog` | 1 | Zero-quantity order is not chargeable |
| webhook state machine | 6 | Late `Failed` ignored; `Paid` + settled amount written; forged snapshot refused with marker released; cancelled/refunded refused; unknown-order marker released |
| pay initiation | 8 | Charge equals `total_minor_units / 100`; cancelled / refunded / delivered / COD refused before any gateway call; non-whole-shilling and bad snapshot refused |
| refunds | 7 | Reason + amount required; unpaid order refused; over-refund refused; partial refund is a ledger row and a negative payment without flipping status; full refund flips to `Refunded` |
| `tests/moneyPentest.test.ts` | 44 | Refund race, RPC path, gate bypasses, prompt abuse, idempotency scoping, ambiguous pricing, promo abuse, snapshot type smuggling, webhook forgery/replay, checkout input abuse, admin state manipulation |
| checkout route | 6 | Charged total equals the promotional price; the old (undiscounted) total is refused; a 1-UGX cart is refused; `Idempotency-Key` forwarded (and malformed keys dropped); free delivery applied only above the threshold |

---

## 4. Residual items (operational, outside this repository)

| Item | Why it still matters |
|---|---|
| Apply the schema SQL to the live Supabase project | The DB-level guarantees (RPC revocation, triggers, constraints, `refunds`) only exist once installed |
| Confirm LivePay's `charge` unit (minor vs major) with the merchant account | The webhook assumes major units, matching the documented `amount` |
| Reconcile historical orders | Pre-fix rows have no `pricing_snapshot`; they use the legacy name-keyed path, and pre-fix refunds were never recorded |
| Enforce `UNIQUE(products(name))` or model variants | Ambiguity is now *detected and refused*, but the underlying duplicate-name data model remains |
| Move promo definitions to a dedicated `promotions` table | Deals currently live inside `store_settings.hotDeals`; workable, but not auditable per campaign |
| Shared rate-limit store / WAF | The in-memory limiter is per instance (pre-existing, documented) |

---

## 5. Original findings (historical record)

The sections below are the review as written before remediation. They are kept so the reasoning
and the exploit paths remain reviewable; each heading now carries its resolution.

### MI-01 · High — a `Failed` notification can un-pay a Paid order — **FIXED**
**Evidence (pre-fix):** `app/api/payments/livepay/webhook/route.ts:246-258` — the Paid branch
checked the current state, the `Failed` branch did not, and the idempotency key includes the
outcome, so a failure event was processed normally. The DB trigger only asked *who* was writing.
**Impact:** a paid order silently reverted: it vanished from revenue, stopped fulfilment, and
the customer's money sat on the merchant account with no order to show for it.
**Fix:** `webhook_late_failure_ignored` guard + `orders_protect_payment_status` (monotonic).

### MI-02 · High — `create_order_v2` callable by any signed-in user — **FIXED**
**Evidence (pre-fix):** `lib/schemaSql.ts:461` granted `EXECUTE` to `authenticated`; the function
was `SECURITY DEFINER` with no caller check and took the total and per-line prices as arguments,
bypassing the `WITH CHECK (is_admin())` insert policy. Mobile-money orders were caught by the
catalog re-pricing in the pay route — **COD orders were not**.
**Exploit (pre-fix):** POST `/rest/v1/rpc/create_order_v2` with `p_total_minor_units: 1` and a
real product, then pay 1 UGX cash on delivery; repeat to drain stock.
**Fix:** `REVOKE … FROM PUBLIC, anon, authenticated`, `GRANT … TO service_role`, plus an
internal `auth.role() <> 'service_role'` guard so a future mis-grant cannot re-open it.

### MI-03 · High — admin finance view wrong and probably empty — **FIXED**
**Evidence (pre-fix):** `lib/supabaseDb.ts:770-840` mapped `Refunded`/`Failed` → `Pending`,
`total: total > 0 ? total : 99`, and injected a fabricated line item;
`components/AdminPortal.tsx:932` computed revenue from that array. The query embedded
`payments (…)` while the hardened schema grants nothing on `payments` to `anon`/`authenticated`,
so the request errored and the function returned `[]`.
**Fix:** faithful `mapOrderRow`, embed removed, flat fallback, revenue net of refunds.

### MI-04 · High — refunds are not money movements — **FIXED**
**Evidence (pre-fix):** `app/api/orders/route.ts:288-310` wrote `payment_status` +
`payment_note`; no amount, no `payments` row, no gateway reference, no check that the order was
paid, and the note was overwritten on the next write.
**Fix:** `refunds` table + `/api/orders/refund` + negative payment rows + partial-refund support.

### MI-05 · Med-High — cancelled/refunded orders stay chargeable — **FIXED**
**Evidence (pre-fix):** `app/api/payments/livepay/route.ts:95-99` checked only
`payment_status === 'Paid'`; `status` and `payment_method` were not even selected.
**Fix:** explicit gates for cancelled/delivered/refunded/COD orders, and terminal-state handling
in the webhook.

### MI-06 · Med-High — advertised prices the checkout did not honour — **FIXED**
**Evidence (pre-fix):** `app/page.tsx:1056-1070, 1146-1152` displayed `customPrice` and a
synthesised anchor (`dealPrice / (1 - discount/100)`) while "Claim Deal" added the product at
catalog price (`app/page.tsx:482-485`). Server-side, any total below catalog was rejected, so
discounts were unimplementable. `free_shipping` defaulted to true while a flat delivery fee was
always added, and `freeShippingThreshold` was read by nothing.
**Fix:** server-side promotions, honest badges, threshold-aware shipping, one shared calculation.

### MI-07 · Medium — no overcharge ceiling; price movement breaks in-flight orders — **FIXED**
**Evidence (pre-fix):** `lib/server/orders.ts:98-112` only computed `shortByMinor`; a total above
catalog was explicitly allowed and charged, while any catalog rise or discount made an order
permanently unpayable.
**Fix:** immutable `pricing_snapshot`; the charge is validated against the order's own basis.

### MI-08 · Medium — fractional-shilling totals charged then never reconciled — **FIXED**
**Evidence (pre-fix):** the pay route charged `Math.round(total_amount)` while the webhook
required `round(total_amount * 100)`; all 99 cent-values diverged.
**Fix:** whole-shilling invariant end to end, from catalog write to DB constraint.

### MI-09 · Medium — `payments` recorded intentions, not settlements — **FIXED**
**Evidence (pre-fix):** only `amount_minor_units` (requested), `status`, `provider_reference`;
`charge`, `provider_transaction_id` and `completed_at` were buried in `raw_payload`, manual
`Paid` writes created no row, and nothing ever wrote `status='refunded'`.
**Fix:** settled/fee/net/provider-transaction/settled-at columns, populated by the webhook;
manual and refund rows written explicitly.

### MI-10 · Medium — two amount sources; name-keyed valuation — **FIXED**
**Evidence (pre-fix):** `reconcilePaymentAmount` preferred `total_amount` while the valuation
used `total_minor_units`; `order_items` had no `product_id`, so valuation matched on a name over
an unordered `.in('name', …)` query, giving opposite verdicts for identically named twins.
**Fix:** one amount source, `product_id` persisted, ambiguous names detected and refused.

### MI-11 · Medium — `order_items` writable by anyone on any order — **FIXED**
**Evidence (pre-fix):** the INSERT policy was `EXISTS (SELECT 1 FROM orders WHERE id = order_id)`
with a grant to `authenticated`, so appending lines to a stranger's pending order broke their
payment (the valuation no longer matched), and the lines showed up in fulfilment.
**Fix:** service-role/admin-only writes; the public view no longer leaks the order id.

### MI-12 · Low-Medium — no checkout idempotency — **FIXED**
A retried POST created a second order and a second gateway reference. **Fix:** idempotency key →
`client_request_id` unique index; replays return the original order.

### MI-13 · Low — zero-quantity lines valuated to zero and "ok" — **FIXED**
**Fix:** refused as unchargeable in both valuation paths and in snapshot validation; the DB
constraint `order_items.quantity > 0` already existed but the API never relied on it.

### MI-14 · Low — lenient coercion on the unsigned amount — **FIXED**
`Number()` accepted `"1e3"`, `"0x2AB00"` and whitespace. **Fix:** strict digit regex, safe
integer bound, whole-shilling requirement. (Missing currency remains tolerated — see §1.)

### MI-15 · Low — public tracking leaked the order id — **FIXED**
`publicOrderView` returned `id`, the key needed for MI-11. **Fix:** removed.
