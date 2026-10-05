import { NextRequest, NextResponse } from 'next/server';
import { getServerAdminClient } from '@/lib/server/supabaseServer';
import { logger } from '@/lib/server/logging';
import { readJsonBody, isNonEmptyString, jsonError } from '@/lib/server/validation';
import { consumeRateLimit } from '@/lib/server/rateLimit';
import { safeReturnUrl } from '@/lib/server/orders';

export const dynamic = 'force-dynamic';

/**
 * Initiate a LivePay mobile-money collection for an existing order.
 * Implemented per https://docs.livepay.me (authentication + collect-money).
 *
 * Hard rules:
 * - The order MUST exist; the charged amount is read from the database.
 * - `reference` = "ORD" + order_number (max 30 chars, no spaces — required).
 * - LivePay has no documented card-collection endpoint: momo only.
 * - No credentials / gateway failure => HTTP error. There is NO simulated
 *   success fallback — an order is marked Paid only by a verified webhook.
 */

function getGatewayConfig(): { apiKey: string; accountNumber: string; baseUrl: string } | null {
  const apiKey = process.env.LIVEPAY_API_KEY;
  if (!apiKey || apiKey.includes('YOUR_')) return null;
  let baseUrl = (process.env.LIVEPAY_API_URL || 'https://livepay.me/api').replace(/\/+$/, '');
  try {
    const host = new URL(baseUrl).hostname;
    if (!/(^|\.)livepay\.me$/.test(host)) return null; // SSRF guard: LivePay hosts only
  } catch {
    return null;
  }
  return { apiKey, accountNumber: process.env.LIVEPAY_MERCHANT_ID || '', baseUrl };
}

const FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: NextRequest) {
  const body = await readJsonBody(req);
  if (!body) return jsonError('Invalid JSON body', 400);

  const orderId = isNonEmptyString(body.orderId, 64) ? body.orderId.trim() : null;
  if (!orderId) return jsonError('orderId is required', 400);

  if (isNonEmptyString(body.paymentMethod, 32) && body.paymentMethod !== 'momo') {
    // LivePay's documented API (docs.livepay.me) covers mobile money only.
    return jsonError('Only Mobile Money payments are supported by the gateway. Please choose Mobile Money at checkout.', 400);
  }

  // Optional post-payment landing URL. Validated against APP_URL so a client
  // cannot use us to bounce a victim to a phishing origin; anything off-origin
  // is dropped rather than echoed back.
  const safeReturn = safeReturnUrl(
    isNonEmptyString(body.returnUrl, 500) ? body.returnUrl.trim() : null,
    process.env.APP_URL
  );

  const phoneNumber = isNonEmptyString(body.phoneNumber, 32) ? body.phoneNumber.replace(/[^\d+]/g, '') : '';

  const gateway = getGatewayConfig();
  if (!gateway) {
    logger.error('livepay_not_configured');
    return jsonError('Payment gateway is not configured. Please try another payment method or contact support.', 503);
  }

  const client = getServerAdminClient();
  if (!client) return jsonError('Payments are not configured on the server', 503);

  // 1. Load the order from the database — the ONLY source of truth for amounts.
  let order: any = null;
  try {
    const { data, error } = await (client.from('orders') as any)
      .select('id, order_number, customer_name, customer_phone, total_minor_units, total_amount, currency, payment_status')
      .eq('id', orderId)
      .maybeSingle();
    if (error) {
      logger.error('livepay_order_lookup_error', { error: error.message });
      return jsonError('Payment could not be started', 500);
    }
    order = data;
  } catch (e: any) {
    logger.error('livepay_order_lookup_exception', { error: e?.message });
    return jsonError('Payment could not be started', 500);
  }

  if (!order) return jsonError('Order not found', 404);
  if (order.payment_status === 'Paid') return jsonError('This order has already been paid', 409);

  const amountUgx = Math.round(order.total_amount ? Number(order.total_amount) : Number(order.total_minor_units || 0) / 100);
  if (!(amountUgx > 0)) {
    logger.error('livepay_invalid_order_amount', { orderId });
    return jsonError('Order has an invalid amount', 422);
  }

  const effectivePhone = phoneNumber || (order.customer_phone || '').replace(/[^\d+]/g, '');
  if (!effectivePhone) {
    return jsonError('A mobile money phone number is required for this order.', 400);
  }

  // Merchant-level quota guard: LivePay rate-limits per merchant account
  // (documented: 50 req / 15 min on query APIs). Protect the shared quota
  // regardless of how many client IPs are hitting us.
  const quota = consumeRateLimit('global:livepay-collect', 15 * 60_000, 45);
  if (!quota.allowed) {
    logger.warn('livepay_global_quota_exhausted');
    return NextResponse.json(
      { success: false, error: 'The payment gateway is busy right now. Please try again in a few minutes.' },
      { status: 429 }
    );
  }

  // 2. Build the gateway request (docs.livepay.me/collect-money shape).
  const transactionReference = `ORD${order.order_number}`.replace(/\s+/g, '').substring(0, 30);
  const payload = {
    accountNumber: gateway.accountNumber,
    phoneNumber: effectivePhone,
    amount: amountUgx, // integer UGX
    currency: 'UGX',
    reference: transactionReference,
    description: `Order #${order.order_number}`,
  };

  // 3. Record the payment attempt BEFORE calling out (status pending).
  try {
    await (client.from('payments') as any).insert({
      order_id: order.id,
      provider: 'livepay',
      provider_reference: transactionReference,
      status: 'pending',
      amount_minor_units: amountUgx * 100,
      currency: 'UGX',
      raw_payload: { method: 'momo', initiated_at: new Date().toISOString() },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    logger.error('livepay_payment_record_error', { error: e?.message });
    // Continue: the payment row is a reconciliation aid, not a prerequisite.
  }

  // 4. Call the gateway. Fail closed on any error.
  try {
    const response = await fetchWithTimeout(`${gateway.baseUrl}/collect-money`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gateway.apiKey}` },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));

    if (response.ok && data?.success !== false) {
      // Persist the gateway's internal reference for reconciliation.
      if (data?.internal_reference) {
        await (client.from('payments') as any)
          .update({ raw_payload: data, updated_at: new Date().toISOString() })
          .eq('order_id', order.id)
          .eq('provider_reference', transactionReference);
      }
      logger.info('livepay_initiated', { orderId, orderNumber: order.order_number, reference: transactionReference });
      return NextResponse.json({
        success: true,
        transactionId: data.internal_reference || transactionReference,
        reference: data.reference || transactionReference,
        status: 'pending',
        message: data.message || 'Payment initiated. Please approve the Mobile Money prompt on your phone.',
        returnUrl: safeReturn,
      });
    }

    // Duplicate reference: a previous attempt may already be live (e.g. our
    // earlier fetch timed out after the gateway accepted it). Recover by
    // asking the gateway for the transaction status.
    const errMsg = String(data?.error || data?.message || '');
    if (response.status === 400 && /reference already used/i.test(errMsg)) {
      try {
        const statusUrl = `${gateway.baseUrl}/transaction-status?accountNumber=${encodeURIComponent(gateway.accountNumber)}&currency=UGX&reference=${encodeURIComponent(transactionReference)}`;
        const st = await fetchWithTimeout(statusUrl, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gateway.apiKey}` },
        });
        const stData = await st.json().catch(() => ({}));
        if (st.ok && stData) {
          logger.info('livepay_duplicate_reference_recovered', { orderId, status: stData.status });
          return NextResponse.json({
            success: true,
            transactionId: stData.internal_reference || transactionReference,
            reference: transactionReference,
            status: 'pending',
            message: 'A payment for this order is already in progress. Please approve the Mobile Money prompt on your phone.',
            gatewayStatus: stData.status,
            returnUrl: safeReturn,
          });
        }
      } catch (e: any) {
        logger.warn('livepay_status_recovery_failed', { error: e?.message });
      }
    }

    logger.error('livepay_gateway_rejected', { status: response.status, orderId, error: errMsg.slice(0, 300) });
    return NextResponse.json(
      { success: false, error: errMsg ? `The payment gateway rejected the request: ${errMsg}` : 'The payment gateway rejected the request. You have not been charged. Please try again.' },
      { status: 502 }
    );
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    logger.error('livepay_gateway_error', { orderId, aborted, error: e?.message });
    return NextResponse.json(
      {
        success: false,
        error: aborted
          ? 'The payment gateway took too long to respond. If you received a prompt, you can still approve it; otherwise try again.'
          : 'Could not reach the payment gateway. You have not been charged. Please try again.',
      },
      { status: 502 }
    );
  }
}
