# Production-Readiness Audit — Drum Palace (`ecom3`)

> ## Remediation status (2026-09-30, same branch)
> **All Critical blockers and the High items below have been fixed and
> re-verified live** (see commit history on `arena/01a0f40a-ecom3`), including
> two follow-up rounds: (a) launch-blocker fixes (server-side catalog
> re-pricing, checkout shipping-total fix, open-redirect guard, XFF spoofing
> fix, legacy RLS cleanup, admin payment reconciliation), and (b) a full
> LivePay re-integration implemented against the OFFICIAL docs
> (docs.livepay.me, retrieved 2026-10-05): real `X-Webhook-Signature`
> t=…,v=… scheme with URL-bound signing string, real payload shape
> (customer_reference/internal_reference/amount), amount reconciliation,
> retry-safe idempotency, momo-only (no undocumented card endpoint),
> `/check-balance` connection test, duplicate-reference recovery via
> `/transaction-status`.
> SSRF/secret exfiltration removed; authn/authz on every route; hardened RLS
> schema (`lib/schemaSql.ts`); payments fail closed with DB-sourced amounts;
> mandatory HMAC webhook verification + idempotency; orders created Pending;
> offline login & admin backdoor removed; role escalation killed; Next.js
> upgraded to 16.3.8 (`npm audit` now **0 vulnerabilities**); storage bucket
> admin-write only; PII-redacted public tracking; rate limiting, security
> headers, `/api/health`, structured logging, vitest suite (21 tests), hermetic
> build. Post-fix attack re-run: SSRF→401, forged webhook→503, payment→503
> (no simulated success), data routes→401, rate limiter→429. Remaining work is
> the Medium/Low non-blocking list plus the operational items in §4
> (Supabase project hardening verification, LivePay docs confirmation, CI,
> load testing, backups).
> The original audit findings are preserved below for reference.


**Date:** 2026-09-30 · **Branch:** `arena/01a0f40a-ecom3` @ `35ab887`
**Project:** "Drum Palace" e-commerce storefront (Uganda, UGX)
**Stack:** Next.js 16.3.8 (App Router, React 19, TypeScript) + Supabase (Postgres/PostgREST, Auth, Storage) + LivePay payment gateway (Mobile Money only — MTN/Airtel, UGX; per docs.livepay.me)
**Assumed load:** ~10k DAU (from audit template; no load target is documented anywhere in the repo)
**AI-agent addendum:** Not applicable. The app contains no LLM/agent functionality. (The dead `@google/genai` dependency originally noted in N-11 has since been removed from `package.json`; N-11 is retained below as a historical record of that finding.)

---

## 1. Verdict: **NOT READY**

This application has no functioning payment assurance — orders are written directly from the browser into the database as `payment_status: 'Paid'` before any money moves, and the checkout UI ignores the payment gateway's response entirely. Every API route is unauthenticated, and the SQL schema the app instructs operators to install grants anonymous full read/write on all tables (orders, payments, profiles), so all customer PII and financial records are publicly exfiltrable with the anon key. On top of that, an unauthenticated endpoint was demonstrated live to leak the server-side payment API key to an attacker-controlled URL (SSRF), the installed Next.js version carries a critical npm-audit RCE, and there are zero tests, zero CI, and zero observability.

---

## 2. Blockers (must fix before launch)

### B-01 · Critical · Security — SSRF + server-secret exfiltration via `test-connection` (LIVE-VERIFIED)
- **Evidence:** `app/api/payments/livepay/test-connection/route.ts:6-13, 33-44`. `apiUrl` comes from the request body; `apiKey` falls back to `process.env.LIVEPAY_API_KEY`. No auth.
- **Verification:** Started dev server with `LIVEPAY_API_KEY=sk_live_SUPERSECRET_AUDIT_KEY`, POSTed `{"apiUrl":"http://127.0.0.1:9999"}`. My listener captured:
  ```
  Authorization: Bearer sk_live_SUPERSECRET_AUDIT_KEY
  X-API-KEY: sk_live_SUPERSECRET_AUDIT_KEY
  ```
- **Impact:** Any anonymous visitor can make the server issue arbitrary HTTP requests (SSRF into cloud metadata/internal services) and steal the LivePay API key by pointing `apiUrl` at their own host. Full payment-account compromise.
- **Fix:** Delete the endpoint or require authenticated admin session; hard-code/allowlist the gateway base URL (never accept it from the client); never fall back to server secrets when client-supplied credentials are absent.

