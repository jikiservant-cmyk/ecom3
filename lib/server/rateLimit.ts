/**
 * In-memory sliding-window rate limiter.
 *
 * NOTE: State is per-process. On multi-instance serverless deployments this is a
 * best-effort throttle, not a hard global cap. For hard guarantees put a shared
 * store (e.g. Upstash Redis) behind the same interface, or enforce limits at the
 * CDN/WAF. This is deliberately documented rather than silently insufficient.
 */
interface WindowEntry {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, WindowEntry>();

// Periodic pruning so the map cannot grow without bound.
let lastPrune = Date.now();
const PRUNE_INTERVAL_MS = 60_000;

function prune(now: number, windowMs: number) {
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  for (const [key, entry] of buckets) {
    if (now - entry.windowStart > windowMs) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
}

/**
 * Consume one unit from the (key, windowMs, maxRequests) bucket.
 */
export function consumeRateLimit(key: string, windowMs: number, maxRequests: number): RateLimitResult {
  const now = Date.now();
  prune(now, windowMs);

  let entry = buckets.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    entry = { count: 0, windowStart: now };
    buckets.set(key, entry);
  }
  entry.count += 1;
  const allowed = entry.count <= maxRequests;
  return {
    allowed,
    limit: maxRequests,
    remaining: Math.max(0, maxRequests - entry.count),
    resetMs: entry.windowStart + windowMs - now,
  };
}

export function rateLimitHeaders(res: Headers, result: RateLimitResult) {
  res.set('X-RateLimit-Limit', String(result.limit));
  res.set('X-RateLimit-Remaining', String(result.remaining));
  res.set('X-RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));
}

export function clientIp(req: Request): string {
  // Everything to the LEFT of the trusted proxy chain in X-Forwarded-For is
  // attacker-controlled. With N trusted proxies in front of the app the real
  // client IP is the Nth entry from the right, so set TRUSTED_PROXY_HOPS to
  // match the deployment (default 1: the rightmost entry, correct for a single
  // platform proxy that appends the client address).
  const hops = Math.max(1, Number.parseInt(process.env.TRUSTED_PROXY_HOPS || '1', 10) || 1);
  const xf = req.headers.get('x-forwarded-for');
  if (xf) {
    const parts = xf.split(',').map((s) => s.trim()).filter(Boolean);
    // A chain shorter than the configured hop count means the header did not
    // arrive through the expected infrastructure. Refuse it rather than
    // falling back to an attacker-chosen value.
    if (parts.length >= hops) return parts[parts.length - hops];
  }
  return req.headers.get('x-real-ip') || 'unknown';
}
