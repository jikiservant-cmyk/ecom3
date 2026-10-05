import { describe, it, expect, afterEach } from 'vitest';
import { computeOrderTotals, totalsMatch, safeReturnUrl, reconcilePaymentAmount, FLAT_DELIVERY_FEE_MINOR_UNITS } from '@/lib/server/orders';
import { clientIp } from '@/lib/server/rateLimit';

describe('server-side order totals', () => {
  it('adds the flat delivery fee for non-empty carts', () => {
    const t = computeOrderTotals([1_500_000_00, 250_000_00]); // minor units
    expect(t.subtotalMinorUnits).toBe(1_750_000_00);
    expect(t.shippingMinorUnits).toBe(FLAT_DELIVERY_FEE_MINOR_UNITS);
    expect(t.totalMinorUnits).toBe(1_750_000_00 + FLAT_DELIVERY_FEE_MINOR_UNITS);
  });

  it('no fee for empty carts', () => {
    const t = computeOrderTotals([]);
    expect(t.shippingMinorUnits).toBe(0);
    expect(t.totalMinorUnits).toBe(0);
  });

  it('accepts a matching client total, rejects a mismatch', () => {
    const t = computeOrderTotals([100_00_00]);
    expect(totalsMatch(t, t.totalMinorUnits)).toBe(true);
    expect(totalsMatch(t, t.totalMinorUnits + 1)).toBe(true); // 1-unit tolerance
    expect(totalsMatch(t, t.totalMinorUnits + 2)).toBe(false);
    expect(totalsMatch(t, 1)).toBe(false); // attacker 1-UGX attempt
    expect(totalsMatch(t, NaN)).toBe(false);
  });
});

describe('safeReturnUrl (open-redirect guard)', () => {
  const appUrl = 'https://drumpalace.ug';

  it('accepts same-origin return URLs', () => {
    expect(safeReturnUrl('https://drumpalace.ug/?order=DP-123', appUrl)).toBe('https://drumpalace.ug/?order=DP-123');
  });

  it('rejects cross-origin URLs', () => {
    expect(safeReturnUrl('https://evil.com/phish', appUrl)).toBe(null);
    expect(safeReturnUrl('https://drumpalace.ug.evil.com/', appUrl)).toBe(null);
    expect(safeReturnUrl('http://drumpalace.ug/', appUrl)).toBe(null); // wrong scheme
  });

  it('rejects junk and missing values', () => {
    expect(safeReturnUrl('not a url', appUrl)).toBe(null);
    expect(safeReturnUrl(null, appUrl)).toBe(null);
    expect(safeReturnUrl('https://drumpalace.ug/x', undefined)).toBe(null);
  });
});

describe('clientIp trusts the rightmost X-Forwarded-For entry only', () => {
  const mk = (xff: string | null) =>
    ({ headers: { get: (k: string) => (k.toLowerCase() === 'x-forwarded-for' ? xff : null) } }) as unknown as Request;

  it('takes the last (proxy-appended) entry, not spoofable left entries', () => {
    expect(clientIp(mk('1.2.3.4, 10.0.0.1'))).toBe('10.0.0.1');
    expect(clientIp(mk('attacker-controlled, 9.9.9.9'))).toBe('9.9.9.9');
  });

  it('handles single values and absence', () => {
    expect(clientIp(mk('5.6.7.8'))).toBe('5.6.7.8');
    expect(clientIp(mk(null))).toBe('unknown');
    expect(clientIp(mk('   '))).toBe('unknown');
  });
});

