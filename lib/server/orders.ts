/**
 * Server-side order creation and money reconciliation.
 *
 * Guarantees:
 * - Orders are created as Pending/Pending — payment state can only advance via a
 *   verified gateway webhook (or an audited admin reconciliation).
 * - The total is computed by `lib/pricing.ts` from catalog prices, stored with an
 *   immutable `pricing_snapshot`, and every later check (payment start, webhook)
 *   validates against that snapshot instead of re-deriving from live data.
 * - All amounts are whole-shilling integer minor units. The charge and the
 *   reconciliation therefore use the same integer and cannot drift by rounding.
 * - Order numbers use a CSPRNG alphabet (no Math.random, no 6-digit collisions).
 * - Creation is idempotent per `client_request_id`.
 */
import { ORDER_STATUS, PAYMENT_STATUS } from '@/lib/status';
import { randomBytes } from 'crypto';
import { getServerAdminClient } from './supabaseServer';
import { logger } from './logging';
import {
  DELIVERY_FEE_MINOR_UNITS,
  computeShippingMinorUnits,
  isWholeShillingMinor,
  toWholeShillingMinor,
} from '@/lib/pricing';

const ORDER_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L

/** Flat delivery fee used by the storefront: 10,000 UGX (minor units). */
export const FLAT_DELIVERY_FEE_MINOR_UNITS = DELIVERY_FEE_MINOR_UNITS;

export interface OrderTotals {
  subtotalMinorUnits: number;
  discountMinorUnits: number;
  shippingMinorUnits: number;
  totalMinorUnits: number;
}

/**
 * Authoritative server-side total computation for a set of line totals.
 * Shipping is flat unless the cart qualifies for free delivery. `discount` is
 * subtracted before the free-shipping threshold is evaluated, so a promotion
 * cannot be used to unlock free delivery on an order that does not qualify.
 */
export function computeOrderTotals(
  lineTotalsMinorUnits: number[],
  opts: { discountMinorUnits?: number; freeShippingThresholdMinorUnits?: number } = {}
): OrderTotals {
  const subtotalMinorUnits = (lineTotalsMinorUnits || []).reduce(
    (sum, v) => sum + (Number.isFinite(v) ? Math.round(v) : 0),
    0
  );
  const discountMinorUnits = Math.max(0, Math.round(opts.discountMinorUnits || 0));
  const netSubtotal = subtotalMinorUnits - discountMinorUnits;
  const shippingMinorUnits = computeShippingMinorUnits(
    netSubtotal,
    opts.freeShippingThresholdMinorUnits || 0
  );
  return {
    subtotalMinorUnits,
    discountMinorUnits,
    shippingMinorUnits,
    totalMinorUnits: netSubtotal + shippingMinorUnits,
  };
}

/**
 * True when the client's claimed total matches the server-computed total.
 * Tolerance is 1 UGX (100 minor units) to absorb whole-shilling rounding on the
 * client; it is far too small to be worth exploiting and far larger than any
 * legitimate rounding difference.
 */
export function totalsMatch(server: OrderTotals, claimedTotalMinorUnits: number, toleranceMinorUnits = 100): boolean {
  return (
    Number.isFinite(claimedTotalMinorUnits) &&
    Math.abs(server.totalMinorUnits - claimedTotalMinorUnits) <= toleranceMinorUnits
  );
}

export interface CatalogPriceIndex {
  /** Authoritative price in minor units, keyed by product id. */
  byId: Map<string, number>;
  /** Authoritative price in minor units, keyed by product name (fallback). */
  byName: Map<string, number>;
  /** Variant id → its product and its OWN price (variants can differ). */
  byVariantId: Map<string, { productId: string; priceMinorUnits: number }>;
}

export interface CatalogValuation {
  ok: boolean;
  catalogSubtotalMinor: number;
  catalogTotalMinor: number;
  /** How far the stored total understates the catalog value. 0 when ok. */
  shortByMinor: number;
  /** Items with no active catalog price — an order containing one is not chargeable. */
  unknownItems: string[];
}

