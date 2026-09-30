import { NextRequest, NextResponse } from 'next/server';
import { consumeRateLimit, rateLimitHeaders, clientIp } from '@/lib/server/rateLimit';

/**
 * Global edge middleware:
 * - Per-IP sliding-window rate limiting (stricter for mutating/expensive routes).
 * - Baseline security headers.
 *
 * NOTE: edge runtime — `lib/server/rateLimit.ts` is dependency-free and edge-safe.
 * In-memory limits are per instance; add a shared store or WAF rules for hard
 * global caps (documented in README).
 */

const MINUTE = 60_000;

interface RouteLimit {
  match: RegExp;
  methods?: string[];
  windowMs: number;
  max: number;
  bucket: string;
}

// Ordered; first match wins.
const LIMITS: RouteLimit[] = [
  { match: /^\/api\/health$/, windowMs: MINUTE, max: 120, bucket: 'health' },
  { match: /^\/api\/payments\/livepay\/webhook$/, methods: ['POST'], windowMs: MINUTE, max: 60, bucket: 'webhook' },
  { match: /^\/api\/payments\/livepay\/test-connection$/, methods: ['POST'], windowMs: MINUTE, max: 5, bucket: 'pay-test' },
  { match: /^\/api\/payments\/livepay$/, methods: ['POST'], windowMs: MINUTE, max: 10, bucket: 'pay' },
  { match: /^\/api\/orders$/, methods: ['POST'], windowMs: MINUTE, max: 10, bucket: 'order-create' },
  { match: /^\/api\/contact$/, methods: ['POST'], windowMs: MINUTE, max: 5, bucket: 'contact' },
  { match: /^\/api\/reviews$/, methods: ['POST'], windowMs: MINUTE, max: 5, bucket: 'review' },
  { match: /^\/api\//, methods: ['GET', 'POST', 'PATCH', 'DELETE'], windowMs: MINUTE, max: 120, bucket: 'api' },
];

export function middleware(req: NextRequest) {
  const { pathname, method } = { pathname: req.nextUrl.pathname, method: req.method.toUpperCase() };

  if (!pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  const ip = clientIp(req);
  const rule = LIMITS.find((r) => r.match.test(pathname) && (!r.methods || r.methods.includes(method)));
  if (rule) {
    const result = consumeRateLimit(`${rule.bucket}:${ip}`, rule.windowMs, rule.max);
    if (!result.allowed) {
      const res = NextResponse.json(
        { success: false, error: 'Too many requests. Please slow down and try again shortly.' },
        { status: 429 }
      );
      rateLimitHeaders(res.headers, result);
      res.headers.set('Retry-After', String(Math.ceil(result.resetMs / 1000)));
      return res;
    }
    // Continue, attaching informational headers on the final response below.
    const res = NextResponse.next();
    rateLimitHeaders(res.headers, result);
    return res;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
