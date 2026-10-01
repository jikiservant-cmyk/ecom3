import { describe, it, expect } from 'vitest';
import { generateOrderNumber, generateOrderId } from '@/lib/server/orders';
import { isEmail, isIntInRange, isNonEmptyString, sanitizeText } from '@/lib/server/validation';

describe('order number generation', () => {
  it('matches the DP-XXXX-XXXX format', () => {
    for (let i = 0; i < 20; i++) {
      expect(generateOrderNumber()).toMatch(/^DP-[23456789A-HJKMNP-Z]{4}-[23456789A-HJKMNP-Z]{4}$/);
    }
  });

  it('does not produce ambiguous characters (0/O/1/I/L)', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateOrderNumber()).not.toMatch(/[0O1IL]/);
    }
  });

  it('is collision-free over 10k samples', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(generateOrderNumber());
    expect(seen.size).toBe(10_000);
  });

  it('generates valid UUID order ids', () => {
    expect(generateOrderId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

describe('input validation helpers', () => {
  it('validates emails', () => {
    expect(isEmail('a@b.co')).toBe(true);
    expect(isEmail('not-an-email')).toBe(false);
    expect(isEmail('a b@c.co')).toBe(false);
    expect(isEmail('x'.repeat(400) + '@b.co')).toBe(false);
  });

  it('validates integer ranges (quantity)', () => {
    expect(isIntInRange(1, 1, 20)).toBe(true);
    expect(isIntInRange(20, 1, 20)).toBe(true);
    expect(isIntInRange(0, 1, 20)).toBe(false);
    expect(isIntInRange(21, 1, 20)).toBe(false);
    expect(isIntInRange(1.5, 1, 20)).toBe(false);
    expect(isIntInRange('5' as any, 1, 20)).toBe(false);
    expect(isIntInRange(NaN, 1, 20)).toBe(false);
  });

  it('rejects empty or oversized strings', () => {
    expect(isNonEmptyString('hello', 10)).toBe(true);
    expect(isNonEmptyString('   ', 10)).toBe(false);
    expect(isNonEmptyString('hellohellohello', 10)).toBe(false);
    expect(isNonEmptyString(123 as any, 10)).toBe(false);
  });

  it('strips control characters and trims', () => {
    expect(sanitizeText('  hi\u0000there\u0007  ', 100)).toBe('hithere');
    expect(sanitizeText('x'.repeat(500), 10)).toBe('x'.repeat(10));
  });
});
