import { NextRequest, NextResponse } from 'next/server';
import { getServerAdminClient } from '@/lib/server/supabaseServer';
import { getWebhookSecret, verifyLivePaySignature } from '@/lib/server/webhook';
import { logger } from '@/lib/server/logging';

export const dynamic = 'force-dynamic';

/**
 * LivePay webhook receiver.
 *
 * Security:
 * - FAILS CLOSED: if LIVEPAY_WEBHOOK_SECRET is not configured, every call is
 *   rejected with 503. Signatures are verified with HMAC-SHA256 + constant-time
 *   compare before ANY state change.
 * - Idempotent: duplicate event ids return early (recorded in
 *   payment_webhook_events with a unique event_id).
 * - Privileged writes use the service-role client only.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // 1. Signature verification — mandatory.
  const secret = getWebhookSecret();
  if (!secret) {
    logger.error('webhook_rejected_no_secret');
    return NextResponse.json(
      { error: 'Webhook endpoint is not configured (missing webhook secret)' },
      { status: 503 }
    );
  }
  const signature = req.headers.get('x-livepay-signature');
  if (!verifyLivePaySignature(rawBody, signature, secret)) {
    logger.warn('webhook_rejected_bad_signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // 2. Parse payload.
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const client = getServerAdminClient();
  if (!client) {
    logger.error('webhook_rejected_no_service_role');
    return NextResponse.json({ error: 'Webhook processing is not configured' }, { status: 503 });
  }

  const event = typeof payload?.event === 'string' ? payload.event : 'unknown';
  const data = payload?.data || {};
  const eventId: string =
    (typeof data.event_id === 'string' && data.event_id) ||
    (typeof data.transaction_id === 'string' && data.transaction_id) ||
    (typeof payload?.id === 'string' && payload.id) ||
    '';

  if (!eventId) {
    logger.warn('webhook_missing_event_id');
    return NextResponse.json({ error: 'Missing event id' }, { status: 400 });
  }

  // 3. Idempotency: insert the event; if it already exists, stop processing.
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
      logger.warn('webhook_event_insert_error', { error: msg });
      // Non-fatal: continue processing even if the log table is unavailable.
    }
  } catch (e: any) {
    logger.warn('webhook_event_insert_exception', { error: e?.message });
  }

  // 4. Resolve the order: by order id (uuid) or by order number embedded in the
  //    transaction reference ("ORD{order_number}").
  const isSuccess = data?.status === 'successful' || data?.status === 'completed';
  const explicitOrderId = typeof data?.order_id === 'string' ? data.order_id : null;
  let reference = typeof data?.reference === 'string' ? data.reference : '';
  let orderNumberGuess = '';
  if (reference.toUpperCase().startsWith('ORD')) orderNumberGuess = reference.slice(3);

  let order: any = null;
  try {
    if (explicitOrderId && /^[0-9a-f-]{36}$/i.test(explicitOrderId)) {
      const { data: byId } = await (client.from('orders') as any)
        .select('id, order_number, payment_status')
        .eq('id', explicitOrderId)
        .maybeSingle();
      order = byId;
    }
    if (!order && orderNumberGuess) {
      const { data: byNumber } = await (client.from('orders') as any)
        .select('id, order_number, payment_status')
        .eq('order_number', orderNumberGuess)
        .maybeSingle();
      order = byNumber;
    }
  } catch (e: any) {
    logger.error('webhook_order_lookup_error', { error: e?.message });
  }

  if (!order) {
    logger.warn('webhook_order_not_found', { eventId, explicitOrderId, orderNumberGuess });
    // Acknowledge: we recorded the event; retrying won't help for unknown orders.
    return NextResponse.json({ received: true, matched: false });
  }

  // 5. Apply the state change.
  const now = new Date().toISOString();
  try {
    await (client.from('payments') as any)
      .update({ status: isSuccess ? 'success' : 'pending', raw_payload: payload, updated_at: now })
      .eq('order_id', order.id);

    const orderUpdate: Record<string, unknown> = { updated_at: now };
    if (isSuccess) {
      orderUpdate.payment_status = 'Paid';
      if (order.payment_status !== 'Paid') orderUpdate.status = 'Processing';
    } else if (data?.status === 'failed') {
      orderUpdate.payment_status = 'Failed';
    }
    const { error: upErr } = await (client.from('orders') as any)
      .update(orderUpdate)
      .eq('id', order.id);
    if (upErr) {
      logger.error('webhook_order_update_error', { error: upErr.message, orderId: order.id });
      return NextResponse.json({ error: 'Order update failed' }, { status: 500 });
    }
    logger.info('webhook_processed', { eventId, orderId: order.id, isSuccess });
    return NextResponse.json({ received: true });
  } catch (e: any) {
    logger.error('webhook_processing_exception', { error: e?.message });
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
