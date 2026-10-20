# Environment variables

Everything the running app reads from the environment, in one place. Source of
truth is `.env.example`; this file explains **what breaks without each one**.

There are **13 variables in total, 5 of them required** (plus `NODE_ENV`, which Next.js sets itself). Nothing else is read —
`grep -rho "process\.env\.[A-Z0-9_]*" lib app proxy.ts` is the authoritative list.

---

## 1. Required — the app does not work without these

| Variable | Example | What it does | If it is missing |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://abcdefgh.supabase.co` | Supabase project URL, used by both the browser client and every server client | The whole app runs "offline": no catalog, no auth, checkout 503 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJhbGciOi...` | Public key for the browser and for unprivileged server reads | Same as above. This key is public by design; RLS is what protects the data |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGciOi...` (roles: `service_role`) | The privileged server client that bypasses RLS | **Checkout, refunds, the webhook and the admin API all return 503.** Fail-closed by design — never put this behind `NEXT_PUBLIC_` |
| `APP_URL` | `https://drumpalace.ug` | The public origin: gateway `return_url`, the allowed redirect origin for card checkout, and the webhook-signature candidate host | Card payments redirect to a dead URL, and webhook signature verification can fail to match |
| `LIVEPAY_WEBHOOK_SECRET` | `whsec_...` from the LivePay dashboard | HMAC key for verifying webhook deliveries | The webhook **rejects all traffic**, so no order ever becomes `paid` while customers are still charged |

`NEXT_PUBLIC_*` is compiled into the browser bundle at build time — changing it
requires a rebuild, not just a restart. Everything else is read at runtime.

---

## 2. Required for Mobile Money

| Variable | Example | Notes |
|---|---|---|
| `LIVEPAY_API_KEY` | `lp_live_...` | The collect-money key, sent as `Authorization: Bearer <key>`. Note: **not** the dotted `keyId.secret` pair |
| `LIVEPAY_MERCHANT_ID` | `LP2305443309` | Your LivePay `accountNumber`. A key that does not own this account gets a 403 |

Without these two, `/api/payments/livepay` returns 503 and MoMo checkout cannot
start — but Cash on Delivery still works.

---

## 3. Required for card payments (skip if MoMo + COD only)

| Variable | Example | Notes |
|---|---|---|
| `LIVEPAY_CARD_API_KEY` | `ck_live_9f3a.8b1c4d2e6f7a9051` | The **whole dotted pair** as one value. A space, or the secret half alone, produces a 401 |
| `LIVEPAY_USD_RATE_UGX` | `3800` | UGX per 1 USD. LivePay's card product is USD-only, so a UGX order total is converted at this rate. With no positive rate, card checkout answers **422** rather than guessing |
| `LIVEPAY_CARD_MERCHANT_ID` | `LP2305443309` | Optional; falls back to `LIVEPAY_MERCHANT_ID` |

---

## 4. Optional — sensible defaults

| Variable | Default | When to change it |
|---|---|---|
| `LIVEPAY_API_URL` | `https://livepay.me/api` | Only if LivePay moves. It is validated: it must be a `livepay.me` host, so it cannot be pointed at an attacker |
| `TRUSTED_PROXY_HOPS` | `1` | **Check this against your host.** It is how many proxies sit in front of the app. Wrong value = the client IP is taken from a header an attacker controls, which makes every per-IP rate limit spoofable |

`NODE_ENV` is set by Next.js itself; do not set it by hand.

---

## 5. Not used

| Variable | Why |
|---|---|
| `LIVEPAY_SECRET_KEY` | The documented LivePay API has no such credential. The webhook HMAC uses `LIVEPAY_WEBHOOK_SECRET`. It appears in `.env.example` only so old deployments do not break |

---

## 6. Copy-paste templates

**Minimum viable (Cash on Delivery only — the safe launch):**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://yourproject.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="eyJhbGciOi..."
SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOi..."
APP_URL="https://your-domain.com"
TRUSTED_PROXY_HOPS="1"
```

**Mobile Money added:**

```bash
LIVEPAY_API_KEY="your-collect-money-key"
LIVEPAY_MERCHANT_ID="LP2305443309"
LIVEPAY_WEBHOOK_SECRET="whsec_from_dashboard"
```

**Cards added:**

```bash
LIVEPAY_CARD_API_KEY="keyId.secret"
LIVEPAY_USD_RATE_UGX="3800"
```

---

## 7. Verify, don't assume

After setting them, hit the health endpoint:

```bash
curl -s https://your-domain.com/api/health
```

Expected with everything wired:

```json
{
  "status": "ok",
  "checks": {
    "supabaseConfigured": true,
    "serviceRoleConfigured": true,
    "database": "ok"
  }
}
```

* `supabaseConfigured: false` → the two `NEXT_PUBLIC_*` values are missing, are
  still placeholders, or the URL is not `https://`.
* `serviceRoleConfigured: false` → checkout will 503. Fix before launch.
* `status: "degraded"` / HTTP 503 → the database is unreachable, or the schema is
  missing tables the app reads.

The admin portal also has a LivePay **Test connection** button, which checks the
key and account number against the gateway without moving money.

Two traps worth knowing:

1. Values containing `placeholder` or `YOUR_` are treated as **unset**. Copying
   `.env.example` verbatim fails loudly instead of half-working — that is
   intentional.
2. A key set in the host's dashboard but **not** applied to the running
   deployment looks exactly like a missing key. Redeploy after changing env vars
   on most platforms.
