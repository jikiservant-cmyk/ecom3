/**
 * LivePay gateway primitives — implemented against the official documentation:
 *
 *   Collect Money  https://docs.livepay.me/request-money
 *   Card Collection https://docs.livepay.me/card-collection
 *   Webhooks       https://docs.livepay.me/webhooks
 *
 * Two different products with two different contracts:
 *
 * ┌──────────────────┬─────────────────────────────┬──────────────────────────────┐
 * │                  │ Collect Money               │ Card Collection              │
 * ├──────────────────┼─────────────────────────────┼──────────────────────────────┤
 * │ Endpoint         │ POST /api/collect-money     │ POST /api/card-collection    │
 * │ Auth             │ Bearer <API key>            │ Bearer <keyId>.<secret>      │
 * │ Currency         │ any (UGX needs no network)  │ USD only                     │
 * │ Amount bounds    │ per account (min/max)       │ $1.00 – $5,000.00            │
 * │ Async result     │ prompt approved on handset  │ hosted redirect checkout     │
 * │ Success payload  │ internal_reference, network │ checkout_url, reference      │
 * │ Rate limit       │ 50 / 15 min                 │ 500 / 15 min                 │
 * └──────────────────┴─────────────────────────────┴──────────────────────────────┘
 *
 * Everything here is pure and testable; the route handlers own the I/O.
 */

/** Hosts LivePay documents for its API. SSRF guard: never call anything else. */
const LIVEPAY_HOST = /(^|\.)livepay\.me$/;

export const COLLECT_PATH = '/collect-money';
export const CARD_PATH = '/card-collection';

/** Documented card bounds, in minor units (US cents). */
export const CARD_MIN_MINOR = 100; // $1.00
export const CARD_MAX_MINOR = 500_000; // $5,000.00

/** Documented rate limits: 50 / 15 min (collect), 500 / 15 min (card). */
export const COLLECT_RATE_LIMIT = 50;
export const CARD_RATE_LIMIT = 500;
export const RATE_LIMIT_WINDOW_MS = 15 * 60_000;

export interface GatewayConfig {
  apiKey: string;
  accountNumber: string;
  baseUrl: string;
}

function isConfiguredKey(value: string | undefined): value is string {
  return Boolean(value) && !String(value).includes('YOUR_');
}

function readBaseUrl(): string | null {
  const raw = (process.env.LIVEPAY_API_URL || 'https://livepay.me/api').replace(/\/+$/, '');
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (!LIVEPAY_HOST.test(url.hostname)) return null; // SSRF guard
    return raw;
  } catch {
    return null;
  }
}

/**
 * Collect Money credentials. The docs show a single API key used directly as
 * the bearer token.
 *
 * `LIVEPAY_MERCHANT_ID` is the `accountNumber`; LivePay rejects a request whose
 * accountNumber is not owned by the key (403), so both are required.
 */
export function getCollectConfig(): GatewayConfig | null {
  const apiKey = process.env.LIVEPAY_API_KEY;
  if (!isConfiguredKey(apiKey)) return null;
  const accountNumber = process.env.LIVEPAY_MERCHANT_ID || '';
  if (!accountNumber) return null;
  const baseUrl = readBaseUrl();
  if (!baseUrl) return null;
  return { apiKey, accountNumber, baseUrl };
}

/**
 * Card credentials. The card API documents a `keyId.secret` bearer token, which
 * is NOT interchangeable with the Collect Money key. Prefer a dedicated
 * `LIVEPAY_CARD_API_KEY`; fall back to the general key so a merchant whose
 * single key happens to be the dotted pair still works.
 */
export function getCardConfig(): GatewayConfig | null {
  const apiKey = process.env.LIVEPAY_CARD_API_KEY || process.env.LIVEPAY_API_KEY;
  if (!isConfiguredKey(apiKey)) return null;
  const accountNumber = process.env.LIVEPAY_CARD_MERCHANT_ID || process.env.LIVEPAY_MERCHANT_ID || '';
  if (!accountNumber) return null;
  const baseUrl = readBaseUrl();
  if (!baseUrl) return null;
  return { apiKey, accountNumber, baseUrl };
}

/**
 * Reference rule from both docs: unique per account, no spaces, max 30 chars.
 * We additionally restrict to the URL-safe alphabet LivePay's examples use, so
 * an order number can never smuggle a control character or a space into the
 * signature/reference field.
 */