/**
 * LEGACY valuation for orders created before pricing snapshots existed.
 *
 * Re-derive the order's value from the live catalog and compare it to the total
 * stored on the order row. A stored total BELOW the catalog value is refused;
 * a total above it is allowed (the catalog price dropped after checkout).
 *
 * New orders carry a `pricing_snapshot` and are validated with
 * `validatePricingSnapshot` instead — see `lib/pricing.ts`.
 */
export function valueOrderAgainstCatalog(opts: {
  items: { productName: string; quantity: number; productId?: string | null }[];
  prices: CatalogPriceIndex;
  storedTotalMinorUnits: number;
}): CatalogValuation {
  const lineTotalsMinor: number[] = [];
  const unknownItems: string[] = [];

  for (const item of opts.items || []) {
    const rawQuantity = Number(item?.quantity);
    if (!Number.isFinite(rawQuantity)) {
      unknownItems.push(String(item?.productName || '(unnamed)'));
      continue;
    }
    const quantity = Math.round(rawQuantity);
    // A zero (or negative) quantity line is not chargeable and must never make
    // an order "worth" zero while still claiming to be ok.
    if (quantity <= 0) {
      unknownItems.push(String(item?.productName || '(unnamed)'));
      continue;
    }
    const byId = item?.productId ? opts.prices.byId.get(String(item.productId)) : undefined;
    const priceMinor = byId !== undefined ? byId : opts.prices.byName.get(String(item?.productName || ''));
    if (priceMinor === undefined || !Number.isFinite(priceMinor) || priceMinor <= 0) {
      unknownItems.push(String(item?.productName || '(unnamed)'));
      continue;
    }
    lineTotalsMinor.push(priceMinor * quantity);
  }

  const catalog = computeOrderTotals(lineTotalsMinor);
  const stored = Number.isFinite(Number(opts.storedTotalMinorUnits))
    ? Math.round(Number(opts.storedTotalMinorUnits))
    : NaN;
  const shortByMinor = Number.isFinite(stored) ? Math.max(0, catalog.totalMinorUnits - stored) : Infinity;

  return {
    ok: unknownItems.length === 0 && Number.isFinite(stored) && shortByMinor === 0,
    catalogSubtotalMinor: catalog.subtotalMinorUnits,
    catalogTotalMinor: catalog.totalMinorUnits,
    shortByMinor: Number.isFinite(shortByMinor) ? shortByMinor : 0,
    unknownItems,
  };
}

/**
 * Build a {@link CatalogPriceIndex} from `products` rows shaped like
 * `select('id, name, status, product_variants ( price_minor_units, position, status )')`.
 * Inactive products are skipped; the first product wins a given name so a
 * duplicate name can never silently re-price a line to a cheaper product.
 *
 * NOTE: this index is only used for LEGACY (snapshot-less) orders. For those we
 * also refuse to trust an ambiguous name — see `hasAmbiguousName`.
 */
export function buildCatalogPriceIndex(products: any[]): CatalogPriceIndex {
  const byId = new Map<string, number>();
  const byName = new Map<string, number>();
  // variant id → the product it belongs to and its own price. Two variants of
  // the same product can differ in price, so a line that names a variant must be
  // priced from THAT variant, never from whichever one happens to be first.
  const byVariantId = new Map<string, { productId: string; priceMinorUnits: number }>();

  for (const p of products || []) {
    if (!p || p.status !== 'active') continue;
    const variants = Array.isArray(p.product_variants) ? p.product_variants : [];
    const active = variants
      .filter((v: any) => v && v.status === 'active')
      .sort((a: any, b: any) => (Number(a?.position) || 0) - (Number(b?.position) || 0));
    const primary = active[0] || variants[0];
    const price = Number(primary?.price_minor_units);
    if (!primary || !Number.isFinite(price) || price <= 0) continue;
    byId.set(String(p.id), price);
    if (!byName.has(p.name)) byName.set(p.name, price);

    for (const v of active) {
      const vPrice = Number(v?.price_minor_units);
      if (!v?.id || !Number.isFinite(vPrice) || vPrice <= 0) continue;
      byVariantId.set(String(v.id), { productId: String(p.id), priceMinorUnits: vPrice });
    }
  }

  return { byId, byName, byVariantId };
}