### B-02 · Critical · Security — Zero authentication/authorization on all API routes (LIVE-VERIFIED)
- **Evidence:** `app/api/orders/route.ts` (GET dumps all orders, PATCH updates any order), `app/api/contact/route.ts` (GET dumps all messages), `app/api/products/route.ts` (POST creates/seeds products), `app/api/reviews/route.ts`, `app/api/categories/route.ts`, both payment routes. None read a session, token, or role.
- **Verification:** Unauthenticated `curl` against every route returned 200/processed payloads (TEST 4–8 in audit run).
- **Impact:** Anonymous order-status tampering, catalog poisoning, PII scraping, spam.
- **Fix:** Put all mutating/admin reads behind Supabase Auth JWT verification in Next route handlers (e.g., `middleware.ts` + per-route `getUser()` checks); scope GET `/api/orders` to the caller's own orders; admin-only routes must check `profiles.role = 'admin'` server-side.

### B-03 · Critical · Security — Shipped SQL schema disables RLS in practice (anon full access)
- **Evidence:** `lib/supabase.ts` (schema string, ~line 509-513): `GRANT ALL ON ALL TABLES ... TO anon, authenticated`; policies like `"Public read orders" FOR SELECT USING (true)`, `"Admin manage orders" FOR ALL USING (true)`, `"Public read/write store_settings" FOR ALL USING (true)`, `"Public read profiles" FOR SELECT USING (true)`, same for `payments`, `reviews`, `wishlists`, `products`.
- **Impact:** With the anon key (which is public by definition), anyone can query `https://<project>.supabase.co/rest/v1/orders?select=*` and exfiltrate every order, payment reference, and user profile — or rewrite products/settings/prices. RLS is enabled but every policy is `USING (true)`.
- **Fix:** Rewrite policies: public read only for `products/categories/reviews`; orders writable by owner only (`auth.uid() = customer_id`), readable by owner; admin writes behind a verified `is_admin()` function; revoke `GRANT ALL ... TO anon`.

### B-04 · Critical · Security/Fraud — Orders marked PAID before payment; gateway result ignored
- **Evidence:** `lib/supabaseDb.ts` `createOrderInDb` (~line 570-650): inserts order with `payment_status: 'Paid'`, `status: 'Processing'` and a `payments` row with `status: 'paid'` unconditionally. `app/page.tsx:724-758`: client calls this directly from the browser, then `fetch('/api/payments/livepay')` whose response is **never read or checked**; even the `catch` block shows "Order saved in system — thank you".
- **Impact:** Anyone gets goods marked paid without paying; no amount or currency enforcement; direct DB writes from browser rely only on the broken RLS (B-03).
- **Fix:** Server-side order creation only (route handler), `payment_status: 'Pending'`; create the LivePay session server-side and redirect; mark paid **only** from a verified webhook (B-05); recompute totals server-side from catalog prices.

### B-05 · Critical · Security — Webhook signature never verified (forgery trivial) (LIVE-VERIFIED)
- **Evidence:** `app/api/payments/livepay/webhook/route.ts:7-15`: if a secret is configured it only checks the signature header is *present* — no HMAC computation/comparison; if no secret is configured, nothing is checked.
- **Verification:** Unauthenticated `POST` with a forged `{"data":{"order_id":...,"status":"successful"}}` returned `{"received":true,...,"status":"processed"}`.
- **Impact:** Attackers can mark arbitrary orders paid/unpaid. Combined with `GET /api/orders` leaking all order UUIDs, targeting is trivial.
- **Fix:** Require `LIVEPAY_WEBHOOK_SECRET`; compute the documented HMAC over the raw body and compare with `timingSafeEqual`; reject otherwise. Add idempotency (`payment_webhook_events.event_id` unique + upsert) — currently duplicate events re-process.

### B-06 · Critical · Security — Payment endpoint falls through to fake "successful" responses (LIVE-VERIFIED)
- **Evidence:** `app/api/payments/livepay/route.ts:118-131` and catch at ~line 108: any fetch exception (or missing/placeholder key) returns `status: 'successful'` from "Simulated / Test Mode". `amount` is client-supplied with no cross-check against the order total.
- **Verification:** With a *live* key configured, a gateway failure still returned `{"success":true,...,"status":"successful","gateway":"LivePay Uganda (Simulated / Test Mode)"}`.
- **Impact:** Transient gateway/network errors silently become "paid"; in any misconfigured deploy, every checkout is free. Client-controlled `amount` enables 1-UGX purchases.
- **Fix:** Remove the simulated-success fallthrough entirely (fail closed); validate amount server-side against the stored order; never return success without a gateway confirmation or verified webhook.

