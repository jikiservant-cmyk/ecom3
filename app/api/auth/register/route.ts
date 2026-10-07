import { NextRequest, NextResponse } from 'next/server';
import { isServerSupabaseConfigured, getSupabaseAuthConfig } from '@/lib/server/supabaseServer';
import { readJsonBody, isEmail, isNonEmptyString, sanitizeText, jsonError } from '@/lib/server/validation';
import { clientIp } from '@/lib/server/rateLimit';
import { consumeSignupAttempt } from '@/lib/server/authThrottle';
import { logger } from '@/lib/server/logging';

export const dynamic = 'force-dynamic';

/**
 * Server-side registration.
 *
 * Registration was the last unauthenticated Supabase Auth call made straight
 * from the browser, so it bypassed every limit this app controls — an open tap
 * for throwaway-account creation and credential stuffing.
 *
 * `role` is deliberately never sent. The `handle_new_user()` trigger hard-codes
 * 'customer' and `protect_profile_role()` blocks self-escalation, so this route
 * cannot be used to mint an admin.
 */

const UPSTREAM_TIMEOUT_MS = 10_000;
const MIN_PASSWORD_LENGTH = 6;

export async function POST(req: NextRequest) {
  const body = await readJsonBody(req);
  if (!body) return jsonError('Invalid JSON body', 400);

  const email = isEmail(body.email) ? String(body.email).trim().toLowerCase() : null;
  const password = isNonEmptyString(body.password, 200) ? body.password : null;
  if (!email || !password) return jsonError('Please provide a valid email and password.', 400);
  if (password.length < MIN_PASSWORD_LENGTH) {
    return jsonError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 400);
  }

  // sanitizeText assumes a string, so coerce before calling it.
  const fullName = sanitizeText(typeof body.fullName === 'string' ? body.fullName : '', 120) || email.split('@')[0];
  const phoneRaw = sanitizeText(typeof body.phone === 'string' ? body.phone : '', 40);
  const phone = phoneRaw || null;

  if (!isServerSupabaseConfigured) return jsonError('Authentication is not configured', 503);

  const throttle = consumeSignupAttempt(clientIp(req), email);
  if (!throttle.allowed) {
    logger.warn('signup_throttled', { scope: throttle.scope, email });
    return NextResponse.json(
      { success: false, error: 'Too many accounts created from here. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(throttle.retryAfterSeconds) } }
    );
  }

  const auth = getSupabaseAuthConfig();
  if (!auth) return jsonError('Authentication is not configured', 503);

  let created: any = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const res = await fetch(`${auth.url}/auth/v1/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: auth.anonKey },
      // No `role` key. Ever.
      body: JSON.stringify({ email, password, data: { full_name: fullName, name: fullName, phone } }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      // GoTrue echoes a reason; do not forward it verbatim — it can reveal
      // whether the address is already registered.
      logger.warn('signup_rejected', { email });
      return jsonError('Could not create that account. Please check your details.', 400);
    }
    created = await res.json();
  } catch (e: any) {
    logger.error('signup_upstream_error', { email, error: e?.message });
    return jsonError('Registration is temporarily unavailable. Please try again.', 502);
  }

  const userId = typeof created?.user?.id === 'string' ? created.user.id : null;
  const accessToken = typeof created?.access_token === 'string' ? created.access_token : null;
  const refreshToken = typeof created?.refresh_token === 'string' ? created.refresh_token : null;
  if (!userId) {
    logger.warn('signup_malformed_response', { email });
    return jsonError('Could not create that account. Please check your details.', 400);
  }

  logger.info('signup_success', { userId });

  // Email confirmation may be required, in which case there is no session yet.
  if (!accessToken || !refreshToken) {
    return NextResponse.json({
      success: true,
      needsConfirmation: true,
      user: { id: userId, email, name: fullName, phone: phone || undefined },
    });
  }

  return NextResponse.json({
    success: true,
    needsConfirmation: false,
    // Role is whatever the DB trigger assigned — never client-supplied.
    role: 'customer',
    user: { id: userId, email, name: fullName, phone: phone || undefined },
    session: {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: typeof created.expires_in === 'number' ? created.expires_in : undefined,
      token_type: typeof created.token_type === 'string' ? created.token_type : 'bearer',
    },
  });
}
