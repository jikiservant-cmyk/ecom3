import { describe, it, expect } from 'vitest';
import {
  consumeLoginAttempt,
  normalizeLoginIdentifier,
  LOGIN_ACCOUNT_LIMIT,
  LOGIN_IP_LIMIT,
  LOGIN_WINDOW_MS,
} from '@/lib/server/authThrottle';

describe('normalizeLoginIdentifier', () => {
  it('lowercases and trims so throttle keys cannot be varied', () => {
    expect(normalizeLoginIdentifier('  Admin@DrumPalace.UG ')).toBe('admin@drumpalace.ug');
  });

  it('tolerates empty and non-string input', () => {
    expect(normalizeLoginIdentifier('')).toBe('');
    expect(normalizeLoginIdentifier(undefined as unknown as string)).toBe('');
  });
});

describe('per-account lockout (targeted attack on one admin address)', () => {
  const email = 'acct-lockout@example.com';

  it(`allows ${LOGIN_ACCOUNT_LIMIT} attempts, then locks that account`, () => {
    // A distinct source IP each time, so only the account bucket can trip.
    for (let i = 0; i < LOGIN_ACCOUNT_LIMIT; i++) {
      expect(consumeLoginAttempt(`10.1.${i}.1`, email).allowed).toBe(true);
    }
    const blocked = consumeLoginAttempt('10.1.99.1', email);
    expect(blocked.allowed).toBe(false);
    expect(blocked.scope).toBe('account');
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(LOGIN_WINDOW_MS / 1000);
  });

  it('does not lock other accounts when one is exhausted', () => {
    expect(consumeLoginAttempt('10.2.0.1', 'somebody-else@example.com').allowed).toBe(true);
  });
});

describe('per-IP lockout (one attacker spraying many accounts)', () => {
  const ip = '203.0.113.7';

  it(`allows ${LOGIN_IP_LIMIT} attempts across distinct accounts, then locks the IP`, () => {
    for (let i = 0; i < LOGIN_IP_LIMIT; i++) {
      expect(consumeLoginAttempt(ip, `spray${i}@example.com`).allowed).toBe(true);
    }
    const blocked = consumeLoginAttempt(ip, 'a-brand-new-account@example.com');
    expect(blocked.allowed).toBe(false);
    expect(blocked.scope).toBe('ip');
  });
});

describe('account buckets survive trivial identifier variation', () => {
  it('counts mixed-case and padded variants against the same account', () => {
    for (let i = 0; i < LOGIN_ACCOUNT_LIMIT; i++) {
      const variant = i % 2 === 0 ? '  MiXeD@Example.COM ' : 'mixed@example.com';
      consumeLoginAttempt(`198.51.100.${i}`, variant);
    }
    expect(consumeLoginAttempt('198.51.100.200', 'MIXED@example.COM').allowed).toBe(false);
  });
});