### B-07 · Critical · Security — Self-service privilege escalation to admin
- **Evidence:** `lib/supabaseAuth.ts:31-70` `signUpWithEmail(..., role)` puts client-supplied `role` into user metadata; schema trigger `handle_new_user()` (lib/supabase.ts, `SECURITY DEFINER`) copies `raw_user_meta_data->>'role'` straight into `profiles.role`. Anyone can call `supabase.auth.signUp` with `{data:{role:'admin'}}` using the public anon key. `lib/supabaseDb.ts:updateUserProfileInDb` also accepts `role` updates with no guard, and profiles are publicly writable per B-03.
- **Impact:** Trivial admin takeover of the store.
- **Fix:** Trigger must hard-code `'customer'`; admin role assignable only via a server-side, authenticated admin operation (or manually in DB); never accept `role` from client input.

### B-08 · Critical · Security — Passwordless "offline" login fallback + 4-char admin backdoor
- **Evidence:** `app/page.tsx:548-585`: if Supabase isn't configured, login matches a profile **by email only — no password** — and grants that profile's role (admin included). `components/AdminPortal.tsx:305-335`: admin fallback accepts any profile whose role is admin with any password `length >= 4`.
- **Impact:** With permissive RLS (B-03) the profile list is public, so an attacker knows admin emails and can sign in as admin from the UI. Even without Supabase configured, the store is fully administrable by anyone.
- **Fix:** Remove the offline auth fallback entirely; admin access must require a verified Supabase session with `role='admin'` checked server-side.

### B-09 · Critical · Dependencies — installed Next.js flagged CRITICAL by npm audit (plus 7 high)
- **Evidence (real output):** `npm audit`: `next | critical | 9.3.4-canary.0 - 16.3.0-preview.10 | Next.js: Unauthenticated Remote Code Execution on windows-hosted servers ;; Next.js: Unauthenticated Remote Code Execution in Image Optimization API when AVIF files are used` (GHSA-p293-qw3h-jr36, GHSA-2xp9-vwfh-vxw4). Installed: `next@15.5.23`. Also high: `sharp` (libvips CVE-2026-33327/-33328, CVE-2026-35590/-35591), `postcss` (arbitrary file read via sourceMappingURL), `undici` (multiple DoS/cache issues), `fast-uri` (SSRF), `@grpc/grpc-js`, `js-yaml`. Totals: **21 vulns (13 moderate, 7 high, 1 critical)**.
- **Impact:** The AVIF image-optimizer RCE applies to Linux deployments using `next/image` optimization (this app uses it via `next.config.ts` remotePatterns).
- **Fix:** Upgrade Next.js to a patched release (and run `npm audit fix`), pin via lockfile, add `npm audit --audit-level=high` as a CI gate.

### B-10 · High · Security — Anonymous write/delete on public storage bucket
- **Evidence:** schema SQL in `lib/supabase.ts` (tail): `CREATE POLICY "Public insert products bucket" ... FOR INSERT`, plus `FOR UPDATE` and `FOR DELETE` on `storage.objects` for bucket `products`.
- **Impact:** Anyone can overwrite or delete every product image (defacement, phishing/malware imagery served from your domain).
- **Fix:** Anon read-only; writes only for authenticated admin (or server-side service-role uploads).

### B-11 · High · Compliance/PII — Unauthenticated mass PII exposure
- **Evidence:** `GET /api/orders` returns all customer names, emails, phones, addresses, payment provider references (`lib/supabaseDb.ts:getOrdersFromDb`); `GET /api/contact` returns all contact messages; profiles table publicly readable (B-03). Live-verified that both endpoints serve without auth.
- **Impact:** GDPR/data-protection breach material; Uganda Data Protection Act exposure.
- **Fix:** Auth + row scoping (see B-02/B-03), minimize fields returned, purge PII from `payments.raw_payload`.

