import { NextRequest, NextResponse } from 'next/server';
import { isServerSupabaseConfigured, getSupabaseAuthConfig } from '@/lib/server/supabaseServer';
import { readJsonBody, isEmail, jsonError } from '@/lib/server/validation';
import { clientIp } from '@/lib/server/rateLimit';
import { consumeResetAttempt } from '@/lib/server/authThrottle';
import { logger } from '@/lib/server/logging';

export const dynamic = 'force-dynamic';

/**
 * Server-side password reset request.
 *
 * Why this exists: `supabase.auth.resetPasswordForEmail` called from the browser
 * went straight to Supabase and bypassed every limit this app controls. That is
 * an admin-targeted attack in its own right — flooding an admin address
 * mail-bombs them and burns the project's auth quota, which can lock legitimate
 * users out entirely.
 *
 * Rules:
 * - Always report success. Saying "no account with that email" turns the reset
 *   form into an account-enumeration oracle.
 * - Throttle before touching Supabase.
 */

const UPSTREAM_TIMEOUT_MS = 10_000;
const ACCEPTED = 'If that address has an account, a reset link is on its way.';

export async function POST(req: NextRequest) {
  const body = await readJsonBody(req);
  if (!body) return jsonError('Invalid JSON body', 400);

  const email = isEmail(body.email) ? String(body.email).trim().toLowerCase() : null;
  if (!email) return jsonError(ACCEPTED, 400);

  if (!isServerSupabaseConfigured) return jsonError('Authentication is not configured', 503);

  const throttle = consumeResetAttempt(clientIp(req), email);
  if (!throttle.allowed) {
    logger.warn('password_reset_throttled', { scope: throttle.scope, email });
    return NextResponse.json(
      { success: false, error: 'Too many reset requests. Please wait a few minutes and try again.' },
      { status: 429, headers: { 'Retry-After': String(throttle.retryAfterSeconds) } }
    );
  }

  const auth = getSupabaseAuthConfig();
  if (!auth) return jsonError('Authentication is not configured', 503);

  const redirectTo = req.headers.get('origin')
    ? `${req.headers.get('origin')}/reset-password`
    : undefined;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const res = await fetch(`${auth.url}/auth/v1/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: auth.anonKey },
      body: JSON.stringify({ email, ...(redirectTo ? { data: { redirectTo } } : {}) }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    // A non-2xx here usually just means "no such account" — never surface that.
    if (!res.ok) logger.info('password_reset_not_delivered', { email });
    else logger.info('password_reset_requested', { email });
  } catch (e: any) {
    logger.error('password_reset_upstream_error', { email, error: e?.message });
    return jsonError('The reset service is temporarily unavailable. Please try again.', 502);
  }

  // Same response whether or not the address exists.
  return NextResponse.json({ success: true, message: ACCEPTED });
}