export function sanitiseReference(raw: string, maxLength = 30): string {
  return String(raw ?? '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, maxLength);
}

/** MTN/Airtel collection reference: stable, so a retry recovers the same txn. */
export function buildCollectReference(orderNumber: string): string {
  const base = String(orderNumber ?? '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitiseReference(`ORD${base}`, 30).toUpperCase();
}

/**
 * Card reference. Card checkout is a redirect: a retried attempt must be a NEW
 * reference (LivePay rejects a reused one), so a short attempt nonce is added.
 * The order is still recoverable because the webhook resolves orders by this
 * exact `payments.provider_reference` first, and the base reference is a prefix.
 */
export function buildCardReference(orderNumber: string, nonce: string): string {
  const base = sanitiseReference(`ORD${orderNumber}`, 17);
  const suffix = sanitiseReference(nonce, 10).toUpperCase();
  return sanitiseReference(`${base}-${suffix}`, 30);
}

/**
 * Recover the shop order number from a gateway reference.
 *
 * Accepts the stable collect reference (`ORDDP-8FK3-QM2Z`) and the per-attempt
 * card reference (`ORDDP-8FK3-QM2Z-AB12CD`). The strict DP-shaped pattern is
 * tried first so an attempt suffix is stripped rather than treated as part of
 * the order number; the loose pattern keeps older references working.
 */
export function orderNumberFromReference(reference: string): string | null {
  const ref = String(reference || '').trim().toUpperCase();
  const strict = /^ORD(DP-[A-Z0-9]{4}-[A-Z0-9]{4})(?:-[A-Z0-9]{1,12})?$/.exec(ref);
  if (strict) return strict[1];
  const legacy = /^ORD([A-Z0-9-]{4,27})$/.exec(ref);
  return legacy ? legacy[1] : null;
}

/** @deprecated kept for callers written against the momo-only flow. */
export const orderNumberFromCollectReference = orderNumberFromReference;

/**
 * UGX minor units → USD minor units (cents), per the documented card flow.
 *
 * Rounding is UP (ceil), never down: converting a UGX total into USD must never
 * undercharge. The maximum overcharge is one US cent. Returns null when the rate
 * is unusable or the amount falls outside LivePay's $1–$5,000 window, so the
 * caller can refuse rather than send an invalid or loss-making charge.
 */
export function usdMinorFromUgxMinor(ugxMinor: number, rateUgxPerUsd: number): number | null {
  if (!Number.isSafeInteger(ugxMinor) || ugxMinor <= 0) return null;
  if (!Number.isFinite(rateUgxPerUsd) || rateUgxPerUsd <= 0) return null;
  const usdMajor = ugxMinor / 100 / rateUgxPerUsd;
  if (!Number.isFinite(usdMajor) || usdMajor <= 0) return null;
  // Nudge before ceil so float noise on an exact cent does not add a cent. The
  // epsilon is relative: at $5,000 the float error is ~1e-7 cents, far larger
  // than a fixed 1e-9 would absorb.
  const rawCents = usdMajor * 100;
  const epsilon = Math.max(1e-9, rawCents * 1e-12);
  const cents = Math.ceil(rawCents - epsilon);
  if (!Number.isSafeInteger(cents)) return null;
  if (cents < CARD_MIN_MINOR || cents > CARD_MAX_MINOR) return null;
  return cents;
}

/** Inverse, used to express a card settlement back in shop currency. */
export function ugxMinorFromUsdMinor(usdMinor: number, rateUgxPerUsd: number): number | null {
  if (!Number.isSafeInteger(usdMinor) || usdMinor < 0) return null;
  if (!Number.isFinite(rateUgxPerUsd) || rateUgxPerUsd <= 0) return null;
  return Math.round((usdMinor / 100) * rateUgxPerUsd * 100);
}

/**
 * Float tolerance when converting a settled USD amount back to UGX for
 * valuation. One US cent is the documented rounding granularity of the card
 * product; anything larger is a real underpayment and must still fail.
 */
export function cardRoundTripToleranceMinor(rateUgxPerUsd: number): number {
  const perCent = Number.isFinite(rateUgxPerUsd) && rateUgxPerUsd > 0 ? rateUgxPerUsd : 0;
  return Math.ceil(perCent); // 1 US cent expressed in UGX minor units
}

/**
 * A `checkout_url` is handed straight to the browser, so it is an open-redirect
 * sink if we trust it blindly. Only LivePay's own hosts may be returned.
 */
export function isTrustedCheckoutUrl(candidate: unknown): candidate is string {
  if (typeof candidate !== 'string' || !candidate) return false;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && LIVEPAY_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Build the post-payment landing URL from OUR OWN configured origin — never
 * from the request body. LivePay appends `?checkout_id=` to whatever we send,
 * so the query must already carry `order` for the tracking view to auto-open.
 */
export function buildCardReturnUrl(appUrl: string, orderNumber: string): string | null {
  if (!appUrl) return null;
  try {
    const base = new URL(appUrl);
    base.searchParams.set('order', orderNumber);
    base.searchParams.set('payment', 'card');
    return base.toString();
  } catch {
    return null;
  }
}
