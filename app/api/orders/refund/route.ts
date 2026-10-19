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
 *
 * CONCURRENCY: two admins (or a double click) refunding at the same time must
 * not refund more than the order is worth. The preferred path is the
 * `record_refund` SQL function, which locks the order row. When that function is
 * not deployed the fallback uses an optimistic guard on `refunded_minor_units`,
 * so a stale read is rejected instead of double-paying.
 */

const REFUND_RPC_UNAVAILABLE = new Set(['PGRST202', 'PGRST203', '42883']);

function isRpcUnavailable(err: any): boolean {
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  return REFUND_RPC_UNAVAILABLE.has(code) || /record_refund/i.test(msg) || /could not find the function/i.test(msg);
}

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

  const now = new Date().toISOString();

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
      return jsonError(`Refund exceeds the refundable balance (${remaining / 100} UGX remaining).`, 400);
    }

    // ---- Preferred path: one atomic transaction, order row locked. ----
    try {
      const { data: rpcData, error: rpcErr } = await (client.rpc as any)('record_refund', {
        p_order_id: orderId,
        p_amount_minor_units: amountMinorUnits,
        p_reason: note,
        p_actor_id: admin.userId,
        p_actor_email: admin.email ?? null,
        p_gateway_reference: gatewayReference,
        p_created_at: now,
      });

      if (!rpcErr) {
        const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
        const refundedMinorUnits = Number(row?.refunded_minor_units ?? alreadyRefunded + amountMinorUnits);
        const fullyRefunded = Boolean(row?.fully_refunded ?? refundedMinorUnits >= total);
        logger.info('refund_recorded', {
          orderId,
          orderNumber: order.order_number,
          amountMinorUnits,
          fullyRefunded,
          refundedMinorUnits,
          admin: admin.userId,
          reason: note,
          path: 'rpc',
        });
        return NextResponse.json({
          success: true,
          refundedMinorUnits,
          remainingMinorUnits: Math.max(0, total - refundedMinorUnits),
          fullyRefunded,
        });
      }

      if (!isRpcUnavailable(rpcErr)) {
        // The RPC exists and refused the refund (over-refund, not paid, …).
        logger.warn('refund_rpc_rejected', { orderId, error: rpcErr.message });
        return jsonError('The refund could not be recorded (it may exceed the balance).', 409);
      }
      logger.warn('refund_rpc_missing_fallback', {
        error: rpcErr.message,
        hint: 'Deploy record_refund for an atomic refund guarantee',
      });
    } catch (e: any) {
      logger.warn('refund_rpc_exception_fallback', { error: e?.message });
    }

    // ---- Fallback: optimistic concurrency on the refunded counter. ----
    const newRefundedTotal = alreadyRefunded + amountMinorUnits;
    const fullyRefunded = newRefundedTotal >= total;
    const orderUpdate: Record<string, any> = {
      refunded_minor_units: newRefundedTotal,
      payment_note: note,
      updated_at: now,
    };
    if (fullyRefunded) {
      orderUpdate.payment_status = 'Refunded';
      orderUpdate.status = 'Cancelled';
    }

    // The guard IS the .eq('refunded_minor_units', alreadyRefunded) below: if
    // another refund landed between our read and this write, zero rows match and
    // we abort instead of over-refunding.
    const { data: updatedRows, error: updateErr } = await (client.from('orders') as any)
      .update(orderUpdate)
      .eq('id', orderId)
      .eq('refunded_minor_units', alreadyRefunded)
      .select('id');
    if (updateErr) {
      logger.error('refund_order_update_failed', { orderId, error: updateErr.message });
      return jsonError('Failed to record refund', 500);
    }
    if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
      logger.warn('refund_concurrent_conflict', { orderId, alreadyRefunded, amountMinorUnits });
      return jsonError(
        'Another refund was recorded against this order at the same time. Refresh and try again.',
        409
      );
    }

    // Ledger rows. If the refund row cannot be written we undo the counter, so
    // the order never claims money went out without a record of it.
    const { error: refundErr } = await (client.from('refunds') as any).insert({
      order_id: orderId,
      amount_minor_units: amountMinorUnits,
      currency: 'UGX',
      reason: note,
      actor_id: admin.userId,
      actor_email: admin.email ?? null,
      gateway_reference: gatewayReference,
      method: 'manual',
      created_at: now,
    });
    if (refundErr) {
      logger.error('refund_insert_failed', { orderId, error: refundErr.message });
      await (client.from('orders') as any)
        .update({ refunded_minor_units: alreadyRefunded, updated_at: new Date().toISOString() })
        .eq('id', orderId)
        .eq('refunded_minor_units', newRefundedTotal);
      return jsonError('Failed to record refund', 500);
    }

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
        raw_payload: { kind: 'refund', reason: note, refunded_by: admin.userId },
        settled_at: now,
        created_at: now,
        updated_at: now,
      });
    } catch (e: any) {
      logger.warn('refund_payment_record_failed', { orderId, error: e?.message });
    }

    logger.info('refund_recorded', {
      orderId,
      orderNumber: order.order_number,
      amountMinorUnits,
      fullyRefunded,
      refundedMinorUnits: newRefundedTotal,
      admin: admin.userId,
      reason: note,
      path: 'fallback',
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
