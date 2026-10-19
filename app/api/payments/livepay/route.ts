import { NextRequest, NextResponse } from 'next/server';
import { getServerAdminClient, authenticateRequest } from '@/lib/server/supabaseServer';
import { logger } from '@/lib/server/logging';
import { readJsonBody, isNonEmptyString, jsonError } from '@/lib/server/validation';
import { consumeRateLimit } from '@/lib/server/rateLimit';
import {
  safeReturnUrl,
  valueOrderAgainstCatalog,
  buildCatalogPriceIndex,
  ambiguousProductNames,
} from '@/lib/server/orders';
import { isWholeShillingMinor, validatePricingSnapshot } from '@/lib/pricing';
import {
  CARD_MAX_MINOR,
  CARD_MIN_MINOR,
  CARD_PATH,
  COLLECT_PATH,
  COLLECT_RATE_LIMIT,
  CARD_RATE_LIMIT,
  RATE_LIMIT_WINDOW_MS,
  buildCardReference,
  buildCardReturnUrl,
  buildCollectReference,
  getCardConfig,
  getCollectConfig,
  isTrustedCheckoutUrl,
  usdMinorFromUgxMinor,
} from '@/lib/server/livepay';

export const dynamic = 'force-dynamic';

/**
 * Initiate a LivePay payment for an existing order.
 *
 * Two documented products, chosen by the order's own `payment_method`:
 *
 * - `momo`  → POST /collect-money   (https://docs.livepay.me/request-money)
 *             pushes a prompt to the customer's handset; settled by webhook.
 * - `card`  → POST /card-collection (https://docs.livepay.me/card-collection)
 *             returns a hosted `checkout_url`; the browser is redirected and
 *             the customer returns via `return_url?checkout_id=…`.
 * - `cod`   → nothing to charge now.
 *
 * Hard rules, both products:
 * - The order MUST exist; the amount charged is derived from the DATABASE row,
 *   never from the request body.
 * - `reference` is unique, space-free and ≤30 chars (`ORD` + order number, with
 *   a per-attempt suffix for card because LivePay rejects a reused reference).
 * - No credentials / gateway failure => HTTP error. There is NO simulated
 *   success fallback — an order is marked Paid only by a verified webhook.
 * - A gateway-supplied `checkout_url` is only ever returned if it is on a
 *   LivePay host (open-redirect guard).
 */

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

function tooMany(error: string, retryAfterMs?: number) {
  return NextResponse.json(
    { success: false, error },
    {
      status: 429,
      ...(retryAfterMs ? { headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } } : {}),
    }
  );
}