/**
 * Names that resolve to more than one active product. A name-keyed valuation
 * for such a name is nondeterministic, so legacy orders that use one are
 * refused rather than priced by whichever row Postgres returned first.
 */
export function ambiguousProductNames(products: any[]): Set<string> {
  const seen = new Map<string, number>();
  for (const p of products || []) {
    if (!p || p.status !== 'active' || !p.name) continue;
    seen.set(String(p.name), (seen.get(String(p.name)) || 0) + 1);
  }
  const ambiguous = new Set<string>();
  for (const [name, count] of seen) if (count > 1) ambiguous.add(name);
  return ambiguous;
}

export interface Reconciliation {
  amountOk: boolean;
  currencyOk: boolean;
  expectedMinor: number;
  paidMinor: number;
  /** Why the notification was refused (for logs). Undefined when acceptable. */
  reason?: string;
}

const STRICT_AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * Reconcile a gateway payment notification against the stored order.
 *
 * LivePay's documented signature covers only customer_reference,
 * internal_reference and status — `amount` is NOT signed — so this is the only
 * amount defence. Everything fails closed.
 *
 * The expected amount comes from `total_minor_units` (one source of truth), not
 * from the legacy `total_amount` column. `amount` is in major units (integer
 * UGX per LivePay docs) and is scaled by 100.
 */
export function reconcilePaymentAmount(opts: {
  orderTotalMinorUnits?: number | string | null;
  orderCurrency?: string | null;
  payloadAmount?: unknown;
  payloadCurrency?: unknown;
}): Reconciliation {
  const expectedMinor = opts.orderTotalMinorUnits == null ? NaN : Number(opts.orderTotalMinorUnits);

  let paidMinor = NaN;
  let reason: string | undefined;
  const raw = opts.payloadAmount;
  if (typeof raw === 'number') {
    if (Number.isFinite(raw)) paidMinor = Math.round(raw * 100);
  } else if (typeof raw === 'string') {
    // Strict digits only — no whitespace, no exponent, no hex. `Number()` would
    // happily accept "1e3" and "0x2AB00"; this is the one field the gateway's
    // signature does not cover, so it is parsed conservatively.
    if (STRICT_AMOUNT.test(raw)) paidMinor = Math.round(Number(raw) * 100);
  }
  if (!Number.isFinite(paidMinor)) reason = 'amount not parseable';
  else if (!Number.isSafeInteger(paidMinor)) reason = 'amount out of range';

  const payloadCurrency = opts.payloadCurrency == null ? '' : String(opts.payloadCurrency).trim().toUpperCase();
  const orderCurrency = (opts.orderCurrency || 'UGX').trim().toUpperCase();
  const currencyOk = payloadCurrency === '' || payloadCurrency === orderCurrency;

  // The whole-shilling rule is a UGX invariant (UGX has no circulating
  // subunit). USD card settlements legitimately land in cents, so applying the
  // UGX rule there would reject every correct card payment.
  const requiresWholeShilling = orderCurrency === 'UGX';
  const expectedUsable =
    Number.isSafeInteger(expectedMinor) &&
    expectedMinor > 0 &&
    (!requiresWholeShilling || isWholeShillingMinor(expectedMinor));

  const amountOk =
    !reason &&
    expectedUsable &&
    Number.isFinite(paidMinor) &&
    paidMinor === expectedMinor;

  if (!amountOk && !reason) {
    reason = expectedUsable ? 'amount mismatch' : 'order total is not a valid whole shilling amount';
  }

  return { amountOk, currencyOk, expectedMinor, paidMinor, reason };
}

