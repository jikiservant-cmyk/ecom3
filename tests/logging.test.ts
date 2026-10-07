import { describe, it, expect } from 'vitest';
import { maskPii } from '@/lib/server/logging';

describe('maskPii — emails', () => {
  it('masks a plain address', () => {
    expect(maskPii('customer@gmail.com')).toBe('[email-redacted]');
  });

  it('masks an address whose local part contains an apostrophe', () => {
    // This is the regression: the old narrow character class did not include
    // "'", so o'brien@x.com was written to the log in full.
    expect(maskPii("o'brien@drumpalace.ug")).toBe('[email-redacted]');
    expect(maskPii("a'@b.com")).toBe('[email-redacted]');
  });

  it('masks other RFC-5322 legal local-part characters', () => {
    expect(maskPii('first+tag@example.com')).toBe('[email-redacted]');
    expect(maskPii('a!b@example.com')).toBe('[email-redacted]');
    expect(maskPii('user_name@sub.domain.co.ug')).toBe('[email-redacted]');
  });

  it('masks an address embedded in a sentence and leaves the rest', () => {
    expect(maskPii('failed login for jane.doe@gmail.com at 3pm')).toBe(
      'failed login for [email-redacted] at 3pm'
    );
  });

  it('masks several addresses in one string', () => {
    const out = maskPii('a@x.com and b@y.com') as string;
    expect(out).toBe('[email-redacted] and [email-redacted]');
  });

  it('does not treat a lone @ as an email', () => {
    expect(maskPii('twitter handle @drumpalace')).toBe('twitter handle @drumpalace');
  });

  it('stops at delimiters instead of swallowing the rest of a log line', () => {
    expect(maskPii('email=a@b.com, status=failed')).toBe('email=[email-redacted], status=failed');
  });
});

describe('maskPii — phone numbers', () => {
  it('masks a Ugandan mobile number', () => {
    expect(maskPii('0772123456')).toBe('[phone-redacted]');
  });

  it('masks an international format', () => {
    expect(maskPii('+256772123456')).toBe('[phone-redacted]');
  });

  it('masks a spaced number', () => {
    expect(maskPii('0772 123 456')).toBe('[phone-redacted]');
  });

  it('leaves short numeric ids alone', () => {
    expect(maskPii('order 12345')).toBe('order 12345');
  });
});

describe('maskPii — passthrough', () => {
  it('returns non-strings untouched', () => {
    expect(maskPii(12345)).toBe(12345);
    expect(maskPii(null)).toBe(null);
    expect(maskPii(undefined)).toBe(undefined);
    expect(maskPii({ a: 1 })).toEqual({ a: 1 });
  });

  it('leaves ordinary prose unchanged', () => {
    expect(maskPii('order created successfully')).toBe('order created successfully');
  });
});
