import { NextRequest, NextResponse } from 'next/server';
import { authenticateAdmin, getServerAdminClient } from '@/lib/server/supabaseServer';
import { logger } from '@/lib/server/logging';
import { readJsonBody, isNonEmptyString, isFiniteNumber, sanitizeText, jsonError } from '@/lib/server/validation';
import { isWholeShillingMinor, toMinorUnits } from '@/lib/pricing';

export const dynamic = 'force-dynamic';

/**
 * Record a refund against a paid order — admin only.
 *
 * LivePay's documented API is Mobile Money collection only: there is no refund
 * endpoint, so a refund is money the merchant sends back out of band. That makes
 * it MORE important to record, not less. This endpoint:
 *
 * - requires the order to actually have been paid,
 * - tracks partial refunds (many small refunds cannot exceed the order value),
 * - writes an immutable row to `refunds` (who, how much, why, which payment),
 * - increments `orders.refunded_minor_units` and only flips `payment_status` to
 *   `Refunded` when the order is fully refunded,
 * - writes a matching `payments` row with status `refunded` so the ledger and
 *   the bank statement can be reconciled.
 */
export async function POST(req: NextRequest) {
  const admin = await authenticateAdmin(req);
  if (!admin) return jsonError('Authentication required', 401);

  const body = await readJsonBody(req);
  if (!body) return jsonError('Invalid JSON body', 400);

  const orderId = isNonEmptyString(body.orderId, 64) ? body.orderId.trim() : null;
  if (!orderId) return jsonError('orderId is required', 400);

  const note = isNonEmptyString(body.note, 500) ? sanitizeText(body.note, 500) : '';
  if (note.length < 3) return jsonError('A reason is required to record a refund.', 400);

  if (!isFiniteNumber(body.amount) || body.amount <= 0) {
    return jsonError('A positive refund amount (UGX) is required.', 400);
  }
  const amountMinorUnits = toMinorUnits(body.amount);
  if (!isWholeShillingMinor(amountMinorUnits) || amountMinorUnits <= 0) {
    return jsonError('Refund amount must be a whole shilling amount.', 400);
  }

  const gatewayReference = isNonEmptyString(body.gatewayReference, 120)
    ? sanitizeText(body.gatewayReference, 120)
    : null;

  const client = getServerAdminClient();
  if (!client) return jsonError('Server database access is not configured', 503);

  try {
    const { data: order, error: findErr } = await (client.from('orders') as any)
      .select('id, order_number, payment_status, total_minor_units, refunded_minor_units')
      .eq('id', orderId)
      .maybeSingle();
    if (findErr) {
      logger.error('refund_order_lookup_error', { error: findErr.message });
      return jsonError('Failed to record refund', 500);
    }
    if (!order) return jsonError('Order not found', 404);

    const paymentStatus = String(order.payment_status || '').toLowerCase();
    if (paymentStatus !== 'paid') {
      return jsonError('Only a paid order can be refunded.', 409);
    }

    const total = Number(order.total_minor_units || 0);
    const alreadyRefunded = Number(order.refunded_minor_units || 0);
    const remaining = total - alreadyRefunded;
    if (!(remaining > 0)) return jsonError('This order has already been fully refunded.', 409);
    if (amountMinorUnits > remaining) {
      return jsonError(
        `Refund exceeds the refundable balance (${remaining / 100} UGX remaining).`,
        400
      );
    }

    // 1. Immutable ledger row first: if anything below fails, the refund is
    //    still on record rather than silently lost.
    const now = new Date().toISOString();
    const { data: refundRow, error: refundErr } = await (client.from('refunds') as any)
      .insert({
        order_id: orderId,
        amount_minor_units: amountMinorUnits,
        currency: 'UGX',
        reason: note,
        actor_id: admin.userId,
        actor_email: admin.email ?? null,
        gateway_reference: gatewayReference,
        method: 'manual',
        created_at: now,
      })
      .select('id')
      .maybeSingle();
    if (refundErr) {
      logger.error('refund_insert_failed', { orderId, error: refundErr.message });
      return jsonError('Failed to record refund', 500);
    }

    // 2. Mirror it into the payments ledger (negative cash flow, not a rewrite).
    try {
      await (client.from('payments') as any).insert({
        order_id: orderId,
        provider: 'manual',
        provider_reference: gatewayReference || `REFUND-${order.order_number || orderId}`,
        status: 'refunded',
        amount_minor_units: amountMinorUnits,
        settled_amount_minor_units: -amountMinorUnits,
        net_amount_minor_units: -amountMinorUnits,
        currency: 'UGX',
        raw_payload: {
          kind: 'refund',
          refund_id: refundRow?.id ?? null,
          reason: note,
          refunded_by: admin.userId,
        },
        settled_at: now,
        created_at: now,
        updated_at: now,
      });
    } catch (e: any) {
      logger.warn('refund_payment_record_failed', { orderId, error: e?.message });
    }

    // 3. Move the order forward, never backwards.
    const newRefundedTotal = alreadyRefunded + amountMinorUnits;
    const fullyRefunded = newRefundedTotal >= total;
    const orderUpdate: Record<string, unknown> = {
      refunded_minor_units: newRefundedTotal,
      payment_note: note,
      updated_at: now,
    };
    if (fullyRefunded) orderUpdate.payment_status = 'Refunded';
    if (fullyRefunded) orderUpdate.status = 'Cancelled';

    const { error: updateErr } = await (client.from('orders') as any).update(orderUpdate).eq('id', orderId);
    if (updateErr) {
      logger.error('refund_order_update_failed', { orderId, error: updateErr.message });
      return jsonError('Refund recorded but the order could not be updated. Please reconcile manually.', 500);
    }

    logger.info('refund_recorded', {
      orderId,
      orderNumber: order.order_number,
      amountMinorUnits,
      fullyRefunded,
      refundedMinorUnits: newRefundedTotal,
      admin: admin.userId,
      reason: note,
    });

    return NextResponse.json({
      success: true,
      refundedMinorUnits: newRefundedTotal,
      remainingMinorUnits: total - newRefundedTotal,
      fullyRefunded,
    });
  } catch (e: any) {
    logger.error('refund_exception', { orderId, error: e?.message });
    return jsonError('Failed to record refund', 500);
  }
}
