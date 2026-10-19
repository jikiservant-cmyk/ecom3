# Launch readiness — can we take customers tomorrow?

**Verdict: not yet, but it is close. The code is ready; the deployment is not.**

Everything testable in this repository passes. What is missing is everything that
lives outside the repository: the database schema has never been applied, no real
payment has been run through the gateway, and there is no monitoring. Those are
not "nice to have" — each one fails visibly on day one.

Rule of thumb: **do not open the store until sections 1–3 are all ticked.** Section
4 is the list of risks you accept knowingly if you launch anyway.

---

## 0. Launching tomorrow? Run this list, in this order

Roughly four focused hours, and the order matters — several steps check the one
before it.

| # | Step | Time | Done when |
|---|---|---|---|
| 1 | Supabase backup, then confirm you can see it restorable | 15 min | Backup listed with today's timestamp |
| 2 | `lib/schemaSql.ts` → then `supabase/migrations/20261020_finish_alignment.sql` (B1). Run **sections 0–8 and 10–11**, stop before section 9 | 45 min | Migration's checklist all `OK`, `bad_rows` 0 |
| 3 | Set the env vars on the host: `SUPABASE_SERVICE_ROLE_KEY`, `LIVEPAY_API_KEY`, `LIVEPAY_MERCHANT_ID`, `LIVEPAY_WEBHOOK_SECRET`, `APP_URL`, `TRUSTED_PROXY_HOPS` | 30 min | `/api/health` → 200 with `serviceRoleConfigured: true` |
| 4 | Deploy the app (B1a) | 30 min | Storefront loads; admin can sign in |
| 5 | Run migration **section 9** (tighten policies) | 5 min | Admin status button still works — proves the new `PATCH /api/orders` path |
| 6 | Seed the catalog, all products `active` (B8) | 30 min | Products appear with prices |
| 7 | Register the webhook URL in the LivePay dashboard (B6) | 10 min | Dashboard shows `https://<domain>/api/payments/livepay/webhook` |
| 8 | Real-money smoke test, section 2: one MoMo order, one decline, one refund, one stock exhaustion | 45 min | Each behaves as listed |
| 9 | Uptime check on `/api/health` + alert to your phone (M1) | 20 min | Kill the DB URL in a preview env → you get an alert |
| 10 | Admin portal, section 1a: provision your admin row, sign in, change a status, upload a photo, refund | 30 min | Each row of A1–A7 behaves |

**If you cannot finish the webhook steps (7–8), launch Cash on Delivery only.**
COD needs no gateway, no webhook and no secret: the order is written `pending`,
the customer pays on delivery, and you mark it `paid` from the admin portal
(audited, ledger row created). That is a genuinely safe store for tomorrow. Turn
Mobile Money on the day the signed webhook test passes — a half-configured
gateway is worse than none, because the customer pays and nothing turns green.

---

## 1. Blocking — the store cannot take a real payment without these

| # | Item | Why it blocks | How to check |
|---|---|---|---|
| B1 | Apply `lib/schemaSql.ts` **then** `supabase/migrations/20261020_finish_alignment.sql` (the additive part and the webhook unique key are already applied; this supplies the functions, triggers, constraints, missing tables **and the tightened policies**) | No RLS enforcement, no triggers, no `create_order_v2`, no `record_refund`, and the browser can still write `orders` with the public anon key | `tools/verify-db.sql` → every row `OK`, and the migration's `bad_rows` all 0 |
| B1a | Deploy the application **before** the policy-tightening section runs | That section revokes browser writes on `orders`/`order_items`; the old admin dashboard wrote `orders.status` directly from the browser | Admin status buttons work after the deploy (they call `PATCH /api/orders`) |
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

## 1a. The admin portal

The portal is how you will run the store, so it gets its own list. Authentication
is the part that is already sound: sign-in goes through a throttled server route,
the role is read from `public.profiles` with the user's own JWT, every privileged
route re-checks it, and the old "offline fallback" that accepted any admin profile
plus a 4-character password is deleted.

| # | Item | Why it matters | How to check |
|---|---|---|---|
| A1 | **Install the profile triggers** (`handle_new_user`, `protect_profile_role` — migration §7e/§7f) | Without them: a signed-in customer can PATCH their own `profiles.role` to `admin` and walk into the portal, and a new sign-up has no profile row at all, so that customer cannot check out | The migration's verify query shows both triggers `OK` and "auth users without a profile row" `OK` |
| A2 | Provision your own admin row | Nothing mints an admin automatically. The trigger intentionally blocks role changes from a browser session | In the SQL editor: `UPDATE public.profiles SET role = 'admin' WHERE email = 'you@example.com';` → verify row says "at least one admin exists" `OK` |
| A3 | Sign in to the portal on production | Proves A1+A2 and the session plumbing | You land on the dashboard, not the sign-in screen |
| A4 | Change an order's status from the portal | That write now goes through `PATCH /api/orders` (admin-authorised, audit-logged). It is the one admin action whose implementation changed today | Move an order `processing` → `shipped`; the toast says it worked and the row updates |
| A5 | Upload a product photo | The bucket policies are admin-only (migration §9b). A public-insert bucket is how storage gets abused | Add a photo to a product, then open the storefront and see it |
| A6 | Save and delete a product | The portal writes the catalog from the browser with your JWT, which the `is_admin()` policies allow | Create a product, edit its price, delete it |
| A7 | Issue a refund on a paid order | Requires amount + reason; writes `refunds`, a negative `payments` row and `refunded_minor_units` | The order shows `refunded`, and the refund appears in the ledger |

Known papercuts, not blockers:

* **The portal writes the catalog directly to Supabase, not through
  `POST /api/products`.** That route exists and is admin-gated, but it calls a
  helper bound to the anon key, so under strict RLS it would be refused. Use the
  portal UI; route catalog writes through the API after launch if you want their
  audit trail.
* **The portal has no view of the `payments` ledger.** Revenue is computed from
  orders (paid minus refunded), which is the correct customer-facing figure.
  Reconciliation against LivePay is done in their dashboard.
* **`profiles` is readable by any admin**, including other customers' emails.
  That is the intended admin capability; do not grant `admin` casually.

---

## 2. Blocking — prove it once, by hand, before opening

Do these on the **production** deployment, with a real phone and a real card. Do
not skip because the tests are green: the tests use a fake database and a fake
gateway. These are the only checks that exercise the real thing.

- [ ] **MoMo**: place a small order → prompt arrives → approve → order becomes
      `paid`/`processing` within a minute. Confirm the webhook delivery in the
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
settlements rather than intents, and 253 tests plus 19 live probes cover the
attack surface. But **none of it has ever run against your real database or your
real LivePay account**, and the schema that makes it safe is still text in a
file. Apply the schema, set the six environment variables, run one real payment
per method, and put an uptime check on `/api/health` — section 0 above is that
work, itemised, roughly half a day. Do that and yes, it is fit to take customers. Skip it and the most likely
day-one failure is silent: customers pay, and the orders never turn Paid.
