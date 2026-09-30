import { NextRequest, NextResponse } from 'next/server';
import { getServerAdminClient } from '@/lib/server/supabaseServer';
import { logger } from '@/lib/server/logging';
import { readJsonBody, isNonEmptyString, jsonError } from '@/lib/server/validation';

export const dynamic = 'force-dynamic';

/**
 * Initiate a LivePay payment for an existing order.
 *
 * Hard rules:
 * - The order MUST exist in the database; the amount charged is read from the
 *   database (total_minor_units). Client-supplied amounts are ignored.
 * - No credentials / gateway failure => HTTP error. There is NO simulated
 *   success fallback — an order is only ever marked Paid by a verified webhook.
 */

function getGatewayConfig(): { apiKey: string; merchantId: string; baseUrl: string } | null {
  const apiKey = process.env.LIVEPAY_API_KEY;
  if (!apiKey || apiKey.includes('YOUR_')) return null;
  let baseUrl = (process.env.LIVEPAY_API_URL || 'https://livepay.me/api').replace(/\/+$/, '');
  try {
    const host = new URL(baseUrl).hostname;
    if (!/(^|\.)livepay\.me$/.test(host)) return null; // SSRF guard: LivePay hosts only
  } catch {
    return null;
  }
  return { apiKey, merchantId: process.env.LIVEPAY_MERCHANT_ID || '', baseUrl };
}

const FETCH_TIMEOUT_MS = 15_000;

export async function POST(req: NextRequest) {
  const body = await readJsonBody(req);
  if (!body) return jsonError('Invalid JSON body', 400);

  const orderId = isNonEmptyString(body.orderId, 64) ? body.orderId.trim() : null;
  if (!orderId) return jsonError('orderId is required', 400);
  const returnUrl = isNonEmptyString(body.returnUrl, 500) ? body.returnUrl.trim() : null;
  const phoneNumber = isNonEmptyString(body.phoneNumber, 32) ? body.phoneNumber.replace(/[^\d+]/g, '') : '';
  const paymentMethod = body.paymentMethod === 'card' ? 'card' : 'momo';

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
      .select('id, order_number, customer_name, customer_email, customer_phone, total_minor_units, total_amount, currency, payment_status, status')
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

  const amountMinorUnits = Number(order.total_minor_units || 0);
  const amount = order.total_amount ? Number(order.total_amount) : amountMinorUnits / 100;
  if (!(amount > 0)) {
    logger.error('livepay_invalid_order_amount', { orderId });
    return jsonError('Order has an invalid amount', 422);
  }

  // 2. Build the gateway request. Reference embeds the order number so the
  //    webhook can be correlated even if provider ids differ.
  const transactionReference = `ORD${order.order_number}`.replace(/\s+/g, '').substring(0, 30);
  const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
  const callbackUrl = `${appUrl}/api/payments/livepay/webhook`;

  let endpoint: string;
  let payload: Record<string, unknown>;
  if (paymentMethod === 'card') {
    endpoint = `${gateway.baseUrl}/card-collection`;
    payload = {
      accountNumber: gateway.merchantId,
      amount: Number(amount),
      currency: 'USD',
      reference: transactionReference,
      email: order.customer_email,
      name: order.customer_name,
      description: `Order #${order.order_number}`,
      return_url: returnUrl || (appUrl ? `${appUrl}/?order=${order.order_number}&status=completed` : undefined),
    };
  } else {
    endpoint = `${gateway.baseUrl}/collect-money`;
    payload = {
      accountNumber: gateway.merchantId,
      phoneNumber: phoneNumber || order.customer_phone || '',
      amount: Number(amount),
      currency: (order.currency || 'UGX').toUpperCase(),
      reference: transactionReference,
      description: `Order #${order.order_number}`,
    };
  }

  // 3. Record the payment attempt BEFORE calling out (status pending).
  try {
    await (client.from('payments') as any).insert({
      order_id: order.id,
      provider: 'livepay',
      provider_reference: transactionReference,
      status: 'pending',
      amount_minor_units: amountMinorUnits,
      currency: order.currency || 'UGX',
      raw_payload: { method: paymentMethod, initiated_at: new Date().toISOString() },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    logger.error('livepay_payment_record_error', { error: e?.message });
    // Continue: the payment row is reconciliation aid, not a prerequisite.
  }

  // 4. Call the gateway with an explicit timeout. Fail closed on any error.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${gateway.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      logger.error('livepay_gateway_rejected', { status: response.status, orderId, bodyPreview: errText.slice(0, 300) });
      return NextResponse.json(
        { success: false, error: 'The payment gateway rejected the request. You have not been charged. Please try again.' },
        { status: 502 }
      );
    }

    const data = await response.json().catch(() => ({}));
    logger.info('livepay_initiated', { orderId, orderNumber: order.order_number, reference: transactionReference });
    return NextResponse.json({
      success: true,
      transactionId: data.internal_reference || transactionReference,
      reference: data.reference || transactionReference,
      status: 'pending',
      checkoutUrl: data.checkout_url || null,
      callbackUrl,
      message: data.message || 'Payment initiated. Please complete the prompt to pay.',
    });
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    logger.error('livepay_gateway_error', { orderId, aborted, error: e?.message });
    return NextResponse.json(
      {
        success: false,
        error: aborted
          ? 'The payment gateway took too long to respond. You have not been charged. Please try again.'
          : 'Could not reach the payment gateway. You have not been charged. Please try again.',
      },
      { status: 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}
