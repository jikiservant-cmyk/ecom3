import { NextRequest, NextResponse } from 'next/server';
import { authenticateAdmin, authenticateRequest, getServerAdminClient, getServerAnonClient, isServerSupabaseConfigured } from '@/lib/server/supabaseServer';
import { createOrderServer, computeOrderTotals, totalsMatch } from '@/lib/server/orders';
import { logger, newRequestId } from '@/lib/server/logging';
import { readJsonBody, isNonEmptyString, isEmail, isFiniteNumber, isIntInRange, sanitizeText, jsonError } from '@/lib/server/validation';

export const dynamic = 'force-dynamic';

const MAX_ITEMS = 50;
const MAX_QUANTITY = 20;
const ALLOWED_STATUSES = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
const ALLOWED_PAYMENT_STATUSES = ['Pending', 'Paid', 'Failed', 'Refunded'];

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

  const items: { productId?: string; productName: string; quantity: number; price: number; variant?: string }[] = [];
  for (const raw of body.items) {
    if (!raw || typeof raw !== 'object') return jsonError('Invalid order item', 400);
    if (!isNonEmptyString(raw.productName, 300)) return jsonError('Each item needs a valid product name', 400);
    if (!isIntInRange(raw.quantity, 1, MAX_QUANTITY)) return jsonError('Item quantity must be between 1 and 20', 400);
    // Optional stable identifier. Strict charset so it is safe inside a
    // PostgREST .in() filter.
    const productId = isNonEmptyString(raw.productId, 64) && /^[A-Za-z0-9_-]{1,64}$/.test(raw.productId)
      ? raw.productId
      : undefined;
    items.push({
      productId,
      productName: sanitizeText(raw.productName, 300),
      quantity: raw.quantity,
      price: 0, // filled from the catalog below — client prices are never trusted
      variant: isNonEmptyString(raw.variant, 100) ? sanitizeText(raw.variant, 100) : undefined,
    });
  }

  // SECURITY: re-price every line from the product catalog in the database.
  // Prices submitted by the client are ignored entirely.
  if (!isServerSupabaseConfigured) return jsonError('Checkout is not configured', 503);
  const catalogClient = getServerAdminClient() || getServerAnonClient();
  const uniqueIds = [...new Set(items.map((it) => it.productId).filter((v): v is string => Boolean(v)))];
  const uniqueNames = [...new Set(items.map((it) => it.productName))];

  let catalogProducts: any[] = [];
  try {
    // Prefer ids (immutable); names are the fallback for older clients. Matching
    // on name alone is ambiguous when two products share a name, and breaks for
    // any cart built before a rename.
    //
    // Two separate .in() lookups rather than a hand-built .or() filter string:
    // supabase-js escapes array values for us, whereas interpolating product
    // names into a filter would break (or worse) on names containing commas,
    // parentheses or quotes.
    const select = 'id, name, status, product_variants ( price_minor_units, position, status )';
    const byId = uniqueIds.length > 0
      ? await (catalogClient.from('products') as any).select(select).in('id', uniqueIds)
      : { data: [], error: null };
    if (byId.error) {
      logger.error('order_pricing_lookup_error', { error: byId.error.message });
      return jsonError('Checkout is temporarily unavailable. Please try again.', 500);
    }
    const byName = await (catalogClient.from('products') as any).select(select).in('name', uniqueNames);
    if (byName.error) {
      logger.error('order_pricing_lookup_error', { error: byName.error.message });
      return jsonError('Checkout is temporarily unavailable. Please try again.', 500);
    }
    // De-duplicate on id — a product matched by both queries appears twice.
    const seen = new Set<string>();
    for (const p of [...(byId.data || []), ...(byName.data || [])]) {
      const key = String(p?.id);
      if (!p || seen.has(key)) continue;
      seen.add(key);
      catalogProducts.push(p);
    }
  } catch (e: any) {
    logger.error('order_pricing_lookup_exception', { error: e?.message });
    return jsonError('Checkout is temporarily unavailable. Please try again.', 500);
  }

  const priceById = new Map<string, number>(); // minor units
  const priceByName = new Map<string, number>();
  const nameById = new Map<string, string>();
  for (const p of catalogProducts) {
    if (p.status !== 'active') continue;
    const variants = Array.isArray(p.product_variants) ? p.product_variants : [];
    const active = variants
      .filter((v: any) => v.status === 'active')
      .sort((a: any, b: any) => (a.position || 0) - (b.position || 0));
    const primary = active[0] || variants[0];
    if (primary && Number.isFinite(Number(primary.price_minor_units))) {
      priceById.set(String(p.id), Number(primary.price_minor_units));
      // Only the first product wins a given name, so a duplicate name can never
      // silently re-price a line to a different product.
      if (!priceByName.has(p.name)) priceByName.set(p.name, Number(primary.price_minor_units));
      nameById.set(String(p.id), p.name);
    }
  }

  const lineTotalsMinor: number[] = [];
  for (const item of items) {
    const byId = item.productId ? priceById.get(item.productId) : undefined;
    const priceMinor = byId !== undefined ? byId : priceByName.get(item.productName);
    if (priceMinor === undefined || priceMinor <= 0) {
      logger.warn('order_unknown_product', { productId: item.productId, productName: item.productName });
      return jsonError(`"${item.productName}" is not available for purchase right now`, 400);
    }
    item.price = priceMinor / 100;
    // Use the catalog's authoritative name so order_items and the stock
    // decrement inside create_order_v2 cannot be steered by a client string.
    if (item.productId && nameById.has(item.productId)) item.productName = nameById.get(item.productId)!;
    lineTotalsMinor.push(priceMinor * item.quantity);
  }

  const totals = computeOrderTotals(lineTotalsMinor);
  const claimedTotalMinor = isFiniteNumber(body.total) ? Math.round(body.total * 100) : NaN;
  if (!totalsMatch(totals, claimedTotalMinor)) {
    logger.warn('order_total_mismatch', { server: totals.totalMinorUnits, claimed: claimedTotalMinor });
    return jsonError('Order total does not match current catalog prices. Please refresh and try again.', 400);
  }

  const result = await createOrderServer({
    customerName,
    customerEmail,
    customerPhone: customerPhone || undefined,
    shippingAddress: shippingAddress || undefined,
    customerId: auth?.userId || null,
    items,
    total: totals.totalMinorUnits / 100,
    subtotalMinorUnits: totals.subtotalMinorUnits,
    shippingMinorUnits: totals.shippingMinorUnits,
  });

  if (!result.success) {
    return jsonError(result.error || 'Failed to create order', 500);
  }
  logger.info('order_created', {
    orderId: result.orderId,
    orderNumber: result.orderNumber,
    items: items.length,
    totalMinorUnits: totals.totalMinorUnits,
  });
  return NextResponse.json(
    { success: true, orderId: result.orderId, orderNumber: result.orderNumber, status: 'Pending' },
    { status: 201 }
  );
}

