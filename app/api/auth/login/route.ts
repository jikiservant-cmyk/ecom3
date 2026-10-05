import { NextRequest, NextResponse } from 'next/server';
import {
  isServerSupabaseConfigured,
  getSupabaseAuthConfig,
  getUserScopedClient,
} from '@/lib/server/supabaseServer';
import { readJsonBody, isEmail, isNonEmptyString, jsonError } from '@/lib/server/validation';
import { clientIp } from '@/lib/server/rateLimit';
import { consumeLoginAttempt } from '@/lib/server/authThrottle';
import { logger } from '@/lib/server/logging';

export const dynamic = 'force-dynamic';

/**
 * Server-side password sign-in.
 *
 * Why this exists: `supabase.auth.signInWithPassword` called from the browser
 * goes directly to Supabase's Auth endpoint, which `proxy.ts` (matcher
 * `/api/:path*`) never sees. Admin credentials were therefore brute-forceable
 * with no limit this application controls. Routing the exchange through here
 * puts every attempt behind a per-IP and per-account throttle.
 *
 * Rules:
 * - One generic error for every credential failure. Distinguishing "no such
 *   account" from "wrong password" is an account-enumeration oracle.
 * - The role is read from `profiles` server-side under the user's own JWT and
 *   returned to the client; the client no longer decides it.
 * - The password is never logged.
 */

const UPSTREAM_TIMEOUT_MS = 10_000;
const CREDENTIAL_ERROR = 'Invalid email or password.';

export async function POST(req: NextRequest) {
  const body = await readJsonBody(req);
  if (!body) return jsonError('Invalid JSON body', 400);

  const email = isEmail(body.email) ? String(body.email).trim().toLowerCase() : null;
  // Cap the length so a multi-megabyte password cannot be forwarded upstream.
  const password = isNonEmptyString(body.password, 200) ? body.password : null;
  if (!email || !password) return jsonError(CREDENTIAL_ERROR, 400);

  if (!isServerSupabaseConfigured) return jsonError('Authentication is not configured', 503);

  // Throttle BEFORE touching Supabase, so the upstream never absorbs the spray.
  const throttle = consumeLoginAttempt(clientIp(req), email);
  if (!throttle.allowed) {
    logger.warn('login_throttled', { scope: throttle.scope, email });
    return NextResponse.json(
      { success: false, error: 'Too many sign-in attempts. Please wait a few minutes and try again.' },
      { status: 429, headers: { 'Retry-After': String(throttle.retryAfterSeconds) } }
    );
  }

  const auth = getSupabaseAuthConfig();
  if (!auth) return jsonError('Authentication is not configured', 503);

  // 1. Exchange the credentials at Supabase GoTrue.
  let token: any = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const res = await fetch(`${auth.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: auth.anonKey },
      body: JSON.stringify({ email, password }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      // Log the fact, never the reason detail and never the password.
      logger.warn('login_rejected', { email });
      return jsonError(CREDENTIAL_ERROR, 401);
    }
    token = await res.json();
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    logger.error('login_upstream_error', { email, aborted, error: e?.message });
    return jsonError('Authentication is temporarily unavailable. Please try again.', 502);
  }

  const accessToken = typeof token?.access_token === 'string' ? token.access_token : null;
  const refreshToken = typeof token?.refresh_token === 'string' ? token.refresh_token : null;
  const userId = typeof token?.user?.id === 'string' ? token.user.id : null;
  if (!accessToken || !refreshToken || !userId) {
    logger.warn('login_malformed_token_response', { email });
    return jsonError(CREDENTIAL_ERROR, 401);
  }

  // 2. Authoritative role lookup under the user's own JWT (RLS applies), so the
  //    browser is never the thing that decides whether someone is an admin.
  let role: 'admin' | 'customer' = 'customer';
  let fullName = '';
  let phone: string | undefined;
  try {
    const { data } = await (getUserScopedClient(accessToken).from('profiles') as any)
      .select('full_name, role, phone')
      .eq('id', userId)
      .maybeSingle();
    role = data?.role === 'admin' ? 'admin' : 'customer';
    fullName = typeof data?.full_name === 'string' ? data.full_name : '';
    phone = typeof data?.phone === 'string' && data.phone ? data.phone : undefined;
  } catch (e: any) {
    // Fail closed to the least privileged role rather than denying the login.
    logger.warn('login_profile_lookup_error', { userId, error: e?.message });
    role = 'customer';
  }

  logger.info('login_success', { userId, role });

  return NextResponse.json({
    success: true,
    role,
    user: {
      id: userId,
      email: typeof token.user?.email === 'string' ? token.user.email : email,
      name: fullName,
      phone,
    },
    session: {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: typeof token.expires_in === 'number' ? token.expires_in : undefined,
      token_type: typeof token.token_type === 'string' ? token.token_type : 'bearer',
    },
  });
}
