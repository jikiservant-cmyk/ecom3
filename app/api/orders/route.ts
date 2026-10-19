import { NextRequest, NextResponse } from 'next/server';
import {
  authenticateAdmin,
  authenticateRequest,
  getServerAdminClient,
  getServerAnonClient,
  isServerSupabaseConfigured,
} from '@/lib/server/supabaseServer';
import {
  createOrderServer,
  buildCatalogPriceIndex,
  ambiguousProductNames,
  normalisePaymentMethod,
} from '@/lib/server/orders';
import { priceOrder, PromoDeal, toMinorUnits } from '@/lib/pricing';
import { logger, newRequestId } from '@/lib/server/logging';
import {
  readJsonBody,
  isNonEmptyString,
  isEmail,
  isFiniteNumber,
  isIntInRange,
  sanitizeText,
  jsonError,
} from '@/lib/server/validation';

export const dynamic = 'force-dynamic';

const MAX_ITEMS = 50;
const MAX_QUANTITY = 20;
const ALLOWED_STATUSES = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
const ALLOWED_PAYMENT_STATUSES = ['Pending', 'Paid', 'Failed', 'Refunded'];

/**
 * PII-redacted view for the public order-tracking lookup.
 *
 * Deliberately omits the order `id`: that id is the key used to attach line
 * items, so publishing it turned a capability URL into write access.
 */
function publicOrderView(order: any, items: any[]) {
  return {
    orderNumber: order.order_number,
    status: order.status,
    paymentStatus: order.payment_status,
    total: order.total_minor_units ? Number(order.total_minor_units) / 100 : 0,
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
        .select('id, order_number, status, payment_status, total_minor_units, currency, created_at')
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
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(term)) return jsonError('Invalid query format', 400);
      const { data: order, error } = await (client.from('orders') as any)
        .select('*')
        .or(`id.eq.${term},order_number.eq.${term}`)
        .maybeSingle();
      if (error || !order) return jsonError('Order not found', 404);
      return NextResponse.json({ success: true, order });
    }

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
 * Pricing configuration owned by the store, read server-side:
 * active promotions and the free-delivery threshold. `store_settings` is
 * publicly readable, so the admin client is not required.
 */
async function loadPricingSettings(client: any): Promise<{
  deals: PromoDeal[];
  freeShippingThresholdMinorUnits: number;
}> {
  try {
    const { data } = await client
      .from('store_settings')
      .select('settings')
      .eq('id', 'default_settings')
      .maybeSingle();
    const settings = (data?.settings as any) || {};
    const deals: PromoDeal[] = Array.isArray(settings.hotDeals)
      ? settings.hotDeals.filter((d: any) => d && d.active !== false)
      : [];
    const thresholdMajor = Number(settings.freeShippingThreshold);
    return {
      deals,
      freeShippingThresholdMinorUnits:
        Number.isFinite(thresholdMajor) && thresholdMajor > 0 ? toMinorUnits(thresholdMajor) : 0,
    };
  } catch (e: any) {
    logger.warn('order_pricing_settings_unavailable', { error: e?.message });
    return { deals: [], freeShippingThresholdMinorUnits: 0 };
  }
}

/**
 * Create an order. Public (guest checkout supported) but strictly validated and
 * rate-limited in middleware. Orders are always created Pending; payment state
 * advances only through the verified gateway webhook.
 *
 * Idempotent per `Idempotency-Key` header (or `clientRequestId` body field), so
 * a retried request can never produce a second order and a second charge.
 */