async function initiateCard(opts: {
  req: NextRequest;
  order: any;
  totalMinorUnits: number;
}): Promise<Response> {
  const { order } = opts;

  // Card credentials are a separate, dot-separated key pair per the docs.
  const gateway = getCardConfig();
  if (!gateway) {
    logger.error('livepay_card_not_configured');
    return jsonError('Card payments are not configured. Please choose Mobile Money or Cash on Delivery.', 503);
  }

  // Card collection is USD-only. The shop prices in UGX, so an operator-set
  // rate is the single conversion source — never a client-supplied amount.
  const rate = Number(process.env.LIVEPAY_USD_RATE_UGX);
  const usdMinor = usdMinorFromUgxMinor(opts.totalMinorUnits, rate);
  if (usdMinor === null) {
    logger.error('livepay_card_amount_out_of_bounds', {
      orderId: order.id,
      totalMinorUnits: opts.totalMinorUnits,
      rateConfigured: Number.isFinite(rate) && rate > 0,
    });
    return jsonError(
      'This order cannot be paid by card right now. Please choose Mobile Money or Cash on Delivery.',
      422
    );
  }
  if (usdMinor < CARD_MIN_MINOR || usdMinor > CARD_MAX_MINOR) {
    return jsonError('This amount is outside the card gateway limits.', 422);
  }

  const email = String(order.customer_email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    logger.warn('livepay_card_missing_email', { orderId: order.id });
    return jsonError('An email address is required for card payments. Please add one and try again.', 400);
  }

  const appUrl = process.env.APP_URL;
  const returnUrl = appUrl ? buildCardReturnUrl(appUrl, String(order.order_number)) : null;
  if (!returnUrl) {
    logger.error('livepay_card_return_url_unavailable', { orderId: order.id });
    return jsonError('Card payments are not configured. Please choose Mobile Money or Cash on Delivery.', 503);
  }

  const now = Date.now().toString(36);
  const nonce = `${now}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
  const reference = buildCardReference(String(order.order_number), nonce);

  const payload = {
    accountNumber: gateway.accountNumber,
    amount: usdMinor / 100, // USD, two decimals
    currency: 'USD',
    reference,
    email,
    description: `Order #${order.order_number}`,
    return_url: returnUrl,
  };

  // Record the attempt BEFORE calling out: this row is what the webhook
  // reconciles against, and it freezes the FX rate that was quoted.
  try {
    await (getServerAdminClient() as any)
      .from('payments')
      .insert({
        order_id: order.id,
        provider: 'livepay',
        provider_reference: reference,
        status: 'pending',
        amount_minor_units: usdMinor,
        currency: 'USD',
        raw_payload: {
          method: 'card',
          initiated_at: new Date().toISOString(),
          fx: { ugx_per_usd: rate, ugx_minor: opts.totalMinorUnits, usd_minor: usdMinor },
          return_url: returnUrl,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
  } catch (e: any) {
    // The card still works, but refuse: without the FX-frozen payment row the
    // webhook cannot verify what was charged, so the order could never be
    // settled safely. Failing here is the money-safe choice.
    logger.error('livepay_card_payment_record_error', { orderId: order.id, error: e?.message });
    return jsonError('Card payment could not be started. You have not been charged. Please try again.', 500);
  }

  try {
    const response = await fetchWithTimeout(`${gateway.baseUrl}${CARD_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gateway.apiKey}` },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));

    if (response.ok) {
      if (!isTrustedCheckoutUrl(data?.checkout_url)) {
        logger.error('livepay_card_untrusted_checkout_url', {
          orderId: order.id,
          received: typeof data?.checkout_url === 'string' ? data.checkout_url.slice(0, 120) : typeof data?.checkout_url,
        });
        return jsonError('The card gateway returned an invalid checkout link. You have not been charged.', 502);
      }
      const internalReference =
        typeof data?.internal_reference === 'string' ? data.internal_reference : null;
      if (internalReference) {
        await (getServerAdminClient() as any)
          .from('payments')
          .update({ provider_transaction_id: internalReference, updated_at: new Date().toISOString() })
          .eq('order_id', order.id)
          .eq('provider_reference', reference);
      }
      logger.info('livepay_card_checkout_created', {
        orderId: order.id,
        orderNumber: order.order_number,
        reference,
        usdMinor,
        rate,
      });
      return NextResponse.json({
        success: true,
        method: 'card',
        checkoutUrl: data.checkout_url,
        reference: data.reference || reference,
        amountMinorUnits: usdMinor,
        amountUsd: usdMinor / 100,
        currency: 'USD',
        message: 'Redirecting you to LivePay’s secure card checkout.',
        returnUrl,
      });
    }

    const errMsg = String(data?.error || data?.message || '').slice(0, 300);
    logger.error('livepay_card_rejected', { status: response.status, orderId: order.id, error: errMsg });

    if (response.status === 400) {
      return jsonError(
        errMsg ? `Card payment could not be started: ${errMsg}` : 'Card payment could not be started. You have not been charged.',
        400
      );
    }
    if (response.status === 429) {
      return tooMany('The card gateway is busy right now. Please try again in a few minutes.');
    }
    return jsonError(
      'The card gateway rejected the request. You have not been charged — please try another payment method.',
      502
    );
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    logger.error('livepay_card_gateway_error', { orderId: order.id, aborted, error: e?.message });
    return jsonError(
      aborted
        ? 'The card gateway took too long to respond. No payment was taken — please try again.'
        : 'Could not reach the card gateway. You have not been charged. Please try again.',
      502
    );
  }
}