describe('reconcilePaymentAmount (the only defence for unsigned `amount`)', () => {
  const order = { orderTotalAmount: 175000, orderTotalMinorUnits: 17_500_000, orderCurrency: 'UGX' };

  it('accepts an exact match', () => {
    const r = reconcilePaymentAmount({ ...order, payloadAmount: 175000, payloadCurrency: 'UGX' });
    expect(r.amountOk).toBe(true);
    expect(r.currencyOk).toBe(true);
    expect(r.expectedMinor).toBe(17_500_000);
    expect(r.paidMinor).toBe(17_500_000);
  });

  it('rejects an underpayment (1 UGX)', () => {
    expect(reconcilePaymentAmount({ ...order, payloadAmount: 1, payloadCurrency: 'UGX' }).amountOk).toBe(false);
  });

  it('rejects an overpayment — amounts must match exactly', () => {
    expect(reconcilePaymentAmount({ ...order, payloadAmount: 175001, payloadCurrency: 'UGX' }).amountOk).toBe(false);
  });

  it('fails closed on missing or non-numeric amounts', () => {
    expect(reconcilePaymentAmount({ ...order, payloadAmount: undefined }).amountOk).toBe(false);
    expect(reconcilePaymentAmount({ ...order, payloadAmount: null }).amountOk).toBe(false);
    expect(reconcilePaymentAmount({ ...order, payloadAmount: 'abc' }).amountOk).toBe(false);
    expect(reconcilePaymentAmount({ ...order, payloadAmount: {} }).amountOk).toBe(false);
  });

  it('falls back to total_minor_units when total_amount is absent', () => {
    const r = reconcilePaymentAmount({
      orderTotalAmount: null,
      orderTotalMinorUnits: 5_000_000,
      orderCurrency: 'UGX',
      payloadAmount: 50000,
      payloadCurrency: 'UGX',
    });
    expect(r.amountOk).toBe(true);
  });

  it('fails closed when the order has no usable total', () => {
    const r = reconcilePaymentAmount({
      orderTotalAmount: null,
      orderTotalMinorUnits: null,
      payloadAmount: 50000,
      payloadCurrency: 'UGX',
    });
    expect(r.amountOk).toBe(false);
    expect(Number.isNaN(r.expectedMinor)).toBe(true);
  });

  it('rejects a currency mismatch, tolerates a missing one', () => {
    expect(reconcilePaymentAmount({ ...order, payloadAmount: 175000, payloadCurrency: 'USD' }).currencyOk).toBe(false);
    expect(reconcilePaymentAmount({ ...order, payloadAmount: 175000, payloadCurrency: 'ugx' }).currencyOk).toBe(true);
    expect(reconcilePaymentAmount({ ...order, payloadAmount: 175000, payloadCurrency: undefined }).currencyOk).toBe(true);
  });

  it('accepts a numeric string amount from the gateway', () => {
    expect(reconcilePaymentAmount({ ...order, payloadAmount: '175000', payloadCurrency: 'UGX' }).amountOk).toBe(true);
  });
});

describe('clientIp with TRUSTED_PROXY_HOPS configured', () => {
  const mk = (xff: string | null) =>
    ({ headers: { get: (k: string) => (k.toLowerCase() === 'x-forwarded-for' ? xff : null) } }) as unknown as Request;
  const original = process.env.TRUSTED_PROXY_HOPS;

  afterEach(() => {
    if (original === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = original;
  });

  it('takes the Nth entry from the right for N trusted proxies', () => {
    process.env.TRUSTED_PROXY_HOPS = '2';
    expect(clientIp(mk('spoofed, 1.2.3.4, 10.0.0.1'))).toBe('1.2.3.4');
  });

  it('refuses a chain shorter than the hop count instead of trusting the client', () => {
    process.env.TRUSTED_PROXY_HOPS = '3';
    expect(clientIp(mk('attacker-chosen'))).toBe('unknown');
  });

  it('defaults to one hop when unset or invalid', () => {
    delete process.env.TRUSTED_PROXY_HOPS;
    expect(clientIp(mk('spoofed, 9.9.9.9'))).toBe('9.9.9.9');
    process.env.TRUSTED_PROXY_HOPS = 'not-a-number';
    expect(clientIp(mk('spoofed, 9.9.9.9'))).toBe('9.9.9.9');
    process.env.TRUSTED_PROXY_HOPS = '0';
    expect(clientIp(mk('spoofed, 9.9.9.9'))).toBe('9.9.9.9');
  });
});