/**
 * Update order fulfillment and/or payment status — admin only, allowlisted
 * values. The paymentStatus field is the manual escape hatch for reconciliation
 * (e.g. if the gateway webhook is misconfigured); every change is audit-logged
 * with the admin's user id.
 */
export async function PATCH(req: NextRequest) {
  const admin = await authenticateAdmin(req);
  if (!admin) return jsonError('Authentication required', 401);

  const body = await readJsonBody(req);
  if (!body) return jsonError('Invalid JSON body', 400);

  const { orderId, status, paymentStatus } = body;
  if (!isNonEmptyString(orderId, 64)) return jsonError('Missing or invalid orderId', 400);

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (status !== undefined) {
    if (!ALLOWED_STATUSES.includes(status)) {
      return jsonError(`Status must be one of: ${ALLOWED_STATUSES.join(', ')}`, 400);
    }
    update.status = status;
  }
  if (paymentStatus !== undefined) {
    // Normalize legacy lowercase values ('paid' -> 'Paid').
    const normalized = String(paymentStatus).charAt(0).toUpperCase() + String(paymentStatus).slice(1).toLowerCase();
    if (!ALLOWED_PAYMENT_STATUSES.includes(normalized)) {
      return jsonError(`paymentStatus must be one of: ${ALLOWED_PAYMENT_STATUSES.join(', ')}`, 400);
    }
    update.payment_status = normalized;
    if (normalized === 'Paid' && status === undefined) {
      update.status = 'Processing'; // paying an order moves it into the pipeline
    }
  }
  if (Object.keys(update).length === 1) {
    return jsonError('Provide status and/or paymentStatus', 400);
  }

  try {
    const client = getServerAdminClient();
    if (!client) return jsonError('Server database access is not configured', 503);

    // Confirm the order exists before reporting success — an update matching
    // zero rows previously returned { success: true }, which silently lied to
    // the admin portal during reconciliation.
    const { data: existing, error: findErr } = await (client.from('orders') as any)
      .select('id')
      .eq('id', orderId)
      .maybeSingle();
    if (findErr) {
      logger.error('order_status_lookup_error', { error: findErr.message });
      return jsonError('Failed to update order', 500);
    }
    if (!existing) return jsonError('Order not found', 404);

    const { error } = await (client.from('orders') as any).update(update).eq('id', orderId);
    if (error) {
      logger.error('order_status_update_error', { error: error.message });
      return jsonError('Failed to update order', 500);
    }
    logger.info('order_status_updated', { orderId, status, paymentStatus, admin: admin.userId });
    return NextResponse.json({ success: true });
  } catch (e: any) {
    logger.error('order_status_update_exception', { error: e?.message });
    return jsonError('Failed to update order', 500);
  }
}