export async function POST(req: NextRequest) {
  const body = await readJsonBody(req);
  if (!body) return jsonError('Invalid JSON body', 400);

  const auth = await authenticateRequest(req); // optional: attaches customer id when signed in

  const customerName = isNonEmptyString(body.customerName, 200) ? sanitizeText(body.customerName, 200) : null;
  const customerEmail = isEmail(body.customerEmail) ? body.customerEmail.trim() : null;
  const customerPhone = isNonEmptyString(body.phone, 32) ? sanitizeText(body.phone, 32) : null;
  const shippingAddress = isNonEmptyString(body.shippingAddress, 500) ? sanitizeText(body.shippingAddress, 500) : null;

  // Whitelisted: 'momo' | 'card' (both LivePay products) or 'cod'.
  const paymentMethod = normalisePaymentMethod(body.paymentMethod);

  const rawIdempotencyKey = req.headers.get('idempotency-key') || body.clientRequestId;
  const clientRequestId =
    typeof rawIdempotencyKey === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(rawIdempotencyKey.trim())
      ? rawIdempotencyKey.trim()
      : null;

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
    const productId =
      isNonEmptyString(raw.productId, 64) && /^[A-Za-z0-9_-]{1,64}$/.test(raw.productId) ? raw.productId : undefined;
    items.push({
      productId,
      productName: sanitizeText(raw.productName, 300),
      quantity: raw.quantity,
      price: 0, // filled from the catalog below — client prices are never trusted
      variant: isNonEmptyString(raw.variant, 100) ? sanitizeText(raw.variant, 100) : undefined,
    });
  }

  // SECURITY: re-price every line from the product catalog in the database.
  if (!isServerSupabaseConfigured) return jsonError('Checkout is not configured', 503);
  const catalogClient = getServerAdminClient() || getServerAnonClient();
  const uniqueIds = [...new Set(items.map((it) => it.productId).filter((v): v is string => Boolean(v)))];
  const uniqueNames = [...new Set(items.map((it) => it.productName))];

  let catalogProducts: any[] = [];
  try {
    const select = 'id, name, status, product_variants ( price_minor_units, position, status )';
    const byId =
      uniqueIds.length > 0
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

  const priceIndex = buildCatalogPriceIndex(catalogProducts);
  const nameById = new Map<string, string>();
  for (const p of catalogProducts) {
    if (p?.status === 'active' && p?.id && p?.name) nameById.set(String(p.id), String(p.name));
  }

  // AMBIGUITY GUARD. If two active products share a name, a name-keyed price is
  // whichever row Postgres returned first — an attacker could aim a cart at the
  // cheaper twin. Refuse the line instead of guessing.
  const ambiguousNames = ambiguousProductNames(catalogProducts);

  // Resolve each line's catalog price and effective (promotional) price.
  const catalogLines: { productId?: string; productName: string; quantity: number; catalogUnitMinorUnits: number }[] = [];
  for (const item of items) {
    if (!item.productId && ambiguousNames.has(item.productName)) {
      logger.warn('order_ambiguous_product_name', { productName: item.productName });
      return jsonError(
        `"${item.productName}" matches more than one product. Please refresh the page and try again.`,
        400
      );
    }
    const byId = item.productId ? priceIndex.byId.get(item.productId) : undefined;
    // A supplied id that does not resolve must NOT fall back to a name lookup:
    // that silently repriced by a client-controlled string.
    if (item.productId && byId === undefined) {
      logger.warn('order_product_id_unavailable', { productId: item.productId });
      return jsonError(`"${item.productName}" is not available for purchase right now`, 400);
    }
    const priceMinor = byId !== undefined ? byId : priceIndex.byName.get(item.productName);
    if (priceMinor === undefined || !Number.isFinite(priceMinor) || priceMinor <= 0) {
      logger.warn('order_unknown_product', { productId: item.productId, productName: item.productName });
      return jsonError(`"${item.productName}" is not available for purchase right now`, 400);
    }
    // Use the catalog's authoritative name so order_items, the stock decrement
    // and the pricing snapshot cannot be steered by a client string.
    if (item.productId && nameById.has(item.productId)) item.productName = nameById.get(item.productId)!;
    catalogLines.push({
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity,
      catalogUnitMinorUnits: priceMinor,
    });
  }

  const { deals, freeShippingThresholdMinorUnits } = await loadPricingSettings(getServerAdminClient());
  const pricing = priceOrder({ lines: catalogLines, deals, freeShippingThresholdMinorUnits });

  if (!(pricing.totalMinorUnits > 0)) {
    logger.warn('order_pricing_zero_total', { orderLines: pricing.lines.length });
    return jsonError('This order has no payable value. Please refresh and try again.', 400);
  }

  // Record each line's charged unit price for order_items display/fulfilment.
  for (const line of pricing.lines) {
    const item = items.find((it) => (line.productId ? it.productId === line.productId : it.productName === line.productName));
    if (item) item.price = line.unitMinorUnits / 100;
  }

  const claimedTotalMinor = isFiniteNumber(body.total) ? Math.round(body.total * 100) : NaN;
  if (!Number.isFinite(claimedTotalMinor) || Math.abs(claimedTotalMinor - pricing.totalMinorUnits) > 100) {
    logger.warn('order_total_mismatch', { server: pricing.totalMinorUnits, claimed: claimedTotalMinor });
    return jsonError(
      'Order total does not match current catalog prices and promotions. Please refresh and try again.',
      400
    );
  }

  const result = await createOrderServer({
    customerName,
    customerEmail,
    customerPhone: customerPhone || undefined,
    shippingAddress: shippingAddress || undefined,
    customerId: auth?.userId || null,
    paymentMethod,
    items,
    total: pricing.totalMinorUnits / 100,
    totalMinorUnits: pricing.totalMinorUnits,
    subtotalMinorUnits: pricing.subtotalMinorUnits,
    discountMinorUnits: pricing.discountMinorUnits,
    shippingMinorUnits: pricing.shippingMinorUnits,
    pricingSnapshot: pricing,
    clientRequestId,
  });

  if (!result.success) {
    return jsonError(result.error || 'Failed to create order', 500);
  }
  logger.info('order_created', {
    orderId: result.orderId,
    orderNumber: result.orderNumber,
    idempotent: Boolean(result.idempotent),
    items: items.length,
    totalMinorUnits: pricing.totalMinorUnits,
    discountMinorUnits: pricing.discountMinorUnits,
    shippingMinorUnits: pricing.shippingMinorUnits,
    promotionIds: pricing.lines.map((l) => l.promotionId).filter(Boolean),
  });
  return NextResponse.json(
    {
      success: true,
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      total: pricing.totalMinorUnits / 100,
      status: 'Pending',
    },
    { status: result.idempotent ? 200 : 201 }
  );
}