### B-12 · High · Data integrity — No transactions, swallowed partial failures, non-idempotent webhook
- **Evidence:** `createOrderInDb` performs 3 separate inserts (orders → order_items → payments); item/payment failures are caught and logged with `console.warn` while still returning `success: true`. Webhook does 3 independent updates with no transaction and no dedupe on `event_id` (no unique constraint in schema).
- **Impact:** Orders without items, payments without orders, double-processed webhooks; impossible to reconcile money.
- **Fix:** Use a Postgres function/RPC executed atomically, or Supabase transactions; unique `event_id` + `ON CONFLICT DO NOTHING`.

### B-13 · High · Security/Reliability — No rate limiting anywhere
- **Evidence:** No middleware (`find middleware*` → none), no rate-limit code in any route; Supabase calls are unbounded from client too.
- **Impact:** Brute force of login, order spam, mass PII scraping, cost runaway on Supabase billing.
- **Fix:** Edge middleware or upstream (WAF/CDN) rate limits per IP+route; Supabase Auth rate limits confirmed (see Unverified).

---

## 3. Non-blocking issues (sorted by severity)

### High
- **N-01 · Reliability — No timeouts/retries on outbound HTTP.** All `fetch` calls (LivePay, test-connection, Supabase via SDK defaults) lack `AbortController` timeouts (`grep AbortController` → only a comment at `lib/supabaseDb.ts:433`). A hung gateway pins serverless functions. Fix: 5–10s timeouts, 1 retry w/ backoff for idempotent calls, circuit-break the gateway.
- **N-02 · Data/Perf — No indexes, no pagination, full-table loads.** Schema SQL claims "with RLS and Indexes" (`lib/supabase.ts:340`) but contains **0** `CREATE INDEX`. `getOrdersFromDb`/`getProductsFromDb`/`getProfilesFromDb` fetch entire tables; `getOrderByIdOrNumber` falls back to fetching **all** orders and scanning in JS (`lib/supabaseDb.ts:~1110`); `ilike.%term%` wildcard enables enumeration. At 10k DAU this dies quickly. Fix: indexes on `orders(order_number)`, `orders(customer_id)`, `order_items(order_id)`, `payments(order_id)`, `reviews(product_id)`; cursor pagination everywhere.
- **N-03 · Deployment — No CI/CD, no IaC, no Dockerfile, no rollback path.** No `.github/`, no pipeline, no deploy config; deployment appears to be Google AI Studio Cloud Run (`metadata.json`, README) but nothing is codified. Build is also network-dependent: `next/font/google` fetches fonts at build time — production build **failed in this audit environment** with `ECONNRESET` to `fonts.googleapis.com` (see Unverified). Fix: GitHub Actions (lint→typecheck→audit→build→deploy), self-host fonts or pre-fetch, document rollback.
- **N-04 · Observability — Effectively none.** Logging is `console.log/warn/error` only; no structured logging, no request IDs, no `/health` or readiness endpoint, no metrics/tracing/alerting. API handlers echo raw `err.message` to clients (e.g. `app/api/orders/route.ts:19-24`) leaking internals. A 3am incident is undebuggable. Fix: pino/structured logs, health endpoint, Sentry/APM, alert on webhook failures & payment errors.
- **N-05 · Testing — Zero tests.** No test files, no runner (`jest`/`vitest`/Playwright absent from `package.json`), no `test` script. Critical money paths (order creation, webhook, auth) are entirely untested. Fix: integration tests for the payment state machine first.