/**
 * Return-URL guard for gateway redirects. Only same-origin (as APP_URL) URLs are
 * accepted — anything else is an open-redirect/phishing vector. Returns the
 * validated URL or null.
 */
export function safeReturnUrl(candidate: string | null | undefined, appUrl: string | undefined): string | null {
  if (!candidate || !appUrl) return null;
  try {
    const target = new URL(candidate);
    const base = new URL(appUrl);
    if (target.origin !== base.origin) return null;
    return target.toString();
  } catch {
    return null;
  }
}

/** Cryptographically random order number, e.g. DP-8FK3-QM2Z (32^8 ~= 1.1e12 space). */
export function generateOrderNumber(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += ORDER_ALPHABET[bytes[i] % ORDER_ALPHABET.length];
  return `DP-${out.slice(0, 4)}-${out.slice(4)}`;
}

export function generateOrderId(): string {
  return crypto.randomUUID();
}

export interface OrderItemInput {
  productId?: string | null;
  /**
   * The exact product variant the customer selected. When present the server
   * prices and decrements THIS variant; when absent it uses the product's
   * primary active variant (legacy carts).
   */
  variantId?: string | null;
  productName: string;
  quantity: number;
  /** Major units (UGX). Validated upstream against the catalog; stored for display. */
  price: number;
  variant?: string;
}

export interface CreateOrderInput {
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  shippingAddress?: string;
  customerId?: string | null;
  items: OrderItemInput[];
  total: number; // major units
  totalMinorUnits?: number;
  subtotalMinorUnits?: number;
  discountMinorUnits?: number;
  shippingMinorUnits?: number;
  /** Immutable pricing basis recorded at checkout (see lib/pricing.ts). */
  pricingSnapshot?: unknown;
  /** Idempotency key: a retried checkout returns the original order. */
  clientRequestId?: string | null;
  /**
   * Guest idempotency scope. A retried guest checkout is only a duplicate if it
   * comes from the same browser, so the session id (generated once per browser)
   * is part of the uniqueness key. Without it, every guest would share one
   * namespace.
   */
  guestSessionId?: string | null;
  /** 'momo' (gateway prompt), 'card' (gateway hosted checkout) or 'cod'. */
  paymentMethod?: PaymentMethod;
}

/**
 * Payment methods the shop can record. Each maps to a documented LivePay
 * product ('momo' → collect-money, 'card' → card-collection) or to cash.
 */
export type PaymentMethod = 'momo' | 'cod' | 'card';

export const PAYMENT_METHODS: readonly PaymentMethod[] = ['momo', 'cod', 'card'] as const;

/**
 * Whitelist an untrusted payment-method string. Anything unrecognised becomes
 * 'momo' (the historical default), never an arbitrary value that would land in
 * the database and confuse the checkout gates.
 */
export function normalisePaymentMethod(value: unknown): PaymentMethod {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (PAYMENT_METHODS as readonly string[]).includes(v) ? (v as PaymentMethod) : 'momo';
}

export interface CreateOrderResult {
  success: boolean;
  orderId?: string;
  orderNumber?: string;
  /** True when an existing order was returned for a repeated idempotency key. */
  idempotent?: boolean;
  error?: string;
}


/**
 * True when a PostgREST error says a column does not exist — i.e. the database
 * has not had the latest schema applied yet.
 */
function isMissingColumnError(err: any): boolean {
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  return code === 'PGRST204' || code === '42703' || /column .* does not exist/i.test(msg);
}

/** Remove the given keys from a payload so an un-migrated DB can still be written. */
function withoutKeys(payload: Record<string, any>, keys: string[]): Record<string, any> {
  const copy = { ...payload };
  for (const key of keys) delete copy[key];
  return copy;
}

