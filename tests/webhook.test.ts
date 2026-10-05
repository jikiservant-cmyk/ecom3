import { describe, it, expect } from 'vitest';
import {
  parseSignatureHeader,
  buildSignatureString,
  signLivePayWebhook,
  verifyLivePayWebhook,
  getWebhookSecret,
} from '@/lib/server/webhook';

const URL = 'https://your-domain.com/webhook';
const SECRET = 'whsec_test_secret_123';

describe('LivePay signature string (docs.livepay.me/webhooks)', () => {
  it('matches the documented example exactly', () => {
    // Docs example: sorted params are customer_reference, internal_reference, status
    const s = buildSignatureString(URL, '1781882665', {
      status: 'Success',
      customer_reference: 'INV-123',
      internal_reference: 'abc-456',
    });
    expect(s).toBe(
      'https://your-domain.com/webhook1781882665customer_referenceINV-123internal_referenceabc-456statusSuccess'
    );
  });

  it('sorts keys alphabetically regardless of input order', () => {
    const a = buildSignatureString(URL, '1', { status: 'Success', internal_reference: 'i', customer_reference: 'c' });
    const b = buildSignatureString(URL, '1', { customer_reference: 'c', internal_reference: 'i', status: 'Success' });
    expect(a).toBe(b);
    expect(a).toBe(`${URL}1customer_referencecinternal_referenceistatusSuccess`);
  });

  it('treats missing values as empty strings', () => {
    const s = buildSignatureString(URL, '9', { status: 'Success' });
    expect(s).toBe(`${URL}9customer_referenceinternal_referencestatusSuccess`);
  });
});

describe('header parsing', () => {
  it('parses t=...,v=...', () => {
    const p = parseSignatureHeader('t=1705314900,v=' + 'a'.repeat(64));
    expect(p).toEqual({ timestamp: '1705314900', signature: 'a'.repeat(64) });
  });

  it('rejects malformed input', () => {
    expect(parseSignatureHeader(null)).toBe(null);
    expect(parseSignatureHeader('')).toBe(null);
    expect(parseSignatureHeader('t=notanumber,v=' + 'a'.repeat(64))).toBe(null);
    expect(parseSignatureHeader('t=123,v=zzz')).toBe(null);
    expect(parseSignatureHeader('t=123,v=' + 'a'.repeat(63))).toBe(null);
    expect(parseSignatureHeader('v=' + 'a'.repeat(64))).toBe(null);
  });
});

describe('end-to-end verification', () => {
  const payload = {
    status: 'Success',
    message: 'Payment completed successfully',
    customer_reference: 'ORDDP-AB12-CD34',
    internal_reference: '550e8400-e29b-41d4-a716-446655440000',
    provider_transaction_id: '987654321',
    msisdn: '+256777123456',
    amount: 50000,
    currency: 'UGX',
    provider: 'MTN',
    charge: 1500,
    completed_at: '2024-01-15 10:35:00',
  };
  const ts = '1705314900';
  const goodHeader = `t=${ts},v=${signLivePayWebhook({ webhookUrl: URL, timestamp: ts, payload, secret: SECRET })}`;

  it('accepts a valid signature', () => {
    expect(
      verifyLivePayWebhook({ payload, header: goodHeader, candidateWebhookUrls: [URL], secret: SECRET })
    ).toBe(true);
  });

  it('accepts when one of several candidate URLs matches', () => {
    expect(
      verifyLivePayWebhook({
        payload,
        header: goodHeader,
        candidateWebhookUrls: ['https://other.example/hook', URL],
        secret: SECRET,
      })
    ).toBe(true);
  });

  it('NOTE: amount is NOT covered by LivePay\'s signature (docs: only customer_reference, internal_reference, status are signed)', () => {
    // Signature verification passes even for a tampered amount — this is by
    // LivePay's design. Tamper protection for amounts lives in the route,
    // which reconciles payload.amount/currency against the order total and
    // refuses to mark the order Paid on any mismatch.
    const tampered = { ...payload, amount: 1 };
    expect(
      verifyLivePayWebhook({ payload: tampered, header: goodHeader, candidateWebhookUrls: [URL], secret: SECRET })
    ).toBe(true);
  });

  it('rejects tampered status (forge success)', () => {
    const tampered = { ...payload, status: 'Failed' };
    expect(
      verifyLivePayWebhook({ payload: tampered, header: goodHeader, candidateWebhookUrls: [URL], secret: SECRET })
    ).toBe(false);
  });

  it('rejects tampered customer_reference (order swap)', () => {
    const tampered = { ...payload, customer_reference: 'ORDOTHER-ORDER' };
    expect(
      verifyLivePayWebhook({ payload: tampered, header: goodHeader, candidateWebhookUrls: [URL], secret: SECRET })
    ).toBe(false);
  });

  it('rejects wrong secret / missing header / no secret configured', () => {
    const wrongSig = `t=${ts},v=${signLivePayWebhook({ webhookUrl: URL, timestamp: ts, payload, secret: 'other' })}`;
    expect(verifyLivePayWebhook({ payload, header: wrongSig, candidateWebhookUrls: [URL], secret: SECRET })).toBe(false);
    expect(verifyLivePayWebhook({ payload, header: null, candidateWebhookUrls: [URL], secret: SECRET })).toBe(false);
    expect(verifyLivePayWebhook({ payload, header: goodHeader, candidateWebhookUrls: [URL], secret: null })).toBe(false);
  });

  it('rejects when no candidate URL matches the signed URL', () => {
    expect(
      verifyLivePayWebhook({ payload, header: goodHeader, candidateWebhookUrls: ['https://wrong.example/hook'], secret: SECRET })
    ).toBe(false);
  });

  it('getWebhookSecret fails closed on placeholder/unset', () => {
    expect(getWebhookSecret()).toBe(null);
  });
});