### Medium
- **N-06 · Data — Guessable, colliding order numbers.** `orderNumber = DP-${Math.floor(100000 + Math.random()*900000)}` (`lib/supabaseDb.ts:~570`), non-crypto RNG, 900k space, `UNIQUE(order_number)`: birthday-collision probability reaches ~1% near ~190 orders and ~50% near ~1,100 orders → hard checkout failures. Also enumerable by attackers. Fix: sequence or crypto-random base32, longer codes.
- **N-07 · Data — Inventory never decremented; broken cart sync.** `inventory_quantity` hardcoded to 50 on every product save (`lib/supabaseDb.ts:499,511`) and never reduced on order. `syncCartWithDb` writes to `carts`/`cart_items` tables that **don't exist in the schema SQL** and omits any product id in `cart_items` payload (`lib/supabaseDb.ts:~1160-1195`). Fix: real stock decrement in the order transaction; fix or delete cart sync.
- **N-08 · Security — Payment secrets typed into browser localStorage.** AdminPortal stores `dp_livepay_api_key`, `dp_livepay_secret_key`, `dp_livepay_webhook_secret` in `localStorage` (`components/AdminPortal.tsx:~140-175, 838-848`) and POSTs them from the browser. Any XSS or shared device leaks merchant funds. Fix: secrets server-side only (env/secret manager).
- **N-09 · Security — No security headers, no middleware.** `next.config.ts` sets none (no CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy). Fix: `headers()` config or middleware.
- **N-10 · Compliance — No retention/deletion/GDPR flows.** Orders, contact messages, reviews (with emails) retained forever; no account/data deletion path; terms checkbox value never recorded (`app/page.tsx` register handler). Fix: retention policy + deletion endpoints + consent audit trail.
- **N-11 · Code quality — Dead deps & misleading docs.** `@google/genai`, `@hookform/resolvers`, and `firebase-tools` (heavy CLI, devDep) are never imported (grep-verified). README describes a Gemini AI Studio app and `GEMINI_API_KEY`; `metadata.json` claims `MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API` — none of it matches reality. `temp_products.json` committed containing a real API dump incl. Supabase project ref `zvqjqynnwfdepqusmjjb` (also hardcoded in `next.config.ts:45`). Fix: remove deps/files, rewrite README as an operator runbook.
- **N-12 · Maintainability — God-files + type-safety bypassed.** `app/page.tsx` (2,703 lines), `components/AdminPortal.tsx` (3,245 lines), `lib/supabaseDb.ts` (1,264 lines). Every Supabase call is cast `as any`, defeating `lib/database.types.ts`, which itself is stale vs the schema SQL (e.g. `profiles` type lacks `email`; `PaymentStatus` uses `'success'` while orders CHECK constraint uses `'Paid'/'paid'`). Fix: split, regenerate types, remove casts.

### Low
- **N-13 · `eslint.ignoreDuringBuilds: true`** (`next.config.ts:6`) — lint never gates a build (lint currently passes clean, but the escape hatch hides future regressions).
- **N-14 · `formatMoney` currency heuristic** (`lib/utils.ts:10`): any amount `< 10000` is silently multiplied by 3,750 — any future sub-unit or USD-denominated amount displays wildly wrong.
- **N-15 · Webhook key mismatch:** webhook updates `orders.id`/`payments.order_id` (UUIDs) with `data.order_id || data.reference`, but the checkout sends reference `ORD{orderNumber}` — legitimate gateway callbacks match nothing unless they carry the UUID. Verify against LivePay docs and map correctly.
- **N-16 · No `engines` field** in `package.json`; Node version unpinned for deploys.
- **N-17 · Colliding timestamp IDs:** `contact_messages.id = msg_${Date.now()}` (`lib/supabaseDb.ts:~733`) collides under concurrency (PK insert failure → lost messages).
- **N-18 · Static hardcoded FX rates** (`lib/currency.ts`: `1/3750` etc.) — pricing drift and misrepresentation risk.
- **N-19 · `ensureValidUuid` hash-folding** (`lib/supabaseDb.ts:75-100`) maps arbitrary IDs into UUID space; deterministic collisions possible across distinct legacy IDs.

---

## 4. Unverified items

| Item | What I'd need |
|---|---|
| Whether Supabase project `zvqjqynnwfdepqusmjjb.supabase.co` actually has the permissive schema applied, backups/PITR enabled, or Auth rate limits configured | Supabase dashboard access |
| LivePay API contract (signature scheme, webhook field names, `collect-money` semantics) — livepay.me unreachable from this sandbox | LivePay docs/merchant account |
| Production build success in a network-permitted environment | `next/font/google` fetch failed here (`ECONNRESET`/`SSL_ERROR_SYSCALL` to `fonts.googleapis.com`, verified with curl); retry in CI-equivalent env |
| Behavior under load (p95 latency, Supabase connection behavior) | Load test rig; nothing exists in-repo |
| Actual deployment target/hardening (Cloud Run config, WAF, secrets injection) | AI Studio/Cloud Run console |
| Full license scan | Only manual review done: all direct deps are MIT/Apache/ISC/BSD (no copyleft seen), but no scanner was run |
| Whether real customer data already exists in the live DB (would make B-03/B-11 an active incident) | DB access |

---

## 5. Coverage report

