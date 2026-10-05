import { describe, it, expect } from 'vitest';
import { computeOrderTotals, totalsMatch, safeReturnUrl, FLAT_DELIVERY_FEE_MINOR_UNITS } from '@/lib/server/orders';
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
