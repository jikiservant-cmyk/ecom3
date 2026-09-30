# Drum Palace

E-commerce storefront for musical instruments & pro audio (Uganda, UGX), built with
**Next.js (App Router) + Supabase + LivePay** payments.

> This README was rewritten on 2026-09-30. The previous README described an
> unrelated Gemini/AI Studio applet and was inaccurate.

## Stack

- Next.js 16 (React 19, TypeScript), Tailwind CSS 4
- Supabase: Postgres (PostgREST), Auth, Storage
- LivePay (https://docs.livepay.me/) for mobile money / card collection

## Run locally

```bash
npm install
cp .env.example .env.local   # then fill in real values
npm run dev                  # http://localhost:3000
```

Required environment variables (see `.env.example` for details):

| Variable | Purpose |
|---|---|
| `APP_URL` | Public base URL (gateway callbacks/redirects) |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser-safe Supabase config |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only.** Order writes, webhook processing, admin reads. Without it, checkout/webhooks fail closed (503). |
| `LIVEPAY_API_KEY`, `LIVEPAY_SECRET_KEY`, `LIVEPAY_MERCHANT_ID` | LivePay gateway credentials (server-only) |
| `LIVEPAY_WEBHOOK_SECRET` | HMAC secret for webhook verification. **Webhook rejects all traffic without it.** |
| `LIVEPAY_API_URL` | Gateway base URL (default `https://livepay.me/api`; must be `*.livepay.me`) |

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
  `Paid` except by a webhook whose `x-livepay-signature`
  (`hex(HMAC-SHA256(rawBody, LIVEPAY_WEBHOOK_SECRET))`) verifies. There is no
  simulated/test-mode success fallback; unconfigured gateway ⇒ HTTP 503.
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

## Webhook signature scheme

`x-livepay-signature: hex(HMAC-SHA256(rawRequestBody, LIVEPAY_WEBHOOK_SECRET))`
(a `t=...,v1=<hex>` envelope is also accepted).

**UNVERIFIED:** LivePay's own documentation could not be reached from the audit
environment. If their scheme differs, only `lib/server/webhook.ts` needs to
change — verification is fail-closed either way.

## Scripts

```bash
npm run dev        # dev server on :3000
npm run build      # production build (type errors gate the build)
npm start          # serve production build
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm test           # vitest (webhook signatures, rate limit, order ids, validation)
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
