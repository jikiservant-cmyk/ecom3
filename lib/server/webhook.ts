/**
 * Webhook signature verification for the LivePay webhook endpoint.
 *
 * Scheme (documented in README; verify against LivePay docs before go-live):
 *   x-livepay-signature: hex(HMAC-SHA256(rawRequestBody, LIVEPAY_WEBHOOK_SECRET))
 * A `t=<unix>,v1=<hex>` envelope is also tolerated for gateways that send one.
 *
 * UNVERIFIED: LivePay's exact scheme could not be confirmed from this environment.
 * If their docs differ, only this file needs to change — the route fails closed
 * either way (no secret configured => reject).
 */
import { createHmac, timingSafeEqual } from 'crypto';

export function getWebhookSecret(): string | null {
  const secret = process.env.LIVEPAY_WEBHOOK_SECRET;
  if (!secret || secret.includes('YOUR_')) return null;
  return secret;
}

function computeSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify the webhook signature. Returns true only for a valid signature.
 * Fails closed: missing secret, missing header, or malformed value => false.
 */
export function verifyLivePaySignature(rawBody: string, signatureHeader: string | null, secret: string | null): boolean {
  if (!secret) return false;
  if (!signatureHeader) return false;

  let provided = signatureHeader.trim();
  // Tolerate "t=...,v1=..." envelopes.
  if (provided.includes('v1=')) {
    const part = provided.split(',').map((s) => s.trim()).find((s) => s.startsWith('v1='));
    if (!part) return false;
    provided = part.slice(3);
  }
  if (!/^[a-fA-F0-9]{64}$/.test(provided)) return false;

  const expected = computeSignature(rawBody, secret);
  return safeEqualHex(expected.toLowerCase(), provided.toLowerCase());
}

/** Test/utility helper for generating signatures (used by tests and operators). */
export function signLivePayPayload(rawBody: string, secret: string): string {
  return computeSignature(rawBody, secret);
}
