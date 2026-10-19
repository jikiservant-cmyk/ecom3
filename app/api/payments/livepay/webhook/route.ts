import { NextRequest, NextResponse } from 'next/server';
import { getServerAdminClient } from '@/lib/server/supabaseServer';
import { getWebhookSecret, verifyLivePayWebhook, webhookUrlCandidates, DEFAULT_SIGNATURE_MAX_AGE_SECONDS } from '@/lib/server/webhook';
import {
  reconcilePaymentAmount,
  valueOrderAgainstCatalog,
  buildCatalogPriceIndex,
  ambiguousProductNames,
} from '@/lib/server/orders';
import { validatePricingSnapshot } from '@/lib/pricing';
import {
  cardRoundTripToleranceMinor,
  orderNumberFromReference,
  ugxMinorFromUsdMinor,
  usdMinorFromUgxMinor,
} from '@/lib/server/livepay';
import { logger } from '@/lib/server/logging';
import { ORDER_STATUS, PAYMENT_STATUS, PAYMENT_ROW_STATUS, normaliseOrderStatus } from '@/lib/status';

export const dynamic = 'force-dynamic';

/**
 * LivePay webhook receiver — implemented per https://docs.livepay.me/webhooks.
 *
 * Contract:
 * - POST, JSON body, header `X-Webhook-Signature: t=<ts>,v=<hex>`.
 * - Payload: { status, message, customer_reference, internal_reference,
 *   provider_transaction_id, msisdn, amount, currency, provider, charge,
 *   completed_at }  (status values like "Success").
 * - Must return 200 within 10s; LivePay retries failed deliveries 3x/30s.
 *
 * Security: HMAC verified BEFORE any state change; fails closed with no
 * secret. Idempotent per (internal_reference, normalized status). Amounts
 * are checked against the order total before marking Paid.
 */

const WEBHOOK_PATH = '/api/payments/livepay/webhook';

type Outcome = 'paid' | 'failed' | 'ignored';

