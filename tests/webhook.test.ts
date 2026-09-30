import { describe, it, expect } from 'vitest';
import { verifyLivePaySignature, signLivePayPayload, getWebhookSecret } from '@/lib/server/webhook';

describe('LivePay webhook signature verification', () => {
  const secret = 'whsec_test_secret_123';
  const body = JSON.stringify({ event: 'payment.success', data: { order_id: 'abc', status: 'successful' } });

  it('accepts a valid hex signature', () => {
    const sig = signLivePayPayload(body, secret);
    expect(verifyLivePaySignature(body, sig, secret)).toBe(true);
  });

  it('accepts a t=...,v1=... envelope', () => {
    const sig = signLivePayPayload(body, secret);
    expect(verifyLivePaySignature(body, `t=1700000000,v1=${sig}`, secret)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = signLivePayPayload(body, secret);
    const tampered = body.replace('successful', 'failed');
    expect(verifyLivePaySignature(tampered, sig, secret)).toBe(false);
  });

  it('rejects a wrong signature', () => {
    const wrong = 'a'.repeat(64);
    expect(verifyLivePaySignature(body, wrong, secret)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyLivePaySignature(body, null, secret)).toBe(false);
  });

  it('rejects a non-hex signature', () => {
    expect(verifyLivePaySignature(body, 'zz'.repeat(32), secret)).toBe(false);
  });

  it('fails closed when no secret is configured', () => {
    const sig = signLivePayPayload(body, secret);
    expect(verifyLivePaySignature(body, sig, null)).toBe(false);
  });

  it('rejects when using a different secret', () => {
    const sig = signLivePayPayload(body, 'other_secret');
    expect(verifyLivePaySignature(body, sig, secret)).toBe(false);
  });

  it('getWebhookSecret returns null for placeholder or unset values', () => {
    expect(getWebhookSecret()).toBe(null);
  });
});
