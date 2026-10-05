/**
 * LivePay webhook signature verification — implemented against the OFFICIAL
 * documentation (https://docs.livepay.me/webhooks, retrieved 2026-10-05).
 *
 * Wire format:
 *   Header:  X-Webhook-Signature: t=<unix-timestamp>,v=<hex hmac>
 *   String:  webhook_url + timestamp + sorted_params
 *   where sorted_params = the keys {customer_reference, internal_reference,
 *   status} sorted alphabetically, each rendered as key+value concatenated
 *   directly (no separators).
 *   HMAC:    hex(HMAC-SHA256(string, LIVEPAY_WEBHOOK_SECRET))
 *
 * Verified payload shape (no event wrapper):
 *   { status, message, customer_reference, internal_reference,
 *     provider_transaction_id, msisdn, amount, currency, provider, charge,
 *     completed_at }
 */
import { createHmac, timingSafeEqual } from 'crypto';

export function getWebhookSecret(): string | null {
  const secret = process.env.LIVEPAY_WEBHOOK_SECRET;
  if (!secret || secret.includes('YOUR_')) return null;
  return secret;
}

export interface ParsedSignature {
  timestamp: string;
  signature: string; // hex
}

/** Parse "t=...,v=..." — returns null when malformed. */
export function parseSignatureHeader(header: string | null): ParsedSignature | null {
  if (!header) return null;
  const parts = header.split(',').map((s) => s.trim());
  let timestamp = '';
  let signature = '';
  for (const part of parts) {
    if (part.startsWith('t=')) timestamp = part.slice(2);
    else if (part.startsWith('v=')) signature = part.slice(2);
  }
  if (!/^\d{1,20}$/.test(timestamp)) return null;
  if (!/^[a-fA-F0-9]{64}$/.test(signature)) return null;
  return { timestamp, signature: signature.toLowerCase() };
}

/**
 * Build the exact string-to-sign defined by LivePay's docs.
 * Missing payload values are treated as empty strings (defensive).
 */
export function buildSignatureString(
  webhookUrl: string,
  timestamp: string,
  payload: { customer_reference?: unknown; internal_reference?: unknown; status?: unknown }
): string {
  const params: Record<string, string> = {
    customer_reference: payload.customer_reference == null ? '' : String(payload.customer_reference),
    internal_reference: payload.internal_reference == null ? '' : String(payload.internal_reference),
    status: payload.status == null ? '' : String(payload.status),
  };
  let out = webhookUrl + timestamp;
  for (const key of Object.keys(params).sort()) {
    out += key + params[key];
  }
  return out;
}

export function signString(stringToSign: string, secret: string): string {
  return createHmac('sha256', secret).update(stringToSign, 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Default tolerance for the signature timestamp. LivePay documents 3 retries at
 * 30s intervals, so 5 minutes covers normal redelivery while still making a
 * captured signature unusable after it expires.
 */
export const DEFAULT_SIGNATURE_MAX_AGE_SECONDS = 300;

/**
 * Verify a LivePay webhook. Fails closed on any missing input.
 *
 * `candidateWebhookUrls` contains every plausible exact URL the gateway may
 * have used when signing (the signature binds the URL string). We accept a
 * match against any candidate — candidates are always our own endpoint under
 * our own host, derived from APP_URL and/or the incoming request.
 *
 * `maxAgeSeconds` enforces a replay window on the header's `t` value; it
 * defaults to DEFAULT_SIGNATURE_MAX_AGE_SECONDS and must be explicitly set to
 * null to disable (only appropriate in tests of the signing scheme itself).
 * `nowSeconds` is injectable so freshness is testable without waiting.
 */
export function verifyLivePayWebhook(opts: {
  payload: any;
  header: string | null;
  candidateWebhookUrls: string[];
  secret: string | null;
  maxAgeSeconds?: number | null;
  nowSeconds?: number;
}): boolean {
  const { payload, header, candidateWebhookUrls, secret } = opts;
  const maxAgeSeconds = opts.maxAgeSeconds === undefined ? DEFAULT_SIGNATURE_MAX_AGE_SECONDS : opts.maxAgeSeconds;
  if (!secret) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (!payload || typeof payload !== 'object') return false;

  // Replay protection: the header timestamp must be recent. Without this a
  // captured signature stays valid forever (the (provider, event_id) unique
  // constraint only de-duplicates, it does not authenticate freshness).
  if (maxAgeSeconds !== null) {
    const timestampSeconds = Number(parsed.timestamp);
    if (!Number.isFinite(timestampSeconds)) return false;
    const nowSeconds = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - timestampSeconds) > maxAgeSeconds) return false;
  }

  for (const url of candidateWebhookUrls) {
    if (!url) continue;
    const stringToSign = buildSignatureString(url, parsed.timestamp, payload);
    const expected = signString(stringToSign, secret);
    if (safeEqualHex(expected, parsed.signature)) return true;
  }
  return false;
}

/** Test/utility helper mirroring LivePay's docs examples. */
export function signLivePayWebhook(opts: {
  webhookUrl: string;
  timestamp: string;
  payload: { customer_reference?: unknown; internal_reference?: unknown; status?: unknown };
  secret: string;
}): string {
  return signString(buildSignatureString(opts.webhookUrl, opts.timestamp, opts.payload), opts.secret);
}

/** Derive the webhook URL candidates from the incoming request + APP_URL. */
export function webhookUrlCandidates(req: Request): string[] {
  const candidates = new Set<string>();
  try {
    const u = new URL(req.url);
    const proto = req.headers.get('x-forwarded-proto') || u.protocol.replace(':', '');
    const host = req.headers.get('host') || u.host;
    candidates.add(`${proto}://${host}${u.pathname}`);
  } catch {
    // ignore
  }
  const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (appUrl) candidates.add(`${appUrl}/api/payments/livepay/webhook`);
  return [...candidates];
}
