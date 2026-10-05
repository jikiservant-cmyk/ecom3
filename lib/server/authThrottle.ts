/**
 * Brute-force throttle for password sign-in.
 *
 * Sign-in previously went straight from the browser to Supabase Auth, so it
 * never passed through this app's rate limiter (`proxy.ts` only matches
 * `/api/*`). Every attempt now transits `/api/auth/login`, which consumes from
 * two buckets:
 *
 *  - per IP      — stops one attacker spraying many accounts
 *  - per account — stops a targeted attack on one known admin address, which a
 *                  per-IP limit cannot help with at all because the attacker
 *                  can rotate source addresses
 *
 * State is per-process, like the rest of `rateLimit.ts`. On multi-instance
 * deployments this is a strong mitigation rather than a hard global cap; put a
 * shared store behind `consumeRateLimit` for hard guarantees.
 */
import { consumeRateLimit } from './rateLimit';

/** 15 minutes, matching the LivePay merchant quota window. */
export const LOGIN_WINDOW_MS = 15 * 60_000;

/** Attempts per account per window before lockout. */
export const LOGIN_ACCOUNT_LIMIT = 10;

/** Attempts per source IP per window, across all accounts. */
export const LOGIN_IP_LIMIT = 30;

/**
 * Password reset. Much rarer than sign-in, and an unthrottled reset endpoint is
 * an admin-targeted attack on its own: flooding `resetPasswordForEmail` against
 * an admin address mail-bombs them and burns the project's auth quota, which
 * can lock out legitimate users. Limits are deliberately tight.
 */
export const RESET_WINDOW_MS = 15 * 60_000;
export const RESET_ACCOUNT_LIMIT = 3;
export const RESET_IP_LIMIT = 5;

/**
 * Registration. Unauthenticated account creation is the cheapest spam and
 * credential-stuffing foothold available, so it is capped per hour per IP.
 */
export const SIGNUP_WINDOW_MS = 60 * 60_000;
export const SIGNUP_ACCOUNT_LIMIT = 1;
export const SIGNUP_IP_LIMIT = 5;

export interface LoginThrottleDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  /** Which bucket tripped, for logging. null when allowed. */
  scope: 'account' | 'ip' | null;
}

/**
 * Normalise the identifier so throttle keys cannot be varied to dodge the
 * per-account bucket (`Admin@X.com`, ` admin@x.com `, and `admin@x.com` are the
 * same account).
 */
export function normalizeLoginIdentifier(email: string): string {
  return String(email || '').trim().toLowerCase();
}

/**
 * Consume one attempt from both buckets and report whether it may proceed.
 * Every attempt counts, successful or not: legitimate users sign in a handful
 * of times a day, so counting successes costs nothing and keeps the accounting
 * simple enough to reason about.
 */
export function consumeLoginAttempt(ip: string, email: string): LoginThrottleDecision {
  const account = consumeRateLimit(`login-acct:${normalizeLoginIdentifier(email)}`, LOGIN_WINDOW_MS, LOGIN_ACCOUNT_LIMIT);
  if (!account.allowed) {
    return { allowed: false, retryAfterSeconds: Math.ceil(account.resetMs / 1000), scope: 'account' };
  }

  const byIp = consumeRateLimit(`login-ip:${ip}`, LOGIN_WINDOW_MS, LOGIN_IP_LIMIT);
  if (!byIp.allowed) {
    return { allowed: false, retryAfterSeconds: Math.ceil(byIp.resetMs / 1000), scope: 'ip' };
  }

  return { allowed: true, retryAfterSeconds: 0, scope: null };
}

/** Consume one password-reset attempt from the per-account and per-IP buckets. */
export function consumeResetAttempt(ip: string, email: string): LoginThrottleDecision {
  const account = consumeRateLimit(
    `reset-acct:${normalizeLoginIdentifier(email)}`,
    RESET_WINDOW_MS,
    RESET_ACCOUNT_LIMIT
  );
  if (!account.allowed) {
    return { allowed: false, retryAfterSeconds: Math.ceil(account.resetMs / 1000), scope: 'account' };
  }

  const byIp = consumeRateLimit(`reset-ip:${ip}`, RESET_WINDOW_MS, RESET_IP_LIMIT);
  if (!byIp.allowed) {
    return { allowed: false, retryAfterSeconds: Math.ceil(byIp.resetMs / 1000), scope: 'ip' };
  }

  return { allowed: true, retryAfterSeconds: 0, scope: null };
}

/** Consume one registration attempt from the per-account and per-IP buckets. */
export function consumeSignupAttempt(ip: string, email: string): LoginThrottleDecision {
  const account = consumeRateLimit(
    `signup-acct:${normalizeLoginIdentifier(email)}`,
    SIGNUP_WINDOW_MS,
    SIGNUP_ACCOUNT_LIMIT
  );
  if (!account.allowed) {
    return { allowed: false, retryAfterSeconds: Math.ceil(account.resetMs / 1000), scope: 'account' };
  }

  const byIp = consumeRateLimit(`signup-ip:${ip}`, SIGNUP_WINDOW_MS, SIGNUP_IP_LIMIT);
  if (!byIp.allowed) {
    return { allowed: false, retryAfterSeconds: Math.ceil(byIp.resetMs / 1000), scope: 'ip' };
  }

  return { allowed: true, retryAfterSeconds: 0, scope: null };
}