function normalizeStatus(raw: unknown): Outcome {
  const s = String(raw ?? '').trim().toLowerCase();
  if (['success', 'successful', 'completed', 'paid'].includes(s)) return 'paid';
  if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(s)) return 'failed';
  return 'ignored';
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // 1. Configuration gate — fail closed.
  const secret = getWebhookSecret();
  if (!secret) {
    logger.error('webhook_rejected_no_secret');
    return NextResponse.json({ error: 'Webhook endpoint is not configured (missing webhook secret)' }, { status: 503 });
  }

  // 2. Parse payload (needed for signature input).
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }
  if (!payload || typeof payload !== 'object') {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  // 3. Signature verification (mandatory). Docs define exactly one header:
  //    X-Webhook-Signature: t=<unix-ts>,v=<hex hmac>.
  //    A replay window is enforced on `t` so a captured signature expires.
  const header = req.headers.get('x-webhook-signature');
  if (
    !verifyLivePayWebhook({
      payload,
      header,
      candidateWebhookUrls: webhookUrlCandidates(req),
      secret,
      maxAgeSeconds: DEFAULT_SIGNATURE_MAX_AGE_SECONDS,
    })
  ) {
    logger.warn('webhook_rejected_bad_signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const client = getServerAdminClient();
  if (!client) {
    logger.error('webhook_rejected_no_service_role');
    return NextResponse.json({ error: 'Webhook processing is not configured' }, { status: 503 });
  }

  const outcome = normalizeStatus(payload.status);
  const customerReference = typeof payload.customer_reference === 'string' ? payload.customer_reference.trim() : '';
  const internalReference = typeof payload.internal_reference === 'string' ? payload.internal_reference.trim() : '';
  // Idempotency key must identify THIS notification. Keying on internal_reference
  // alone collapsed every reference-less event onto one row, so the second real
  // payment was acked as a duplicate and its order was never marked Paid.
  const eventId = `${internalReference || 'noref'}|${customerReference || 'noref'}|${outcome}`;

  /**
   * Release the idempotency marker so the gateway can retry this notification.
   *
   * The marker is written before we know whether the payment is acceptable. If
   * we then REFUSE it (amount mismatch, unverifiable value) and leave the marker
   * in place, every later retry is swallowed as a duplicate and the order is
   * never marked Paid — the customer paid and never gets their goods.
   */
  const releaseEventMarker = async () => {
    try {
      await (client.from('payment_webhook_events') as any)
        .delete()
        .eq('event_id', eventId)
        .eq('provider', 'livepay');
    } catch (e: any) {
      logger.warn('webhook_event_marker_release_failed', { eventId, error: e?.message });
    }
  };

  // 4. Idempotency — insert AFTER verification, BEFORE state change. If this is
  //    a duplicate we ack and stop. (Insert-before-processing would swallow
  //    gateway retries of a failed first attempt.)
  try {
    const { error: evErr } = await (client.from('payment_webhook_events') as any).insert({
      provider: 'livepay',
      event_id: eventId,
      payload,
      processed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });
    if (evErr) {
      const msg = String(evErr.message || '');
      if (msg.includes('duplicate') || (evErr as any).code === '23505') {
        logger.info('webhook_duplicate_ignored', { eventId });
        return NextResponse.json({ received: true, duplicate: true });
      }
      logger.warn('webhook_event_insert_error', { error: msg }); // non-fatal
    }
  } catch (e: any) {
    logger.warn('webhook_event_insert_exception', { error: e?.message });
  }

  // 5. Non-terminal status: acknowledge without state change.
  if (outcome === 'ignored') {
    logger.info('webhook_non_terminal', { status: String(payload.status), customerReference });
    return NextResponse.json({ received: true, status: 'ignored' });
  }

  // 6. Resolve the order.
  //
  //    Two references exist: collect-money uses the stable `ORD` + order_number,
  //    while card checkout appends a per-attempt suffix (LivePay rejects a
  //    reused reference). The payment row records the exact reference we sent,
  //    so look that up FIRST — it also tells us the currency charged and the FX
  //    rate frozen at initiation, which the reconciliation below needs.
  const PAYMENT_COLUMNS =
    'id, order_id, provider_reference, amount_minor_units, currency, raw_payload, provider_transaction_id, created_at';

  /**
   * Find the payment row matching a reference. Tries every identifier the
   * gateway might echo:
   *   1. the reference WE sent           (payments.provider_reference)
   *   2. the gateway's transaction id    (payments.provider_transaction_id)
   *   3. the reference the gateway ASSIGNED (raw_payload.gateway_reference)
   * Ordered newest-first with limit(1): repeated Mobile Money attempts reuse one
   * reference, so the column is not unique and `maybeSingle()` would error.
   */
  const findPayment = async (ref: string): Promise<any | null> => {
    if (!ref) return null;
    const attempts: [string, boolean][] = [
      ['provider_reference', false],
      ['provider_transaction_id', false],
      ['raw_payload->>gateway_reference', true],
    ];
    for (const [column, isJson] of attempts) {
      try {
        let query = (client.from('payments') as any)
          .select(PAYMENT_COLUMNS)
          .eq('provider', 'livepay');
        query = isJson ? query.filter(column, 'eq', ref) : query.eq(column, ref);
        const { data, error } = await query.order('created_at', { ascending: false }).limit(1);
        if (error) {
          logger.warn('webhook_payment_lookup_error', { column, error: error.message });
          continue;
        }
        const row = Array.isArray(data) ? data[0] : data;
        if (row) return row;
      } catch (e: any) {
        logger.warn('webhook_payment_lookup_exception', { column, error: e?.message });
      }
    }
    return null;
  };

  const paymentRecord = await findPayment(customerReference);

  const orderNumberGuess = orderNumberFromReference(customerReference);
  const ORDER_COLUMNS =
    'id, order_number, status, payment_status, currency, total_minor_units, ' +
    'subtotal_minor_units, discount_minor_units, shipping_minor_units, ' +
    'refunded_minor_units, pricing_snapshot';

  let order: any = null;
  try {
    if (paymentRecord?.order_id) {
      const { data } = await (client.from('orders') as any)
        .select(ORDER_COLUMNS)
        .eq('id', paymentRecord.order_id)
        .maybeSingle();
      order = data || null;
    }
    if (!order && orderNumberGuess) {
      const { data } = await (client.from('orders') as any)
        .select(ORDER_COLUMNS)
        .eq('order_number', orderNumberGuess)
        .maybeSingle();
      order = data || null;
    }
  } catch (e: any) {
    logger.error('webhook_order_lookup_error', { error: e?.message });
  }
  if (!order) {
    logger.warn('webhook_order_not_found', { customerReference, internalReference });
    // Acknowledge (retrying cannot conjure the order) BUT release the marker:
    // if the order becomes visible later — replication lag, a slow insert, an
    // admin creating it — the gateway's retry must still be able to mark it
    // Paid. Keeping the marker here swallowed real payments.
    await releaseEventMarker();
    return NextResponse.json({ received: true, matched: false });
  }

  // A refunded order is terminal. A late "Success" for money already returned is
  // an accounting event for the admin, not a licence to re-mark it Paid.
  if (String(order.payment_status || '').toLowerCase() === 'refunded') {
    logger.warn('webhook_refunded_order_ignored', { orderId: order.id, outcome });
    return NextResponse.json({ received: true, ignored: 'order refunded' });
  }

  // 7. Amount & currency reconciliation — never mark Paid on a mismatch.
  //    LivePay's signature does NOT cover `amount`, so this is the only defence
  //    against a validly-signed notification carrying a tampered amount.
  const orderTotalMinor = Number(order.total_minor_units);

  // Card settlements arrive in USD; mobile-money settlements in UGX. Reconcile
  // in the currency that was actually charged, and cross-check the USD figure
  // against the order total using the FX rate frozen on the payment row — a
  // tampered payments row cannot lower the bar on its own.
  const isCardSettlement =
    Boolean(paymentRecord) && String(paymentRecord?.currency || '').toUpperCase() === 'USD';
  const fxRate = isCardSettlement ? Number(paymentRecord?.raw_payload?.fx?.ugx_per_usd) : NaN;

  let expectedMinor: number = orderTotalMinor;
  let expectedCurrency = String(order.currency || 'UGX').toUpperCase();

  if (isCardSettlement) {
    const recordedMinor = Number(paymentRecord?.amount_minor_units);
    const derivedMinor = usdMinorFromUgxMinor(orderTotalMinor, fxRate);
    if (derivedMinor === null || derivedMinor !== recordedMinor) {
      logger.error('webhook_card_fx_inconsistent', {
        orderId: order.id,
        recordedMinor,
        derivedMinor,
        fxRate,
        orderTotalMinor,
      });
      await releaseEventMarker();
      return NextResponse.json({ received: true, verified: false, reason: 'card fx inconsistent' });
    }
    expectedMinor = derivedMinor;
    expectedCurrency = 'USD';
  }

  const reconciliation = reconcilePaymentAmount({
    orderTotalMinorUnits: expectedMinor,
    orderCurrency: expectedCurrency,
    payloadAmount: payload.amount,
    payloadCurrency: payload.currency,
  });
  const { amountOk, currencyOk, paidMinor } = reconciliation;

  // Express the settlement in the shop's ledger currency (UGX) for every value
  // check. The card rounding envelope is at most one US cent — any larger
  // difference is a real underpayment and must still fail closed.
  const paidOrderMinor = isCardSettlement ? ugxMinorFromUsdMinor(paidMinor, fxRate) ?? 0 : paidMinor;
  const valuationTolerance = isCardSettlement ? cardRoundTripToleranceMinor(fxRate) : 0;

  if (outcome === 'paid' && (!amountOk || !currencyOk)) {
    logger.error('webhook_amount_mismatch', {
      orderId: order.id,
      expectedMinor,
      paidMinor,
      orderCurrency: order.currency,
      payloadCurrency: payload.currency,
    });
    // Record but do NOT mark paid — admin reconciles via the portal. Release the
    // marker so a corrected payment can still be processed on retry.
    await releaseEventMarker();
    return NextResponse.json({ received: true, verified: false, reason: 'amount mismatch' });
  }

  // 7b. FINANCIAL INTEGRITY: the reconciliation above only proves the gateway
  //     paid what the ORDER ROW says it costs. Validate the row itself:
  //     - snapshot orders: the immutable pricing basis recorded at checkout is
  //       re-checked for internal consistency (a forged snapshot cannot claim a
  //       total lower than its own lines), and the paid amount must cover it;
  //     - legacy orders: re-derive from the live catalog (name-keyed, so an
  //       ambiguous name is refused rather than priced nondeterministically).
  if (outcome === 'paid') {
    try {
      if (order.pricing_snapshot) {
        const validation = validatePricingSnapshot({
          snapshot: order.pricing_snapshot,
          storedSubtotalMinorUnits: order.subtotal_minor_units,
          storedDiscountMinorUnits: order.discount_minor_units,
          storedShippingMinorUnits: order.shipping_minor_units,
          storedTotalMinorUnits: orderTotalMinor,
        });
        if (!validation.ok || paidOrderMinor + valuationTolerance < validation.totalMinorUnits) {
          logger.error('webhook_snapshot_invalid', {
            orderId: order.id,
            reason: validation.reason,
            paidMinor,
            paidOrderMinor,
            storedTotalMinor: orderTotalMinor,
          });
          await releaseEventMarker();
          return NextResponse.json({ received: true, verified: false, reason: 'pricing snapshot invalid' });
        }
      } else {
        const { data: orderItems } = await (client.from('order_items') as any)
          .select('product_id, product_name, quantity')
          .eq('order_id', order.id);

        const productNames: string[] = [
          ...new Set<string>((orderItems || []).map((it: any) => String(it?.product_name || '')).filter(Boolean)),
        ];
        const { data: catalogRows } = await (client.from('products') as any)
          .select('id, name, status, product_variants ( price_minor_units, position, status )')
          .in('name', productNames);

        const ambiguous = ambiguousProductNames(catalogRows || []);
        if (productNames.some((n) => ambiguous.has(n))) {
          logger.error('webhook_ambiguous_product_name', { orderId: order.id, productNames });
          await releaseEventMarker();
          return NextResponse.json({ received: true, verified: false, reason: 'ambiguous product name' });
        }

        const valuation = valueOrderAgainstCatalog({
          items: (orderItems || []).map((it: any) => ({
            productId: it?.product_id ? String(it.product_id) : null,
            productName: String(it?.product_name || ''),
            quantity: Number(it?.quantity) || 0,
          })),
          prices: buildCatalogPriceIndex(catalogRows || []),
          storedTotalMinorUnits: expectedMinor,
        });

        if (!valuation.ok || paidOrderMinor + valuationTolerance < valuation.catalogTotalMinor) {
          logger.error('webhook_amount_below_catalog_value', {
            orderId: order.id,
            paidMinor,
            paidOrderMinor,
            storedTotalMinor: orderTotalMinor,
            catalogTotalMinor: valuation.catalogTotalMinor,
            unknownItems: valuation.unknownItems,
          });
          await releaseEventMarker();
          return NextResponse.json({ received: true, verified: false, reason: 'amount below catalog value' });
        }
      }
    } catch (e: any) {
      // Fail closed: never mark an order Paid when its value cannot be verified.
      logger.error('webhook_catalog_valuation_error', { orderId: order.id, error: e?.message });
      await releaseEventMarker();
      return NextResponse.json({ received: true, verified: false, reason: 'valuation unavailable' });
    }
  }

  // 7c. MONOTONIC STATE. A Paid order can never go back to Failed. A failure
  //     notification that arrives after the success is a stale/duplicate event,
  //     not new information. (The DB trigger enforces this too.)
  if (outcome === 'failed' && String(order.payment_status || '').toLowerCase() === 'paid') {
    logger.warn('webhook_late_failure_ignored', { orderId: order.id, internalReference });
    return NextResponse.json({ received: true, ignored: 'order already paid' });
  }
  if (outcome === 'failed' && String(order.status || '').toLowerCase() === 'cancelled') {
    logger.info('webhook_failure_on_cancelled_order', { orderId: order.id });
    return NextResponse.json({ received: true, ignored: 'order cancelled' });
  }
  // Money collected for an order that was cancelled in the meantime must be
  // reconciled by a human — do not silently mark it Paid (goods are not going
  // out) and do not silently drop it either.
  if (outcome === 'paid' && String(order.status || '').toLowerCase() === 'cancelled') {
    logger.error('webhook_paid_cancelled_order', {
      orderId: order.id,
      paidMinor,
      internalReference,
      action: 'manual reconciliation required (refund or reinstate)',
    });
    await releaseEventMarker();
    return NextResponse.json({ received: true, verified: false, reason: 'order cancelled' });
  }

  // 8. Apply the terminal state.
  const now = new Date().toISOString();
  try {
    // Record what the gateway actually collected (amount, fee, net, provider
    // transaction id). Before this, `payments` only ever held the REQUESTED
    // amount, so the ledger could never be reconciled against a settlement.
    const chargeRaw = payload.charge;
    const chargeMinor =
      chargeRaw === undefined || chargeRaw === null || chargeRaw === ''
        ? 0
        : Math.round(Number(chargeRaw) * 100);
    const feeMinor = Number.isFinite(chargeMinor) && chargeMinor > 0 ? chargeMinor : 0;
    // Ledger columns are always in the shop currency (UGX) so revenue totals
    // stay additive; the gateway-currency amount lives in `raw_payload` and in
    // `amount_minor_units` (which is expressed in this row's `currency`).
    const feeOrderMinor = isCardSettlement
      ? Math.round((feeMinor / 100) * (Number.isFinite(fxRate) ? fxRate : 0) * 100)
      : feeMinor;
    const settledMinor = outcome === 'paid' ? paidOrderMinor : 0;

    let paymentsQuery = (client.from('payments') as any).update({
      status: outcome === 'paid' ? PAYMENT_ROW_STATUS.paid : PAYMENT_ROW_STATUS.failed,
      provider_reference: customerReference || undefined,
      provider_transaction_id: typeof payload.provider_transaction_id === 'string' ? payload.provider_transaction_id : null,
      settled_amount_minor_units: settledMinor,
      fee_minor_units: feeOrderMinor,
      net_amount_minor_units: settledMinor - feeOrderMinor,
      settled_at: outcome === 'paid' ? now : null,
      raw_payload: payload,
      updated_at: now,
    })
      .eq('order_id', order.id)
      .eq('provider', 'livepay');
    if (customerReference) {
      paymentsQuery = paymentsQuery.eq('provider_reference', customerReference);
    }
    await paymentsQuery;

    const orderUpdate: Record<string, unknown> = { updated_at: now };
    if (outcome === 'paid') {
      orderUpdate.payment_status = PAYMENT_STATUS.paid;
      // Never drag an order backwards: a late duplicate settlement must not
      // move a shipped or delivered order back to `processing`.
      if (normaliseOrderStatus(order.status) === ORDER_STATUS.pending) {
        orderUpdate.status = ORDER_STATUS.processing;
      }
    } else {
      orderUpdate.payment_status = PAYMENT_STATUS.failed;
    }
    const { error: upErr } = await (client.from('orders') as any).update(orderUpdate).eq('id', order.id);
    if (upErr) {
      logger.error('webhook_order_update_error', { error: upErr.message, orderId: order.id });
      // 500 => LivePay retries (up to 3x); delete the marker so the retry is not
      // swallowed as a duplicate.
      await releaseEventMarker();
      return NextResponse.json({ error: 'Order update failed' }, { status: 500 });
    }

    logger.info('webhook_processed', {
      orderId: order.id,
      outcome,
      amountMinor: paidMinor,
      internalReference,
    });
    return NextResponse.json({ received: true });
  } catch (e: any) {
    logger.error('webhook_processing_exception', { error: e?.message });
    await releaseEventMarker();
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}

export { WEBHOOK_PATH };
