import { NextRequest, NextResponse } from 'next/server';
import { authenticateAdmin, authenticateRequest, getServerAdminClient } from '@/lib/server/supabaseServer';
import { createOrderServer } from '@/lib/server/orders';
import { logger, newRequestId } from '@/lib/server/logging';
import { readJsonBody, isNonEmptyString, isEmail, isFiniteNumber, isIntInRange, sanitizeText, jsonError } from '@/lib/server/validation';

export const dynamic = 'force-dynamic';

const MAX_ITEMS = 50;
const MAX_QUANTITY = 20;
const MAX_UNIT_PRICE = 500_000_000; // sanity cap, UGX
const ALLOWED_STATUSES = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];

/** Redact PII for the public order-tracking lookup. */
function publicOrderView(order: any, items: any[]) {
  return {
    id: order.id,
    orderNumber: order.order_number,
    status: order.status,
    paymentStatus: order.payment_status,
    total: order.total_amount ?? (order.total_minor_units ? Number(order.total_minor_units) / 100 : 0),
    currency: order.currency,
    createdAt: order.created_at,
    itemCount: Array.isArray(items) ? items.length : 0,
    items: Array.isArray(items)
      ? items.map((it: any) => ({
          productName: it.product_name,
          quantity: it.quantity,
          variant: it.variant_sku,
        }))
      : [],
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  // Public order tracking: exact order-number match only (capability-style URL),
  // with PII redacted. No wildcards, no id lookups, no listing.
  const trackNumber = searchParams.get('track');
  if (trackNumber) {
    const term = sanitizeText(trackNumber, 40);
    if (!/^[A-Za-z0-9-]{6,40}$/.test(term)) {
      return jsonError('Invalid order number format', 400);
    }
    try {
      const client = getServerAdminClient();
      if (!client) return jsonError('Order lookup is not configured', 503);
      const { data: order, error } = await (client.from('orders') as any)
        .select('id, order_number, status, payment_status, total_amount, total_minor_units, currency, created_at')
        .eq('order_number', term.toUpperCase())
        .maybeSingle();
      if (error || !order) return jsonError('Order not found', 404);
      const { data: items } = await (client.from('order_items') as any)
        .select('product_name, quantity, variant_sku')
        .eq('order_id', order.id);
      return NextResponse.json({ success: true, order: publicOrderView(order, items || []) });
    } catch (e: any) {
      logger.error('order_track_error', { requestId: newRequestId(), error: e?.message });
      return jsonError('Failed to look up order', 500);
    }
  }

  // Everything below requires an authenticated admin.
  const admin = await authenticateAdmin(req);
  if (!admin) return jsonError('Authentication required', 401);

  try {
    const client = getServerAdminClient();
    if (!client) return jsonError('Server database access is not configured', 503);

    const query = searchParams.get('q') || searchParams.get('id') || searchParams.get('orderNumber');
    if (query) {
      const term = sanitizeText(query, 64);
      // Strict charset so the value is safe inside a PostgREST .or() filter.
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(term)) return jsonError('Invalid query format', 400);
      const { data: order, error } = await (client.from('orders') as any)
        .select('*')
        .or(`id.eq.${term},order_number.eq.${term}`)
        .maybeSingle();
      if (error || !order) return jsonError('Order not found', 404);
      return NextResponse.json({ success: true, order });
    }

    // Paginated list (default 100, max 500) instead of unbounded full-table dumps.
    const limit = Math.min(Number(searchParams.get('limit') || 100), 500);
    const offset = Math.max(Number(searchParams.get('offset') || 0), 0);
    const { data: orders, error, count } = await (client.from('orders') as any)
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) {
      logger.error('orders_list_error', { error: error.message });
      return jsonError('Failed to fetch orders', 500);
    }
    return NextResponse.json({ success: true, count, orders });
  } catch (e: any) {
    logger.error('orders_get_error', { error: e?.message });
    return jsonError('Failed to fetch orders', 500);
  }
}

/**
 * Create an order. Public (guest checkout supported) but strictly validated and
 * rate-limited in middleware. Orders are always created Pending; payment state
 * advances only through the verified gateway webhook.
 */