export async function POST(req: NextRequest) {
  const body = await readJsonBody(req);
  if (!body) return jsonError('Invalid JSON body', 400);

  const orderId = isNonEmptyString(body.orderId, 64) ? body.orderId.trim() : null;
  if (!orderId) return jsonError('orderId is required', 400);

  // The client may state which product it is starting; anything else is a
  // programming error or a probe, and must not reach a gateway call.
  const methodHint = isNonEmptyString(body.paymentMethod, 16) ? body.paymentMethod.trim().toLowerCase() : null;
  if (methodHint && methodHint !== 'momo' && methodHint !== 'card') {
    return jsonError('This order cannot be paid with that method.', 400);
  }

  // Optional post-payment landing URL for the momo flow. Validated against
  // APP_URL so a client cannot use us to bounce a victim to a phishing origin.
  const safeReturn = safeReturnUrl(
    isNonEmptyString(body.returnUrl, 500) ? body.returnUrl.trim() : null,
    process.env.APP_URL
  );

  const phoneNumber = isNonEmptyString(body.phoneNumber, 32) ? body.phoneNumber.replace(/[^\d+]/g, '') : '';

  // Any configured product is enough to accept the request; the per-product
  // check below decides whether THIS order can proceed.
  if (!getCollectConfig() && !getCardConfig()) {
    logger.error('livepay_not_configured');
    return jsonError('Payment gateway is not configured. Please try another payment method or contact support.', 503);
  }

  const client = getServerAdminClient();
  if (!client) return jsonError('Payments are not configured on the server', 503);

  // 1. Load the order from the database — the ONLY source of truth for amounts.
  let order: any = null;
  try {
    const { data, error } = await (client.from('orders') as any)
      .select(
        'id, order_number, customer_id, customer_name, customer_email, customer_phone, ' +
          'status, payment_method, payment_status, subtotal_minor_units, discount_minor_units, ' +
          'shipping_minor_units, total_minor_units, refunded_minor_units, currency, pricing_snapshot'
      )
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

  // 1a. STATE GATES. Only an unpaid, non-terminal, gateway-paid order may be
  //     charged. Without these, a Cancelled order could be paid (silently
  //     un-cancelling it), a Refunded order could be charged again, and a COD
  //     order could be paid online while the courier also collects cash.
  const paymentStatus = String(order.payment_status || '').toLowerCase();
  const orderStatus = String(order.status || '').toLowerCase();
  const orderMethod = String(order.payment_method || 'momo').toLowerCase();

  if (orderMethod !== 'momo' && orderMethod !== 'card') {
    return jsonError('This order is set to pay on delivery, so there is nothing to charge now.', 409);
  }
  if (methodHint && methodHint !== orderMethod) {
    return jsonError('This order is set to a different payment method. Please place a new order.', 409);
  }

  if (paymentStatus === 'paid') return jsonError('This order has already been paid', 409);
  if (paymentStatus === 'refunded') {
    return jsonError('This order has been refunded and cannot be paid again.', 409);
  }
  if (orderStatus === 'cancelled') {
    return jsonError('This order was cancelled. Please place a new order.', 409);
  }
  if (orderStatus === 'delivered' || orderStatus === 'shipped') {
    return jsonError('This order has already been dispatched. Please contact support.', 409);
  }
  if (Number(order.refunded_minor_units || 0) > 0) {
    return jsonError('This order already has a refund recorded against it. Please contact support.', 409);
  }

  // 1b. AMOUNT — one source of truth, and it must be a whole shilling so the
  //     amount we charge is exactly the amount the webhook will reconcile.
  const totalMinorUnits = Number(order.total_minor_units);
  if (!isWholeShillingMinor(totalMinorUnits) || totalMinorUnits <= 0) {
    logger.error('livepay_invalid_order_amount', { orderId, totalMinorUnits });
    return jsonError('Order has an invalid amount', 422);
  }

  // 1c. FINANCIAL INTEGRITY — the order must be worth what it says it is worth.
  //
  //     Orders written by this app carry an immutable `pricing_snapshot` taken
  //     at checkout; it is validated for internal consistency and against the
  //     stored columns. Orders created before snapshots existed fall back to
  //     re-pricing against the live catalog (legacy path).
  try {
    if (order.pricing_snapshot) {
      const validation = validatePricingSnapshot({
        snapshot: order.pricing_snapshot,
        storedSubtotalMinorUnits: order.subtotal_minor_units,
        storedDiscountMinorUnits: order.discount_minor_units,
        storedShippingMinorUnits: order.shipping_minor_units,
        storedTotalMinorUnits: totalMinorUnits,
      });
      if (!validation.ok) {
        logger.error('livepay_order_snapshot_invalid', {
          orderId,
          orderNumber: order.order_number,
          reason: validation.reason,
          storedTotalMinor: totalMinorUnits,
        });
        return jsonError('The total on this order could not be verified. Please place a new order.', 409);
      }
    } else {
      const { data: orderItems } = await (client.from('order_items') as any)
        .select('product_id, product_name, quantity, variant_sku')
        .eq('order_id', order.id);

      if (!Array.isArray(orderItems) || orderItems.length === 0) {
        logger.error('livepay_order_has_no_items', { orderId });
        return jsonError('This order has no items and cannot be paid.', 422);
      }

      const productNames = [...new Set(orderItems.map((it: any) => String(it?.product_name || '')).filter(Boolean))];
      const { data: catalogRows, error: catErr } = await (client.from('products') as any)
        .select('id, name, status, product_variants ( price_minor_units, position, status )')
        .in('name', productNames);
      if (catErr) {
        logger.error('livepay_catalog_lookup_error', { error: catErr.message });
        return jsonError('Payment could not be started', 500);
      }

      const ambiguous = ambiguousProductNames(catalogRows || []);
      const ambiguousUsed = productNames.filter((n) => ambiguous.has(n));
      if (ambiguousUsed.length > 0) {
        logger.error('livepay_ambiguous_product_name', { orderId, ambiguousUsed });
        return jsonError('This order could not be priced unambiguously. Please place a new order.', 409);
      }

      const valuation = valueOrderAgainstCatalog({
        items: orderItems.map((it: any) => ({
          productId: it?.product_id ? String(it.product_id) : null,
          productName: String(it?.product_name || ''),
          quantity: Number(it?.quantity) || 0,
        })),
        prices: buildCatalogPriceIndex(catalogRows || []),
        storedTotalMinorUnits: totalMinorUnits,
      });

      if (!valuation.ok) {
        logger.error('livepay_order_total_not_justified_by_catalog', {
          orderId,
          orderNumber: order.order_number,
          storedTotalMinor: totalMinorUnits,
          catalogTotalMinor: valuation.catalogTotalMinor,
          shortByMinor: valuation.shortByMinor,
          unknownItems: valuation.unknownItems,
        });
        return jsonError('The total on this order no longer matches our catalog. Please place a new order.', 409);
      }
    }
  } catch (e: any) {
    logger.error('livepay_order_valuation_exception', { orderId, error: e?.message });
    return jsonError('Payment could not be started', 500);
  }

  // Per-order cap. Without it a single actor can burn the shared merchant quota
  // — and spam a victim's phone with Mobile Money prompts — by hammering one
  // order, which denies payment to every other customer for the whole window.
  const perOrder = consumeRateLimit(`livepay-order:${order.id}`, RATE_LIMIT_WINDOW_MS, 3);
  if (!perOrder.allowed) {
    logger.warn('livepay_per_order_attempts_exhausted', { orderId });
    return tooMany('Too many payment attempts for this order. Please try again in a few minutes.', perOrder.resetMs);
  }

  // Merchant-level quota guard. LivePay documents a per-account limit (50/15min
  // for collections, 500/15min for cards); we stop short of it so a burst of
  // checkouts can never be the reason the gateway starts rejecting us.
  const quota = consumeRateLimit(
    `global:livepay-${orderMethod}`,
    RATE_LIMIT_WINDOW_MS,
    Math.floor((orderMethod === 'card' ? CARD_RATE_LIMIT : COLLECT_RATE_LIMIT) * 0.9)
  );
  if (!quota.allowed) {
    logger.warn('livepay_global_quota_exhausted', { method: orderMethod });
    return tooMany('The payment gateway is busy right now. Please try again in a few minutes.', quota.resetMs);
  }

  // ── Card: hosted checkout, redirect flow ──────────────────────────────────
  if (orderMethod === 'card') {
    return initiateCard({ req, order, totalMinorUnits });
  }

  // ── Mobile money: prompt on the handset ───────────────────────────────────
  const collectGateway = getCollectConfig();
  if (!collectGateway) {
    logger.error('livepay_collect_not_configured');
    return jsonError('Mobile Money payments are not configured. Please choose another payment method.', 503);
  }
  const gateway = collectGateway;

  // PHONE BINDING. Without this, anyone who learns an order id can push a
  // Mobile Money prompt at an arbitrary phone number (payment-prompt spam) or
  // attempt to collect from a third party. A caller may only use the number the
  // order was placed with, unless they are the signed-in owner.
  const normalisePhone = (value: unknown) => String(value ?? '').replace(/[^\d]/g, '');
  const orderPhone = normalisePhone(order.customer_phone);
  const requestedPhone = normalisePhone(phoneNumber);
  if (requestedPhone && orderPhone && requestedPhone !== orderPhone) {
    let isOwner = false;
    try {
      const requester = await authenticateRequest(req);
      isOwner = Boolean(requester?.userId && order.customer_id && requester.userId === order.customer_id);
    } catch {
      isOwner = false;
    }
    if (!isOwner) {
      logger.warn('livepay_phone_mismatch', { orderId });
      return jsonError('Use the phone number this order was placed with, or sign in to pay from another number.', 403);
    }
  }

  const effectivePhone = phoneNumber || (order.customer_phone || '').replace(/[^\d+]/g, '');
  if (!effectivePhone) {
    return jsonError('A mobile money phone number is required for this order.', 400);
  }

  // 2. Build the gateway request (docs.livepay.me/request-money shape).
  const transactionReference = buildCollectReference(String(order.order_number));
  const payload = {
    accountNumber: gateway.accountNumber,
    phoneNumber: effectivePhone,
    amount: totalMinorUnits / 100, // UGX is a zero-decimal-by-practice currency: whole shillings
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
      amount_minor_units: totalMinorUnits, // requested; settled_* is written by the webhook
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
    const response = await fetchWithTimeout(`${gateway.baseUrl}${COLLECT_PATH}`, {
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
        method: 'momo',
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
            method: 'momo',
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