const NEW_ORDER_COLUMNS = ['pricing_snapshot', 'client_request_id', 'refunded_minor_units', 'guest_session_id'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

const DUPLICATE_CODE = '23505';

function isDuplicateError(err: any): boolean {
  const msg = String(err?.message || '');
  return err?.code === DUPLICATE_CODE || /duplicate key|already exists/i.test(msg);
}

async function findExistingOrder(
  client: any,
  clientRequestId: string,
  customerId: string | null
): Promise<{ orderId: string; orderNumber: string } | null> {
  try {
    // Scoped to the caller: a guessed or leaked idempotency key must not hand
    // back another customer's order id and order number.
    let query = client.from('orders').select('id, order_number').eq('client_request_id', clientRequestId);
    query = customerId ? query.eq('customer_id', customerId) : query.is('customer_id', null);
    const { data } = await query.maybeSingle();
    if (data?.id && data?.order_number) {
      return { orderId: String(data.id), orderNumber: String(data.order_number) };
    }
  } catch {
    // fall through: creation will surface any real problem
  }
  return null;
}

/**
 * Create an order atomically. Requires the service-role client: order rows are
 * only ever written by the server, after the API has priced them from the
 * catalog. There is no client-side order creation path.
 */
export async function createOrderServer(input: CreateOrderInput): Promise<CreateOrderResult> {
  const client = getServerAdminClient();
  if (!client) {
    logger.error('order_create_no_service_role', {
      hint: 'Set SUPABASE_SERVICE_ROLE_KEY — order creation is refused without it',
    });
    return { success: false, error: 'Checkout is temporarily unavailable. Please try again.' };
  }

  const clientRequestId =
    input.clientRequestId && CLIENT_REQUEST_ID_RE.test(input.clientRequestId) ? input.clientRequestId : null;

  // Idempotency: a retried checkout must not create a second order (and a second
  // mobile-money prompt) for the same intent.
  const existingCustomerId =
    input.customerId && UUID_RE.test(input.customerId) ? input.customerId : null;
  if (clientRequestId) {
    const existing = await findExistingOrder(client, clientRequestId, existingCustomerId);
    if (existing) {
      logger.info('order_create_idempotent_replay', existing);
      return { success: true, ...existing, idempotent: true };
    }
  }

  const orderId = generateOrderId();
  const orderNumber = generateOrderNumber();
  const now = new Date().toISOString();
  const totalMinorUnits = Number.isFinite(input.totalMinorUnits)
    ? Number(input.totalMinorUnits)
    : Math.round(input.total * 100);
  const safeCustomerId = input.customerId && UUID_RE.test(input.customerId) ? input.customerId : null;

  const subtotalMinorUnits = Number(input.subtotalMinorUnits ?? totalMinorUnits);
  const discountMinorUnits = Math.max(0, Number(input.discountMinorUnits ?? 0));
  const shippingMinorUnits = Number(
    input.shippingMinorUnits ?? Math.max(0, totalMinorUnits - subtotalMinorUnits + discountMinorUnits)
  );

  // FINANCIAL INVARIANT: the stored columns must add up, in whole shillings.
  if (!isWholeShillingMinor(totalMinorUnits) || !isWholeShillingMinor(subtotalMinorUnits)) {
    logger.error('order_create_non_integer_total', { totalMinorUnits, subtotalMinorUnits });
    return { success: false, error: 'Checkout is temporarily unavailable. Please try again.' };
  }
  if (subtotalMinorUnits - discountMinorUnits + shippingMinorUnits !== totalMinorUnits) {
    logger.error('order_create_total_mismatch', {
      subtotalMinorUnits,
      discountMinorUnits,
      shippingMinorUnits,
      totalMinorUnits,
    });
    return { success: false, error: 'Checkout is temporarily unavailable. Please try again.' };
  }

  // Path 1: atomic Postgres function (transaction + stock decrement).
  try {
    const { error } = await (client.rpc as any)('create_order_v2', {
      p_order_id: orderId,
      p_order_number: orderNumber,
      p_customer_id: safeCustomerId,
      p_customer_name: input.customerName,
      p_customer_email: input.customerEmail,
      p_customer_phone: input.customerPhone || null,
      p_shipping_address: input.shippingAddress || '',
      p_items: input.items.map((it) => ({
        productName: it.productName,
        productId: it.productId || null,
        variantId: it.variantId || null,
        quantity: it.quantity,
        price: it.price,
        variant: it.variant || 'Standard',
      })),
      p_subtotal_minor_units: subtotalMinorUnits,
      p_discount_minor_units: discountMinorUnits,
      p_shipping_minor_units: shippingMinorUnits,
      p_total_minor_units: totalMinorUnits,
      p_pricing_snapshot: input.pricingSnapshot ?? null,
      p_client_request_id: clientRequestId,
      p_payment_method: normalisePaymentMethod(input.paymentMethod),
      p_created_at: now,
      p_guest_session_id: input.guestSessionId ?? null,
    });
    if (!error) {
      return { success: true, orderId, orderNumber };
    }
    if (isDuplicateError(error) && clientRequestId) {
      const existing = await findExistingOrder(client, clientRequestId, existingCustomerId);
      if (existing) return { success: true, ...existing, idempotent: true };
    }
    // PGRST202 / 42883 => function (or its argument list) not deployed;
    // fall through to the manual path.
    const code = (error as any).code || '';
    const msg = (error as any).message || '';
    if (!msg.includes('create_order_v2') && code !== 'PGRST202' && code !== '42883' && code !== 'PGRST203') {
      logger.error('order_create_rpc_failed', { error: msg, code });
      return { success: false, error: 'Order could not be created. Please try again.' };
    }
    logger.warn('order_create_rpc_missing_fallback', { code });
  } catch (e: any) {
    logger.warn('order_create_rpc_exception_fallback', { error: e?.message });
  }

  // Path 2: sequential inserts with strict error propagation (no silent partials).
  // Reached only when the current create_order_v2 signature is not deployed.
  // It is NOT atomic: two simultaneous checkouts can both pass the pre-flight
  // stock check. Deploy create_order_v2 for the real guarantee.
  try {
    const names = [...new Set(input.items.map((it) => it.productName))];
    const { data: variants, error: vErr } = await (client.from('product_variants') as any)
      .select('id, product_id, inventory_quantity, status, position, products ( id, name, status )')
      .eq('status', 'active')
      .in('products.name', names);
    if (vErr) {
      logger.warn('order_stock_precheck_skipped', { error: vErr.message });
    } else {
      // Two lookups: by exact variant id (the option the customer chose) and by
      // the product's primary variant (legacy callers that do not send one).
      const byVariantId = new Map<string, number>();
      const primaryByProduct = new Map<string, { position: number; qty: number }>();
      for (const v of variants || []) {
        const product = (v as any)?.products;
        const name = product?.name;
        if (!name || product?.status !== 'active') continue;
        const position = Number((v as any)?.position) || 0;
        const qty = Number((v as any)?.inventory_quantity) || 0;
        if ((v as any)?.id) byVariantId.set(String((v as any).id), qty);
        const current = primaryByProduct.get(name);
        if (!current || position < current.position) primaryByProduct.set(name, { position, qty });
      }
      for (const item of input.items) {
        const available = item.variantId
          ? byVariantId.get(item.variantId)
          : primaryByProduct.get(item.productName)?.qty;
        if (available !== undefined && item.quantity > available) {
          logger.warn('order_insufficient_stock_fallback', {
            productName: item.productName,
            variantId: item.variantId ?? null,
            requested: item.quantity,
            available,
          });
          return { success: false, error: `"${item.productName}" does not have enough stock for this order.` };
        }
      }
    }
  } catch (e: any) {
    logger.warn('order_stock_precheck_exception', { error: e?.message });
  }

  try {
    let orderPayload: Record<string, any> = {
      id: orderId,
      order_number: orderNumber,
      client_request_id: clientRequestId,
      guest_session_id: input.guestSessionId ?? null,
      customer_id: safeCustomerId,
      customer_name: input.customerName,
      customer_email: input.customerEmail,
      customer_phone: input.customerPhone || null,
      shipping_address: { address: input.shippingAddress || '' },
      items: input.items,
      status: ORDER_STATUS.pending,
      payment_status: PAYMENT_STATUS.pending,
      payment_method: normalisePaymentMethod(input.paymentMethod),
      currency: 'UGX',
      subtotal_minor_units: subtotalMinorUnits,
      discount_minor_units: discountMinorUnits,
      shipping_minor_units: shippingMinorUnits,
      tax_minor_units: 0,
      total_minor_units: totalMinorUnits,
      total_amount: totalMinorUnits / 100,
      pricing_snapshot: input.pricingSnapshot ?? null,
      refunded_minor_units: 0,
      created_at: now,
      updated_at: now,
    };

    let { error: orderError } = await (client.from('orders') as any).insert(orderPayload);

    // A database that has not had the latest schema applied would otherwise
    // reject every checkout. Retry without the new columns, loudly.
    if (orderError && isMissingColumnError(orderError)) {
      logger.warn('order_create_schema_outdated', {
        error: orderError.message,
        hint: 'Re-run lib/schemaSql.ts — pricing snapshots and idempotency are disabled until then',
      });
      orderPayload = withoutKeys(orderPayload, NEW_ORDER_COLUMNS);
      const retry = await (client.from('orders') as any).insert(orderPayload);
      orderError = retry.error;
    }

    if (orderError) {
      if (isDuplicateError(orderError) && clientRequestId) {
        const existing = await findExistingOrder(client, clientRequestId, existingCustomerId);
        if (existing) return { success: true, ...existing, idempotent: true };
      }
      logger.error('order_insert_failed', { error: orderError.message });
      return { success: false, error: 'Order could not be created. Please try again.' };
    }

    if (input.items.length > 0) {
      const itemsPayload = input.items.map((it) => ({
        order_id: orderId,
        product_id: it.productId || null,
        variant_id: it.variantId || null,
        product_name: it.productName,
        product_slug: it.productName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        variant_sku: it.variant || 'Standard',
        variant_attributes: it.variant ? { variant: it.variant } : {},
        unit_price_minor_units: Math.round(it.price * 100),
        quantity: it.quantity,
        line_total_minor_units: Math.round(it.price * 100) * it.quantity,
        created_at: now,
      }));
      let { error: itemsError } = await (client.from('order_items') as any).insert(itemsPayload);
      if (itemsError && isMissingColumnError(itemsError)) {
        const retry = await (client.from('order_items') as any).insert(
          itemsPayload.map((row: Record<string, any>) => withoutKeys(row, ['product_id', 'variant_id']))
        );
        itemsError = retry.error;
      }
      if (itemsError) {
        // Compensate: do not leave a dangling order header.
        await (client.from('orders') as any).delete().eq('id', orderId);
        logger.error('order_items_insert_failed', { error: itemsError.message });
        return { success: false, error: 'Order could not be created. Please try again.' };
      }
    }

    return { success: true, orderId, orderNumber };
  } catch (e: any) {
    logger.error('order_create_exception', { error: e?.message });
    return { success: false, error: 'Order could not be created. Please try again.' };
  }
}

/** Whole-shilling normalisation for catalog prices written by the admin UI. */
export function normaliseCatalogPriceMinor(priceMinorUnits: number): number {
  return toWholeShillingMinor(priceMinorUnits);
}