export async function POST(req: NextRequest) {
  const body = await readJsonBody(req);
  if (!body) return jsonError('Invalid JSON body', 400);

  const auth = await authenticateRequest(req); // optional: attaches customer id when signed in

  const customerName = isNonEmptyString(body.customerName, 200) ? sanitizeText(body.customerName, 200) : null;
  const customerEmail = isEmail(body.customerEmail) ? body.customerEmail.trim() : null;
  const customerPhone = isNonEmptyString(body.phone, 32) ? sanitizeText(body.phone, 32) : null;
  const shippingAddress = isNonEmptyString(body.shippingAddress, 500) ? sanitizeText(body.shippingAddress, 500) : null;

  if (!customerName) return jsonError('A valid customer name is required', 400);
  if (!customerEmail) return jsonError('A valid customer email is required', 400);
  if (!shippingAddress) return jsonError('A shipping address is required', 400);

  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > MAX_ITEMS) {
    return jsonError(`Order must contain between 1 and ${MAX_ITEMS} items`, 400);
  }

  const items: { productName: string; quantity: number; price: number; variant?: string }[] = [];
  for (const raw of body.items) {
    if (!raw || typeof raw !== 'object') return jsonError('Invalid order item', 400);
    if (!isNonEmptyString(raw.productName, 300)) return jsonError('Each item needs a valid product name', 400);
    if (!isIntInRange(raw.quantity, 1, MAX_QUANTITY)) return jsonError('Item quantity must be between 1 and 20', 400);
    if (!isFiniteNumber(raw.price) || raw.price <= 0 || raw.price > MAX_UNIT_PRICE) {
      return jsonError('Each item needs a valid positive price', 400);
    }
    items.push({
      productName: sanitizeText(raw.productName, 300),
      quantity: raw.quantity,
      price: Math.round(raw.price * 100) / 100,
      variant: isNonEmptyString(raw.variant, 100) ? sanitizeText(raw.variant, 100) : undefined,
    });
  }

  // Server recomputes the total from the submitted lines; the client's total is
  // cross-checked but never trusted. (Full catalog-side price verification happens
  // in the payment step, which reads the order from the database.)
  const computedTotal = items.reduce((sum, it) => sum + Math.round(it.price * 100) * it.quantity, 0) / 100;
  if (!isFiniteNumber(body.total) || Math.abs(body.total - computedTotal) > 1) {
    return jsonError('Order total does not match line items', 400);
  }

  const result = await createOrderServer({
    customerName,
    customerEmail,
    customerPhone: customerPhone || undefined,
    shippingAddress: shippingAddress || undefined,
    customerId: auth?.userId || null,
    items,
    total: computedTotal,
  });

  if (!result.success) {
    return jsonError(result.error || 'Failed to create order', 500);
  }
  logger.info('order_created', { orderId: result.orderId, orderNumber: result.orderNumber, items: items.length });
  return NextResponse.json(
    { success: true, orderId: result.orderId, orderNumber: result.orderNumber, status: 'Pending' },
    { status: 201 }
  );
}

/** Update order status — admin only, allowlisted statuses. */
export async function PATCH(req: NextRequest) {
  const admin = await authenticateAdmin(req);
  if (!admin) return jsonError('Authentication required', 401);

  const body = await readJsonBody(req);
  if (!body) return jsonError('Invalid JSON body', 400);

  const { orderId, status } = body;
  if (!isNonEmptyString(orderId, 64)) return jsonError('Missing or invalid orderId', 400);
  if (!ALLOWED_STATUSES.includes(status)) {
    return jsonError(`Status must be one of: ${ALLOWED_STATUSES.join(', ')}`, 400);
  }

  try {
    const client = getServerAdminClient();
    if (!client) return jsonError('Server database access is not configured', 503);
    const { error } = await (client.from('orders') as any)
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', orderId);
    if (error) {
      logger.error('order_status_update_error', { error: error.message });
      return jsonError('Failed to update order', 500);
    }
    logger.info('order_status_updated', { orderId, status, admin: admin.userId });
    return NextResponse.json({ success: true });
  } catch (e: any) {
    logger.error('order_status_update_exception', { error: e?.message });
    return jsonError('Failed to update order', 500);
  }
}
