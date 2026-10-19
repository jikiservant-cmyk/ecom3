# Launch readiness — can we take customers tomorrow?

**Verdict: not yet, but it is close. The code is ready; the deployment is not.**

Everything testable in this repository passes. What is missing is everything that
lives outside the repository: the database schema has never been applied, no real
payment has been run through the gateway, and there is no monitoring. Those are
not "nice to have" — each one fails visibly on day one.

Rule of thumb: **do not open the store until sections 1–3 are all ticked.** Section
4 is the list of risks you accept knowingly if you launch anyway.

---

## 1. Blocking — the store cannot take a real payment without these

| # | Item | Why it blocks | How to check |
|---|---|---|---|
| B1 | Apply `lib/schemaSql.ts` **then** `supabase/migrations/20261020_finish_alignment.sql` (the additive part is already applied; this supplies the functions, triggers, constraints and missing tables) | No RLS, no triggers, no `create_order_v2`, no `record_refund`, and the `orders_payment_method_valid` constraint does not exist, so **card orders fail at insert** | `tools/verify-db.sql` → every row `OK`, and the migration's `bad_rows` all 0 |
| B2 | `SUPABASE_SERVICE_ROLE_KEY` set in the host | Checkout, webhook, refunds and admin all return 503 without it (fail-closed by design) | `GET /api/health` shows `serviceRoleConfigured: true` |
| B3 | `LIVEPAY_API_KEY` + `LIVEPAY_MERCHANT_ID` | MoMo checkout cannot start | `/api/payments/livepay` → not 503 |
| B4 | `LIVEPAY_WEBHOOK_SECRET` | The webhook rejects all traffic, so **no order ever becomes Paid** | A signed test delivery returns 200 |
| B5 | `APP_URL` = the real public https URL | Return URLs and webhook signature candidates are derived from it | Card return lands back on your domain |
| B6 | Webhook URL registered in the LivePay dashboard | Otherwise payments complete at the gateway and the order stays Pending forever | Dashboard shows the URL; gateway shows deliveries |
| B7 | `TRUSTED_PROXY_HOPS` set to your host's proxy count | Wrong value misattributes client IPs, weakening every rate limit | Logs show real client IPs |
| B8 | Catalog seeded and `active` | An empty `products` table means an empty store and every checkout refusing | Storefront lists products |

**Card only** (skip if you launch MoMo + COD):

| # | Item | Why |
|---|---|---|
| B9 | `LIVEPAY_CARD_API_KEY` (`keyId.secret`) | Card calls are 503 without it |
| B10 | `LIVEPAY_USD_RATE_UGX` set to today's rate | Card checkout answers 422 by design rather than guessing a rate |

---

## 2. Blocking — prove it once, by hand, before opening

Do these on the **production** deployment, with a real phone and a real card. Do
not skip because the tests are green: the tests use a fake database and a fake
gateway. These are the only checks that exercise the real thing.

- [ ] **MoMo**: place a small order → prompt arrives → approve → order becomes
      `Paid`/`Processing` within a minute. Confirm the webhook delivery in the
      LivePay dashboard.
- [ ] **Declined MoMo**: cancel the prompt → order goes `Failed`, not `Paid`.
- [ ] **Card**: place a small order → redirected to LivePay → pay $1 → returned to
      the tracking view → order `Paid`. Note the USD amount charged and the
      recorded `payments.amount_minor_units`.
- [ ] **Refund**: refund a paid order from the admin portal → `refunds` row +
      negative `payments` row + `refunded_minor_units` updated.
- [ ] **Stock**: buy the last unit of something → the next checkout refuses.
- [ ] **Tracking**: `?order=DP-XXXX-XXXX` shows status, no PII.

If any of these fail, stop. Everything else in this repo depends on them working.

---

## 3. Blocking — you must be able to see failure

| # | Item | Minimum |
|---|---|---|
| M1 | Uptime check on `GET /api/health` every minute, alerting to your phone | 503 = database unreachable |
| M2 | Log drain / log search for the app | Ability to grep `webhook_rejected_*`, `livepay_gateway_error`, `refund_*` on the day |
| M3 | Alert on `webhook_amount_mismatch` and `webhook_rejected_bad_signature` | These mean money moved but an order did not update |
| M4 | Supabase backups confirmed (daily, restorable) | Know the restore procedure |
| M5 | Who is on call, and how a refund is issued at 21:00 | One named person |

Without M1–M3 you will learn about a broken webhook from an angry customer, not
from an alert — and a silent webhook failure means **money collected, order never
marked Paid**.

---

## 4. Known risks you accept by launching

| Risk | Impact | Mitigation |
|---|---|---|
| Rate limiting is **in-memory per process** | On a multi-instance/serverless host the limits are best-effort, not a hard cap. A burst can exhaust LivePay's 50/15min quota | Put a shared limiter (Upstash) or WAF limits in front; the app already fails closed at 45 |
| **Over-sell** if `create_order_v2` is missing | Two simultaneous checkouts can both take the last unit | B1 covers it; the RPC is the atomic path |
| LivePay's `charge` semantics for **USD card** are unverified | Recorded gateway fee may be off; net revenue slightly wrong | Check the first few settlements in the dashboard; adjust by hand |
| Order tracking is a **capability URL** (order number) | Anyone holding a number sees items/status (no PII) | Acceptable; numbers are 32⁸ random |
| CSP still needs `'unsafe-inline'` | Weaker XSS defence than ideal | Nonce-based CSP later; not a launch blocker |
| No load test | Unknown behaviour at 50+ concurrent checkouts | Watch the first hour; quota guard is the backstop |
| Foreign currency display | Prices are UGX; display conversion is cosmetic only | Charges are always UGX (or USD via card) |

---

## 5. The honest one-paragraph answer

Money handling is now in good shape: pricing is recomputed server-side, totals are
reconciled against a verified webhook, refunds are atomic, the ledger records
settlements rather than intents, and 227 tests plus 21 live probes cover the
attack surface. But **none of it has ever run against your real database or your
real LivePay account**, and the schema that makes it safe is still text in a
file. Apply the schema, set the six environment variables, run one real payment
per method, and put an uptime check on `/api/health` — that is roughly half a day
of work. Do that and yes, it is fit to take customers. Skip it and the most likely
day-one failure is silent: customers pay, and the orders never turn Paid.
