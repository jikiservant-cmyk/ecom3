import { describe, it, expect } from 'vitest';
import { consumeRateLimit } from '@/lib/server/rateLimit';

describe('in-memory sliding-window rate limiter', () => {
  it('allows requests up to the limit', () => {
    for (let i = 0; i < 5; i++) {
      const r = consumeRateLimit('test-allow:1.2.3.4', 60_000, 5);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(5 - i - 1);
    }
  });

  it('blocks requests beyond the limit', () => {
    for (let i = 0; i < 3; i++) consumeRateLimit('test-block:1.2.3.4', 60_000, 3);
    const denied = consumeRateLimit('test-block:1.2.3.4', 60_000, 3);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it('isolates buckets per key', () => {
    for (let i = 0; i < 3; i++) consumeRateLimit('test-iso:a', 60_000, 3);
    const other = consumeRateLimit('test-iso:b', 60_000, 3);
    expect(other.allowed).toBe(true);
  });

  it('resets after the window elapses', () => {
    for (let i = 0; i < 2; i++) consumeRateLimit('test-reset:1.1.1.1', 50, 2);
    const denied = consumeRateLimit('test-reset:1.1.1.1', 50, 2);
    expect(denied.allowed).toBe(false);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const after = consumeRateLimit('test-reset:1.1.1.1', 50, 2);
        expect(after.allowed).toBe(true);
        resolve();
      }, 80);
    });
  });
});
