import { NextRequest, NextResponse } from 'next/server';
import { authenticateAdmin } from '@/lib/server/supabaseServer';
import { logger } from '@/lib/server/logging';
import { jsonError } from '@/lib/server/validation';

export const dynamic = 'force-dynamic';

const FETCH_TIMEOUT_MS = 10_000;

/**
 * LivePay connectivity check — ADMIN ONLY, server-side credentials ONLY.
 *
 * Deliberate changes from the previous implementation:
 * - No request-body credentials are accepted (they were stored in browsers and
 *   forwarded, enabling secret theft).
 * - No client-supplied URL is fetched (the old endpoint was an SSRF that leaked
 *   the server's LIVEPAY_API_KEY to attacker-controlled hosts).
 * - The gateway URL comes from env and is restricted to *.livepay.me.
 */
export async function POST(req: NextRequest) {
  const admin = await authenticateAdmin(req);
  if (!admin) return jsonError('Authentication required', 401);

  const apiKey = process.env.LIVEPAY_API_KEY;
  const secretKey = process.env.LIVEPAY_SECRET_KEY;
  const merchantId = process.env.LIVEPAY_MERCHANT_ID || '';
  let baseUrl = (process.env.LIVEPAY_API_URL || 'https://livepay.me/api').replace(/\/+$/, '');

  let host = '';
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return jsonError('LIVEPAY_API_URL is not a valid URL', 500);
  }
  if (!/(^|\.)livepay\.me$/.test(host)) {
    logger.error('livepay_test_blocked_url', { host });
    return jsonError('LIVEPAY_API_URL must point to a livepay.me host', 500);
  }

  const isConfigured = Boolean(apiKey && !apiKey.includes('YOUR_'));
  if (!isConfigured) {
    return NextResponse.json({
      success: true,
      mode: 'unconfigured',
      status: 'Not configured',
      message: 'LivePay credentials are not set on the server. Payments will be rejected until LIVEPAY_API_KEY is configured.',
      credentialsDetected: false,
      documentation: 'https://docs.livepay.me/',
    });
  }

  const startTime = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const pingRes = await fetch(`${baseUrl}/merchant/status`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secretKey || apiKey}`,
        'X-API-KEY': apiKey as string,
        'X-Merchant-ID': merchantId,
      },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startTime;
    const responseData = await pingRes.json().catch(() => ({}));

    logger.info('livepay_connection_test', { admin: admin.userId, ok: pingRes.ok, latencyMs });
    return NextResponse.json({
      success: pingRes.ok,
      mode: 'live_gateway',
      status: pingRes.ok ? 'Connected (Live)' : `Gateway returned ${pingRes.status}`,
      latencyMs,
      merchantId: merchantId || 'Default',
      credentialsDetected: true,
      gatewayResponse: responseData,
      documentation: 'https://docs.livepay.me/',
    });
  } catch (fetchErr: any) {
    logger.warn('livepay_connection_test_error', { error: fetchErr?.message });
    return NextResponse.json({
      success: false,
      mode: 'live_gateway',
      status: 'Connection failed',
      message: `Could not reach the LivePay gateway (${fetchErr?.name === 'AbortError' ? 'timeout' : fetchErr?.message || 'network error'}).`,
      credentialsDetected: true,
      documentation: 'https://docs.livepay.me/',
    });
  } finally {
    clearTimeout(timer);
  }
}
