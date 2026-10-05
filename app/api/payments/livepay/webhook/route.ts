import { NextRequest, NextResponse } from 'next/server';
import { getServerAdminClient } from '@/lib/server/supabaseServer';
import { getWebhookSecret, verifyLivePayWebhook, webhookUrlCandidates, DEFAULT_SIGNATURE_MAX_AGE_SECONDS } from '@/lib/server/webhook';
import { reconcilePaymentAmount, valueOrderAgainstCatalog, buildCatalogPriceIndex } from '@/lib/server/orders';
import { logger } from '@/lib/server/logging';

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

  // 6. Resolve the order from customer_reference ("ORD" + order_number).
  //    Order numbers are generated uppercase; the gateway may normalise case,
  //    so compare case-insensitively rather than trusting the echoed string.
  let orderNumberGuess = '';
  if (customerReference.toUpperCase().startsWith('ORD')) {
    orderNumberGuess = customerReference.slice(3).trim().toUpperCase();
  }
  let order: any = null;
  if (orderNumberGuess) {
    try {
      const { data } = await (client.from('orders') as any)
        .select('id, order_number, payment_status, total_amount, total_minor_units, currency')
        .eq('order_number', orderNumberGuess)
        .maybeSingle();
      order = data;
    } catch (e: any) {
      logger.error('webhook_order_lookup_error', { error: e?.message });
    }
  }
  if (!order) {
    logger.warn('webhook_order_not_found', { customerReference, internalReference });
    // Acknowledge: retrying cannot fix an unknown reference.
    return NextResponse.json({ received: true, matched: false });
  }

  // 7. Amount & currency reconciliation — never mark Paid on a mismatch.
  //    LivePay's signature does NOT cover `amount`, so this is the only defence
  //    against a validly-signed notification carrying a tampered amount.
  const { amountOk, currencyOk, expectedMinor, paidMinor } = reconcilePaymentAmount({
    orderTotalAmount: order.total_amount,
    orderTotalMinorUnits: order.total_minor_units,
    orderCurrency: order.currency,
    payloadAmount: payload.amount,
    payloadCurrency: payload.currency,
  });

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
  //     paid what the ORDER ROW says it costs. The row itself is insertable by
  //     anon, and the guard triggers police `payment_status` only — never the
  //     total. Re-derive the value from the catalog so a forged low total can
  //     never be marked Paid.
  if (outcome === 'paid') {
    try {
      const { data: orderItems } = await (client.from('order_items') as any)
        .select('product_name, quantity')
        .eq('order_id', order.id);

      const productNames = [...new Set((orderItems || []).map((it: any) => String(it?.product_name || '')).filter(Boolean))];
      const { data: catalogRows } = await (client.from('products') as any)
        .select('id, name, status, product_variants ( price_minor_units, position, status )')
        .in('name', productNames);

      const valuation = valueOrderAgainstCatalog({
        items: (orderItems || []).map((it: any) => ({
          productName: String(it?.product_name || ''),
          quantity: Number(it?.quantity) || 0,
        })),
        prices: buildCatalogPriceIndex(catalogRows || []),
        storedTotalMinorUnits: expectedMinor,
      });

      if (!valuation.ok || paidMinor < valuation.catalogTotalMinor) {
        logger.error('webhook_amount_below_catalog_value', {
          orderId: order.id,
          paidMinor,
          storedTotalMinor: expectedMinor,
          catalogTotalMinor: valuation.catalogTotalMinor,
          unknownItems: valuation.unknownItems,
        });
        await releaseEventMarker();
        return NextResponse.json({ received: true, verified: false, reason: 'amount below catalog value' });
      }
    } catch (e: any) {
      // Fail closed: never mark an order Paid when its value cannot be verified.
      logger.error('webhook_catalog_valuation_error', { orderId: order.id, error: e?.message });
      await releaseEventMarker();
      return NextResponse.json({ received: true, verified: false, reason: 'valuation unavailable' });
    }
  }

  // 8. Apply the terminal state.
  const now = new Date().toISOString();
  try {
    // Scope the write to the LivePay attempt this notification refers to. An
    // unscoped update rewrote every payment row on the order, including rows
    // from earlier or unrelated attempts.
    let paymentsQuery = (client.from('payments') as any)
      .update({
        status: outcome === 'paid' ? 'success' : 'failed',
        provider_reference: customerReference || undefined,
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
      orderUpdate.payment_status = 'Paid';
      if (order.payment_status !== 'Paid') orderUpdate.status = 'Processing';
    } else {
      orderUpdate.payment_status = 'Failed';
    }
    const { error: upErr } = await (client.from('orders') as any).update(orderUpdate).eq('id', order.id);
    if (upErr) {
      logger.error('webhook_order_update_error', { error: upErr.message, orderId: order.id });
      // 500 => LivePay retries (up to 3x); event row already recorded, so the
      // retry will hit the duplicate path and be acked. To avoid that black
      // hole we delete the event marker on failure and surface 500.
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
