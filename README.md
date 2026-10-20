# Drum Palace

E-commerce storefront for musical instruments & pro audio (Uganda, UGX), built with
**Next.js (App Router) + Supabase + LivePay** payments.

> This README was rewritten on 2026-09-30. The previous README described an
> unrelated Gemini/AI Studio applet and was inaccurate.

## Stack

- Next.js 16 (React 19, TypeScript), Tailwind CSS 4
- Supabase: Postgres (PostgREST), Auth, Storage
- LivePay (https://docs.livepay.me/) for Mobile Money collection (MTN/Airtel, UGX) and card collection (Visa/Mastercard, USD)

## Run locally

```bash
npm install
cp .env.example (every variable explained in `ENVIRONMENT.md`) .env.local   # then fill in real values
npm run dev                  # http://localhost:3000
```

Required environment variables (see `.env.example` for details):

| Variable | Purpose |
|---|---|
| `APP_URL` | Public base URL (gateway callbacks/redirects) |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser-safe Supabase config |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only.** Order writes, webhook processing, admin reads. Without it, checkout/webhooks fail closed (503). |
| `LIVEPAY_API_KEY` | Collect-money API key (`Authorization: Bearer <key>`). Server-only. |
| `LIVEPAY_MERCHANT_ID` | Your LivePay account number (e.g. `LP2305443309`) sent as `accountNumber` |
| `LIVEPAY_CARD_API_KEY` | Card-collection credential — the dot-separated `keyId.secret` pair. Unset ⇒ card checkout disabled. |
| `LIVEPAY_CARD_MERCHANT_ID` | Optional separate account number for the card product |
| `LIVEPAY_USD_RATE_UGX` | UGX per USD used to convert order totals for card checkout (**required** for cards; no default, because guessing an exchange rate would misprice every charge) |
| `LIVEPAY_SECRET_KEY` | Optional/legacy — not used by the documented LivePay API |
| `LIVEPAY_WEBHOOK_SECRET` | HMAC secret for webhook verification. **Webhook rejects all traffic without it.** |
| `LIVEPAY_API_URL` | Gateway base URL (default `https://livepay.me/api`; must be `*.livepay.me`) |
| `TRUSTED_PROXY_HOPS` | Number of trusted reverse proxies in front of the app (default `1`). Selects which `X-Forwarded-For` entry is used as the client IP for rate limiting. |

## Database setup

1. Create a Supabase project.
2. Open the app's Admin Portal → **Cloud Sync** → *Copy Complete SQL Schema*, or
   copy `DRUM_PALACE_COMPLETE_SCHEMA_SQL` from `lib/schemaSql.ts`.
3. Run it in the Supabase SQL editor. It is idempotent (safe to re-run) and installs:
   - tables + indexes,
   - **least-privilege RLS** (owner/admin scoping; `payments` and
     `payment_webhook_events` are service-role only),
   - `is_admin()` helper, role-column protection trigger,
   - `create_order_v2()` atomic order+items+stock-decrement function.
4. Create your admin user via normal signup, then **manually** set
   `UPDATE public.profiles SET role='admin' WHERE email='you@store.ug';`
   (signup can never self-assign admin).
5. Configure a Supabase backup/PITR schedule in the dashboard (not in this repo).

## Security model (what changed & why)

A production-readiness audit (see `AUDIT_REPORT.md`) found the app NOT READY.
The following is now enforced:

- **Payments fail closed.** Orders are created `Pending`. Nothing is ever marked
  `Paid` except by a webhook whose `X-Webhook-Signature` verifies (see scheme
  below). There is no simulated/test-mode success fallback; unconfigured
  gateway ⇒ HTTP 503. Item prices are re-read from the catalog server-side —
  client-submitted prices are ignored.
- **Amounts come from the database.** The pay endpoint reads the order's
  `total_minor_units`; client-supplied amounts are ignored.
- **All privileged routes require auth.** Admin routes verify the Supabase JWT
  (`auth.getUser`) AND `profiles.role = 'admin'` server-side. No client-supplied
  roles, no offline/passwordless fallbacks, no 4-char-password backdoor.
- **Least-privilege RLS.** anon can read the catalog and insert its own
  checkout/contact rows; everything else is owner- or admin-scoped. Storage
  `products` bucket is public-read, admin-write.
- **SSRF removed.** The gateway connectivity test is admin-only, uses server env
  credentials only, and only talks to `*.livepay.me`.
- **Rate limiting** in `proxy.ts` (per-IP sliding window; stricter for
  payments/orders/contact). In-memory per instance — put a shared store or WAF
  in front for hard global caps at high scale.
- **Security headers** (CSP, HSTS, X-Frame-Options DENY, nosniff, referrer
  policy) are set in `next.config.ts`.
- **Public order tracking** (`/api/orders?track=DP-XXXX-XXXX`) returns a
  PII-redacted view; no wildcards, no listing.
- **No secrets in the browser.** LivePay credentials are server env vars only.

## Money handling (see `MONEY_INTEGRITY_REVIEW.md`)

Every amount is an integer count of **minor units** (1 UGX = 100), and only whole
shillings are ever charged: UGX has no circulating subunit, so the amount charged,
stored and reconciled is the same integer. `lib/pricing.ts` is the single pricing
implementation — the storefront and the order API both call `priceOrder()`, so the
price a customer sees is the price they are charged.

- **Immutable pricing basis.** Checkout records `orders.pricing_snapshot` (per-line
  catalog and effective unit prices, discount, shipping, total). Payment start and
  the webhook validate the order against that snapshot, so a later catalog change
  can neither strand nor reprice a placed order.
- **Promotions are server-side.** Active deals in `store_settings.hotDeals` are
  applied by the server; a deal can only lower a price. There is no client-side
  anchor price — if no genuine "was" price is configured, none is shown.
- **Delivery** is 10,000 UGX unless the net subtotal (after discounts) reaches
  `store_settings.freeShippingThreshold` (default 500,000 UGX).
- **Idempotent checkout.** The client sends `Idempotency-Key`; the API stores it in
  `orders.client_request_id` (unique) and returns the original order on a replay,
  so a retry cannot create a second order or a second mobile-money prompt.
- **Monotonic payment state.** `Pending → Paid | Failed`, `Paid → Refunded`, and
  `Refunded` is terminal, enforced in the webhook and by a DB trigger. Amounts on a
  settled order are immutable.
- **Refunds are recorded.** `POST /api/orders/refund` (admin) requires amount and
  reason, writes a `refunds` row plus a negative `payments` row, and supports
  partial refunds. Revenue in the admin portal is paid minus refunded.
- **Settlements, not intentions.** `payments` stores requested *and* settled
  amounts, gateway fee, net, provider transaction id and settlement time.

> **Schema:** re-run the schema SQL after pulling these changes — it adds
> `refunds`, the settlement columns on `payments`, `product_id` on `order_items`,
> the pricing/idempotency/refund columns on `orders`, the money `CHECK`
> constraints, the payment-state triggers, and the service-role-only
> `create_order_v2`.

### Penetration test

```bash
npm run pentest:money
npm run pentest:auth            # against BASE_URL (default http://localhost:3000)
LIVEPAY_WEBHOOK_SECRET=… BASE_URL=https://staging.example.com npm run pentest:money
```

Probes unauthenticated admin/refund routes, webhook forgery and replay, tracking injection,
body limits, method tampering and rate limiting. The adversarial money tests run with the rest
of the suite (`tests/moneyPentest.test.ts`).

## Webhook integration (verified against docs.livepay.me, 2026-10-05)

- LivePay POSTs the terminal transaction state to `/api/payments/livepay/webhook`
  (register that URL in your LivePay dashboard). Must answer 200 within 10s;
  LivePay retries 3× at 30s intervals.
- Payload (no wrapper): `{ status, message, customer_reference,
  internal_reference, provider_transaction_id, msisdn, amount, currency,
  provider, charge, completed_at }` with `status` like `"Success"`.
- Signature: `X-Webhook-Signature: t=<unix-ts>,v=<hex>` where
  `v = hex(HMAC-SHA256(webhook_url + t + sorted_params, LIVEPAY_WEBHOOK_SECRET))`
  and `sorted_params` = the keys `customer_reference`, `internal_reference`,
  `status` sorted alphabetically, each rendered as key+value concatenated.
  Because the signed string includes the exact webhook URL, `APP_URL` must
  match the public URL you register with LivePay (the route also accepts a
  signature computed against the incoming request's own URL as a fallback).
- Order correlation: we send `reference = "ORD" + order_number`; the webhook
  echoes it as `customer_reference`.
- Defenses: amount/currency reconciled against the order before marking Paid
  (mismatch ⇒ not marked Paid, error logged) — this matters because LivePay's
  signature does **not** cover `amount`, so reconciliation is the only defence
  against a validly-signed notification carrying a tampered amount; replay
  window of 5 minutes on the `t` timestamp (a captured signature expires);
  idempotent per `(internal_reference, customer_reference, status)`; retries of
  failed processing are not lost; fails closed (503) when
  `LIVEPAY_WEBHOOK_SECRET` or the service role key is missing.
- Gateway notes: two documented products with different credentials —
  `collect-money` uses `Authorization: Bearer <LIVEPAY_API_KEY>` and
  `accountNumber` = `LIVEPAY_MERCHANT_ID`; `card-collection` uses
  `Authorization: Bearer <keyId>.<secret>` (`LIVEPAY_CARD_API_KEY`) and is
  **USD only**. References are unique per account, ≤30 chars, no spaces —
  retries with a live duplicate collect reference are recovered via
  `/transaction-status`; card attempts get a fresh per-attempt reference.
- Payment initiation payload (`POST {LIVEPAY_API_URL}/collect-money`, spec at
  docs.livepay.me/request-money):
  `{ accountNumber, phoneNumber, amount (integer UGX), currency: "UGX",
  reference, description }` — `reference` is `"ORD" + order_number`
  (≤ 30 chars, no spaces), amounts come from the DB order, never the client.
  Success response: `{ success, message, reference, internal_reference, network }`.
- Card initiation payload (`POST {LIVEPAY_API_URL}/card-collection`, spec at
  docs.livepay.me/card-collection):
  `{ accountNumber, amount (USD, 2 dp), currency: "USD", reference, email,
  description, return_url }`. The USD amount is derived server-side from the
  order's UGX total and `LIVEPAY_USD_RATE_UGX`, rounded **up** to the cent and
  checked against the documented `$1.00–$5,000.00` window. The rate used is
  frozen on the `payments` row (`raw_payload.fx`) so the webhook can verify the
  charge. Response: `{ success, checkout_url, reference, internal_reference }`;
  the browser is redirected to `checkout_url` (host allow-listed to
  `*.livepay.me`) and returns via `APP_URL?order=…&payment=card&checkout_id=…`,
  which opens the tracking view for that order.
- Ancillary documented endpoints used: `GET /check-balance?accountNumber=&currency=UGX`
  (both params required — powers the admin "Test Live Connection") and
  `GET /transaction-status?accountNumber=&currency=&reference=`
  (duplicate-reference recovery). `GET /transaction-history` is available for
  reconciliation if needed. LivePay rate-limits collect-money and query APIs at
  50 req / 15 min per merchant account; the pay route enforces a global
  45 req / 15 min bucket to stay under it.

## Schema alignment

The app ships the database schema it expects in `lib/schemaSql.ts`. Two tools keep code and
database honest:

```bash
npm run schema:check        # static: every column/RPC the code uses exists in the schema
npm run schema:verify-sql   # regenerate tools/verify-db.sql
```

`tools/verify-db.sql` is a runnable checklist for a LIVE database: paste it into the Supabase
SQL editor and every expected column, function, index and constraint reports `OK` or `MISSING`.

**Upgrading an existing database** (the live one is the older normalized design) takes:
`lib/schemaSql.ts` (additive tables/columns/RPCs), then
`supabase/migrations/20261020_finish_alignment.sql` (reviewed definitions of the constraints,
triggers, functions and the three missing tables), and optionally
`supabase/migrations/20261019_align_live_db.sql` if legacy `orders.status` rows need normalising.
`npm run schema:sql-lint` parses every migration with libpg_query before you paste it anywhere.
`npm run schema:live` diffs the code against the recorded live inventory. See
`SCHEMA_ALIGNMENT.md` §6.

## Scripts

```bash
npm run dev        # dev server on :3000
npm run build      # production build (type errors gate the build)
npm start          # serve production build
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm test           # vitest (webhook signatures, rate limit, order ids, validation)
npm run schema:check      # fail if code references a column the schema lacks
npm run pentest:money     # live HTTP money probes against BASE_URL
```

## Operations notes

- Health/readiness: `GET /api/health` (503 when the DB is unreachable/unconfigured).
- Structured JSON logs (`lib/server/logging.ts`) with PII masking; grep for
  `event` names like `order_created`, `webhook_rejected_bad_signature`,
  `livepay_gateway_error`.
- Webhook retries: duplicate `event_id`s are ignored (idempotent via
  `payment_webhook_events` unique constraint).
- Rollback: redeploy the previous build artifact; schema changes are additive
  and idempotent. Keep `SUPABASE_SERVICE_ROLE_KEY` out of the browser bundle.

## Launch requirements that cannot be fixed in application code

> A step-by-step go/no-go checklist lives in [`LAUNCH_READINESS.md`](LAUNCH_READINESS.md).

These need action outside this repository. They are listed here so they are not
silently forgotten.

- **Consider enabling Supabase's own auth rate limiting and/or hCaptcha.**
  Every credential-bearing auth call now goes through this app and is throttled
  server-side before any upstream request (see `lib/server/authThrottle.ts`):

  | Endpoint | Per account | Per IP |
  | --- | --- | --- |
  | `POST /api/auth/login` | 10 / 15 min | 30 / 15 min |
  | `POST /api/auth/password-reset` | 3 / 15 min | 5 / 15 min |
  | `POST /api/auth/register` | 1 / hour | 5 / hour |

  The browser no longer calls Supabase Auth with credentials at all, and the
  direct `signInWithPassword` / magic-link / confirmation-resend helpers have
  been deleted so the unthrottled path cannot be re-imported by accident.
  Defence in depth still helps: anyone holding the `NEXT_PUBLIC` anon key could
  call Supabase Auth directly and bypass these limits. Dashboard-level rate
  limiting or a captcha on the sign-in form would close that too.
- **Apply `lib/schemaSql.ts` to Supabase — this is now blocking.** The RLS
  policies and the `orders_force_pending` / `orders_protect_payment_status` /
  `order_items_require_pending_order` triggers exist only as text until run.
  Until they are applied, an anonymous PostgREST client can still insert an
  order marked `Paid`. The same script also revokes anon `INSERT` on
  `orders`/`order_items` and anon `EXECUTE` on `create_order_v2`, which is what
  closes the forged-order-total hole at the database level.
- **Set `SUPABASE_SERVICE_ROLE_KEY`.** Order creation now refuses to run without
  it (the anon fallback was the forge path). Payments, the webhook and the admin
  portal already required it.
- **Deploy `create_order_v2`.** It is the only path that decrements stock
  atomically and raises on oversell. The fallback insert path does a
  best-effort, non-atomic stock pre-check, so concurrent checkouts can still
  oversell until the function is deployed.
- **Set `TRUSTED_PROXY_HOPS`** to the number of reverse proxies in front of the
  app, otherwise `X-Forwarded-For` may be attributed to the wrong client.
- **Complete the CSP.** `script-src` still needs `'unsafe-inline'` because the
  Next.js App Router streams its RSC payload through inline `<script>` tags;
  removing it breaks hydration. Migrating to a nonce-based CSP is the real fix.
- **Rate limiting is per-process.** For hard global caps put a shared store
  (Upstash Redis) behind `lib/server/rateLimit.ts` or enforce limits at the
  CDN/WAF.
- **Run one real LivePay payment** end to end and confirm the webhook's amount
  reconciliation against a live payload — LivePay's signature does not cover
  `amount`, and the expected unit (major vs minor) has not been confirmed
  against a real gateway response.