| # | Category | Depth | What was inspected |
|---|---|---|---|
| 1 | Security | **Thorough** | All 7 route handlers, auth lib, RLS schema, storage policies, webhook, SSRF live-tested, secrets scan of code + full git history (single commit; only placeholders found), CORS/CSRF posture, dependency CVEs via `npm audit` |
| 2 | Reliability | **Thorough** | Error handling in every route/lib, timeouts/retries (absent), transaction use (absent), failure fallthroughs (payments), idempotency, graceful shutdown (none app-level) |
| 3 | Data | **Thorough** | Full schema SQL in `lib/supabase.ts`, migration mechanism (copy-paste UI string; no tooling, no down-migrations), indexes (none), pagination (none), transactions (none), integrity constraints, order-number collisions, cart/table mismatches |
| 4 | Scalability/Perf | **Moderate** | Full-table query patterns, N/A on connection pooling (managed by Supabase SDK/serverless), no caching layer, no load-test evidence; no runtime profiling performed |
| 5 | Observability | **Thorough** | Grepped all logging/metrics/health endpoints; error pages (`app/error.tsx`, `global-error.tsx`) reviewed; API error propagation reviewed |
| 6 | Testing | **Thorough** | Searched for test files/runners/config — none exist; `package.json` scripts reviewed |
| 7 | Deployment/Infra | **Thorough** | Searched for CI/IaC/Docker/config — none exist; `next.config.ts`, scripts, `.env.example`, `metadata.json` reviewed; build attempted (failed on sandboxed font fetch) |
| 8 | Code quality | **Thorough** | TODO/FIXME grep (none), dead deps verified by import grep, file-size/coupling review, README accuracy check |
| 9 | Dependencies/Licensing | **Moderate** | `npm audit` (21 vulns), lockfile present & consistent, version ranges reviewed, manual license check; no automated license scanner |
| 10 | Compliance/Ops | **Moderate** | PII flows mapped (orders/contact/profiles/payments raw payload), retention/deletion (absent), consent recording (absent); no incident plan/SLOs/on-call artifacts exist anywhere in repo |

**Tool outputs:** `tsc --noEmit` → clean (exit 0). `eslint .` → clean (exit 0, but bypassed in builds via config). `npm run build` → **failed** (network-blocked Google Fonts in sandbox). `npm audit` → 21 vulnerabilities (1 critical, 7 high, 13 moderate).

---

## 6. Prioritized fix plan

| # | Action | Fixes | Effort |
|---|---|---|---|
| 1 | Rewrite RLS policies + grants (owner/admin scoping, revoke anon ALL), restrict storage bucket to anon-read | B-03, B-10, B-11 | M |
| 2 | Move order creation/payment fully server-side: pending status, server-priced totals, pay via gateway session, mark paid only on verified webhook; delete simulated fallthrough | B-04, B-06, B-05, N-15 | L |
| 3 | Implement real webhook HMAC verification + `event_id` idempotency; wrap order writes in a DB transaction/RPC | B-05, B-12 | M |
| 4 | Authn/authz pass: session checks in all route handlers + middleware; remove offline login fallback and 4-char admin path; hard-code `role='customer'` in trigger; server-side admin role management | B-02, B-07, B-08, B-13 | L |
| 5 | Delete/lock down `test-connection` (kill SSRF + secret fallback); stop storing gateway secrets in browser localStorage | B-01, N-08 | S |
| 6 | Upgrade Next.js past critical CVEs + `npm audit fix`, add audit gate | B-09 | S |
| 7 | Add rate limiting (middleware/CDN) on auth, checkout, webhooks, contact | B-13 | S |
| 8 | Add indexes + pagination to all list endpoints; fix order-number generation | N-02, N-06 | M |
| 9 | CI pipeline: typecheck, lint (remove `ignoreDuringBuilds`), audit, build, tests; self-host fonts to make builds hermetic | N-03, N-13 | M |
| 10 | Tests for payment state machine, authz, webhook forgery; load test checkout | N-05 | L |
| 11 | Observability: structured logs, `/health`, Sentry, payment-failure alerts; stop echoing raw errors | N-04 | M |
| 12 | Fix inventory decrement + cart schema; GDPR retention/deletion; security headers; remove dead deps & `temp_products.json`; rewrite README/runbook | N-07, N-09, N-10, N-11 | M |
| 13 | Decompose god-files, regenerate DB types, drop `as any`, fix `formatMoney` heuristic & FX rates | N-12, N-14, N-18 | L |