/**
 * Update order fulfilment and/or payment status — admin only, allowlisted
 * values. Payment status is a state machine: Paid cannot be undone, Refunded is
 * terminal and must go through /api/orders/refund, and every manual transition
 * leaves an audit note plus a payment record.
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
    const normalized = String(paymentStatus).charAt(0).toUpperCase() + String(paymentStatus).slice(1).toLowerCase();
    if (!ALLOWED_PAYMENT_STATUSES.includes(normalized)) {
      return jsonError(`paymentStatus must be one of: ${ALLOWED_PAYMENT_STATUSES.join(', ')}`, 400);
    }
    if (normalized === 'Refunded') {
      return jsonError('Use POST /api/orders/refund to record a refund (amount + reason are required).', 400);
    }
    if (normalized === 'Paid' || normalized === 'Failed') {
      const note = isNonEmptyString(body.note, 500) ? sanitizeText(body.note, 500) : '';
      if (normalized === 'Paid' && note.length < 3) {
        return jsonError('A reason is required to manually mark an order as Paid.', 400);
      }
      if (note) update.payment_note = note;
    }
    update.payment_status = normalized;
    if (normalized === 'Paid' && status === undefined) {
      update.status = 'Processing';
    }
  }
  if (body.trackingNumber !== undefined) {
    if (body.trackingNumber === null || body.trackingNumber === '') {
      update.tracking_number = null;
    } else if (isNonEmptyString(body.trackingNumber, 120)) {
      const tn = sanitizeText(body.trackingNumber, 120);
      if (!/^[A-Za-z0-9-]{3,120}$/.test(tn)) {
        return jsonError('Tracking number may only contain letters, numbers and dashes', 400);
      }
      update.tracking_number = tn.toUpperCase();
    } else {
      return jsonError('Invalid tracking number', 400);
    }
  }

  if (Object.keys(update).length === 1) {
    return jsonError('Provide status, paymentStatus and/or trackingNumber', 400);
  }

  try {
    const client = getServerAdminClient();
    if (!client) return jsonError('Server database access is not configured', 503);

    const { data: existing, error: findErr } = await (client.from('orders') as any)
      .select('id, order_number, payment_status, total_minor_units, refunded_minor_units')
      .eq('id', orderId)
      .maybeSingle();
    if (findErr) {
      logger.error('order_status_lookup_error', { error: findErr.message });
      return jsonError('Failed to update order', 500);
    }
    if (!existing) return jsonError('Order not found', 404);

    // Monotonic payment state. The DB trigger enforces this too; checking here
    // turns it into a clear message instead of a constraint violation.
    const currentPayment = String(existing.payment_status || '').toLowerCase();
    if (typeof update.payment_status === 'string' && update.payment_status !== existing.payment_status) {
      const next = String(update.payment_status).toLowerCase();
      if (currentPayment === 'paid' && next !== 'paid') {
        return jsonError('A paid order cannot be un-paid. Record a refund instead.', 409);
      }
      if (currentPayment === 'refunded') {
        return jsonError('A refunded order is final and cannot change payment status.', 409);
      }
    }

    if (
      status === 'Cancelled' &&
      currentPayment === 'paid' &&
      Number(existing.refunded_minor_units || 0) < Number(existing.total_minor_units || 0)
    ) {
      const note = isNonEmptyString(body.note, 500) ? sanitizeText(body.note, 500) : '';
      if (note.length < 3) {
        return jsonError(
          'This order is paid. Record a refund (POST /api/orders/refund) or provide a reason for cancelling a paid order.',
          409
        );
      }
      update.payment_note = note;
    }

    const { error } = await (client.from('orders') as any).update(update).eq('id', orderId);
    if (error) {
      logger.error('order_status_update_error', { error: error.message });
      return jsonError('Failed to update order', 500);
    }

    // A hand-reconciled payment must still produce a payment record, otherwise
    // the order shows Paid with nothing in the ledger.
    if (update.payment_status === 'Paid') {
      try {
        const amount = Number(existing.total_minor_units || 0) - Number(existing.refunded_minor_units || 0);
        if (amount > 0) {
          await (client.from('payments') as any).insert({
            order_id: orderId,
            provider: 'manual',
            provider_reference: `MANUAL-${existing.order_number || orderId}`,
            status: 'success',
            amount_minor_units: amount,
            settled_amount_minor_units: amount,
            net_amount_minor_units: amount,
            currency: 'UGX',
            raw_payload: { reconciled_by: admin.userId, note: update.payment_note ?? null, method: 'admin' },
            settled_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      } catch (e: any) {
        logger.warn('order_manual_payment_record_failed', { orderId, error: e?.message });
      }
    }

    logger.info('order_status_updated', {
      orderId,
      status,
      paymentStatus,
      trackingNumber: typeof update.tracking_number === 'string' ? update.tracking_number : undefined,
      note: typeof update.payment_note === 'string' ? update.payment_note : undefined,
      admin: admin.userId,
    });
    return NextResponse.json({ success: true });
  } catch (e: any) {
    logger.error('order_status_update_exception', { error: e?.message });
    return jsonError('Failed to update order', 500);
  }
}
