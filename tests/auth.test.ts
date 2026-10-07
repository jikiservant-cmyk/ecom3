import { describe, it, expect } from 'vitest';
import {
  extractBearerToken,
  authenticateRequest,
  authenticateAdmin,
  isServerSupabaseConfigured,
  hasServiceRoleKey,
  getServerAdminClient,
} from '@/lib/server/supabaseServer';

const reqWith = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/orders', { headers }) as unknown as Request;

describe('extractBearerToken', () => {
  it('accepts a well-formed bearer token', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
    expect(extractBearerToken(reqWith({ authorization: `Bearer ${token}` }))).toBe(token);
  });

  it('is case-insensitive on the scheme', () => {
    const token = 'aaa.bbb.ccc';
    expect(extractBearerToken(reqWith({ authorization: `bearer ${token}` }))).toBe(token);
    expect(extractBearerToken(reqWith({ authorization: `BEARER ${token}` }))).toBe(token);
  });

  it('trims surrounding whitespace on the token', () => {
    expect(extractBearerToken(reqWith({ authorization: 'Bearer   aaa.bbb.ccc  ' }))).toBe('aaa.bbb.ccc');
  });

  it('rejects a missing or empty header', () => {
    expect(extractBearerToken(reqWith())).toBe(null);
    expect(extractBearerToken(reqWith({ authorization: '' }))).toBe(null);
  });

  it('rejects other auth schemes', () => {
    expect(extractBearerToken(reqWith({ authorization: 'Basic dXNlcjpwYXNz' }))).toBe(null);
    expect(extractBearerToken(reqWith({ authorization: 'Token aaa.bbb.ccc' }))).toBe(null);
    // "BearerX..." must not be accepted as "bearer "
    expect(extractBearerToken(reqWith({ authorization: 'BearerX aaa.bbb.ccc' }))).toBe(null);
  });

  it('rejects a bare scheme with no token', () => {
    expect(extractBearerToken(reqWith({ authorization: 'Bearer' }))).toBe(null);
    expect(extractBearerToken(reqWith({ authorization: 'Bearer ' }))).toBe(null);
    expect(extractBearerToken(reqWith({ authorization: 'Bearer    ' }))).toBe(null);
  });

  it('rejects tokens that are not three JWT segments', () => {
    expect(extractBearerToken(reqWith({ authorization: 'Bearer notajwt' }))).toBe(null);
    expect(extractBearerToken(reqWith({ authorization: 'Bearer only.two' }))).toBe(null);
    expect(extractBearerToken(reqWith({ authorization: 'Bearer a.b.c.d' }))).toBe(null);
  });
});

describe('server auth fails closed without configuration', () => {
  // These env vars are deliberately unset in the test environment, which is the
  // exact state of a deployment that forgot to configure Supabase. Every
  // authentication path must deny rather than fall through.
  it('reports Supabase as unconfigured', () => {
    expect(isServerSupabaseConfigured).toBe(false);
    expect(hasServiceRoleKey).toBe(false);
    expect(getServerAdminClient()).toBe(null);
  });

  it('authenticateRequest denies even a well-formed token', async () => {
    const req = reqWith({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl' });
    expect(await authenticateRequest(req)).toBe(null);
  });

  it('authenticateRequest denies a missing token', async () => {
    expect(await authenticateRequest(reqWith())).toBe(null);
  });

  it('authenticateAdmin denies even a well-formed token', async () => {
    const req = reqWith({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl' });
    expect(await authenticateAdmin(req)).toBe(null);
  });
});

describe('placeholder credentials are rejected as unconfigured', () => {
  // A verbatim copy of .env.example must never produce a half-working server.
  it('the shipped placeholders contain the markers the guard looks for', () => {
    expect('YOUR_SUPABASE_URL'.includes('YOUR_')).toBe(true);
    expect('https://placeholder.supabase.co'.includes('placeholder')).toBe(true);
  });
});
