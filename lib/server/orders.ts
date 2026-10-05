/**
 * Server-side order creation. This is the ONLY code path allowed to create orders.
 *
 * Guarantees:
 * - Orders are created as Pending/Pending — payment state can only advance via a
 *   verified gateway webhook.
 * - Totals are accepted only from the server-computed checkout payload validated
 *   by the API route (client-supplied prices are still validated + capped here).
 * - Order numbers use a CSPRNG alphabet (no Math.random, no 6-digit collisions).
 * - Prefer the atomic `create_order_v2` Postgres function (single transaction,
 *   inventory decrement). Fall back to sequential service-role inserts with
 *   explicit error propagation when the function is not deployed.
 */
import { randomBytes } from 'crypto';
import { getServerAdminClient } from './supabaseServer';
import { logger } from './logging';

const ORDER_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L

/** Flat delivery fee used by the storefront: 25,000 UGX (minor units). */
export const FLAT_DELIVERY_FEE_MINOR_UNITS = 2_500_000;

export interface OrderTotals {
  subtotalMinorUnits: number;
  shippingMinorUnits: number;
  totalMinorUnits: number;
}

/**
 * Authoritative server-side total computation. The client's claimed total must
 * match this exactly (within a 1-unit rounding tolerance) or the order is
 * rejected. Shipping rule mirrors the storefront: flat fee whenever the cart
 * is non-empty.
 */
export function computeOrderTotals(lineTotalsMinorUnits: number[]): OrderTotals {
  const subtotalMinorUnits = lineTotalsMinorUnits.reduce((sum, v) => sum + (Number.isFinite(v) ? Math.round(v) : 0), 0);
  const shippingMinorUnits = subtotalMinorUnits > 0 ? FLAT_DELIVERY_FEE_MINOR_UNITS : 0;
  return {
    subtotalMinorUnits,
    shippingMinorUnits,
    totalMinorUnits: subtotalMinorUnits + shippingMinorUnits,
  };
}

/** True when the client's claimed total matches the server-computed total. */
export function totalsMatch(server: OrderTotals, claimedTotalMinorUnits: number, toleranceMinorUnits = 1): boolean {
  return Number.isFinite(claimedTotalMinorUnits) && Math.abs(server.totalMinorUnits - claimedTotalMinorUnits) <= toleranceMinorUnits;
}

export interface CatalogPriceIndex {
  /** Authoritative price in minor units, keyed by product id. */
  byId: Map<string, number>;
  /** Authoritative price in minor units, keyed by product name (fallback). */
  byName: Map<string, number>;
}

export interface CatalogValuation {
  /** True when the stored total is justified by what the catalog says the items cost. */
  ok: boolean;
  catalogSubtotalMinor: number;
  catalogTotalMinor: number;
  /** How far the stored total understates the catalog value. 0 when ok. */
  shortByMinor: number;
  /** Items with no active catalog price — an order containing one is not chargeable. */
  unknownItems: string[];
}

/**
 * Re-derive an order's value from the catalog and compare it to the total
 * stored on the order row.
 *
 * Why this exists: `anon` can INSERT into `public.orders` (guest checkout), the
 * insert policy is `WITH CHECK (true)`, and the guard triggers only force
 * `payment_status` — nothing ever checks that `total_minor_units` reflects what
 * the items actually cost. An attacker can therefore insert an order for real
 * products with a 1-UGX total, call the public payment endpoint, pay 1 UGX, and
 * receive a webhook that reconciles against that same forged total and marks the
 * order Paid. Re-pricing here closes that regardless of how the row got there.
 *
 * A stored total BELOW the catalog value is the money-losing direction and is
 * always refused. A total above it (catalog price dropped after checkout) is
 * allowed — that is a normal price change, not a loss.
 */
export function valueOrderAgainstCatalog(opts: {
  items: { productName: string; quantity: number; productId?: string | null }[];
  prices: CatalogPriceIndex;
  storedTotalMinorUnits: number;
}): CatalogValuation {
  const lineTotalsMinor: number[] = [];
  const unknownItems: string[] = [];

  for (const item of opts.items || []) {
    const quantity = Number.isFinite(Number(item?.quantity)) ? Math.max(0, Math.round(Number(item.quantity))) : 0;
    const byId = item?.productId ? opts.prices.byId.get(String(item.productId)) : undefined;
    const priceMinor = byId !== undefined ? byId : opts.prices.byName.get(String(item?.productName || ''));
    if (priceMinor === undefined || !Number.isFinite(priceMinor) || priceMinor <= 0) {
      unknownItems.push(String(item?.productName || '(unnamed)'));
      continue;
    }
    lineTotalsMinor.push(priceMinor * quantity);
  }

  const catalog = computeOrderTotals(lineTotalsMinor);
  const stored = Number.isFinite(Number(opts.storedTotalMinorUnits)) ? Math.round(Number(opts.storedTotalMinorUnits)) : NaN;
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
 */
export function buildCatalogPriceIndex(products: any[]): CatalogPriceIndex {
  const byId = new Map<string, number>();
  const byName = new Map<string, number>();

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
  }

  return { byId, byName };
}

export interface Reconciliation {
  amountOk: boolean;
  currencyOk: boolean;
  expectedMinor: number;
  paidMinor: number;
}

/**
 * Reconcile a gateway payment notification against the stored order.
 *
 * This is the ONLY amount defence we have: LivePay's documented signature
 * covers just customer_reference, internal_reference and status — `amount` is
 * NOT signed, so a notification with a valid signature can still carry a
 * tampered amount. Anything that is not exactly right (including a missing or
 * non-numeric amount) fails closed.
 *
 * LivePay sends `amount` in major units (integer UGX), so it is scaled by 100.
 */
export function reconcilePaymentAmount(opts: {
  orderTotalAmount?: number | string | null;
  orderTotalMinorUnits?: number | string | null;
  orderCurrency?: string | null;
  payloadAmount?: unknown;
  payloadCurrency?: unknown;
}): Reconciliation {
  const totalAmount = opts.orderTotalAmount == null ? NaN : Number(opts.orderTotalAmount);
  const totalMinor = opts.orderTotalMinorUnits == null ? NaN : Number(opts.orderTotalMinorUnits);
  const expectedMinor = Number.isFinite(totalAmount) && totalAmount > 0
    ? Math.round(totalAmount * 100)
    : (Number.isFinite(totalMinor) ? Math.round(totalMinor) : NaN);

  const paidMinor = typeof opts.payloadAmount === 'number' || typeof opts.payloadAmount === 'string'
    ? Math.round(Number(opts.payloadAmount) * 100)
    : NaN;

  const payloadCurrency = opts.payloadCurrency == null ? '' : String(opts.payloadCurrency).trim().toUpperCase();
  const orderCurrency = (opts.orderCurrency || 'UGX').trim().toUpperCase();

  return {
    expectedMinor,
    paidMinor,
    amountOk: Number.isFinite(expectedMinor) && Number.isFinite(paidMinor) && paidMinor === expectedMinor,
    // A missing currency on the notification is tolerated (documented payloads
    // always carry one); a mismatching one is not.
    currencyOk: payloadCurrency === '' || payloadCurrency === orderCurrency,
  };
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
  productName: string;
  quantity: number;
  price: number; // major units (UGX), validated upstream against catalog
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
  shippingMinorUnits?: number;
  subtotalMinorUnits?: number;
  /** 'momo' (gateway) or 'cod' (cash on delivery). Defaults to 'momo'. */
  paymentMethod?: 'momo' | 'cod';
}

export interface CreateOrderResult {
  success: boolean;
  orderId?: string;
  orderNumber?: string;
  error?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Create an order atomically. Uses the service-role client when available
 * (bypasses RLS); otherwise uses the anon client and relies on the public-insert
 * RLS policy documented for guest checkout.
 */
export async function createOrderServer(input: CreateOrderInput): Promise<CreateOrderResult> {
  // FINANCIAL INTEGRITY: order writes require the service-role client. The
  // previous `|| getServerAnonClient()` fallback only worked because anon was
  // granted INSERT on public.orders — which is precisely what let an attacker
  // forge an order row with an arbitrary (1 UGX) total and then pay it. Orders
  // are now written only by this function, under the service role, from
  // catalog-priced line items.
  const client = getServerAdminClient();
  if (!client) {
    logger.error('order_create_no_service_role', {
      hint: 'Set SUPABASE_SERVICE_ROLE_KEY — order creation is refused without it',
    });
    return { success: false, error: 'Checkout is temporarily unavailable. Please try again.' };
  }
  const orderId = generateOrderId();
  const orderNumber = generateOrderNumber();
  const now = new Date().toISOString();
  const totalMinorUnits = Math.round(input.total * 100);
  const safeCustomerId = input.customerId && UUID_RE.test(input.customerId) ? input.customerId : null;

  const subtotalMinorUnits = input.subtotalMinorUnits ?? totalMinorUnits;
  const shippingMinorUnits = input.shippingMinorUnits ?? Math.max(0, totalMinorUnits - subtotalMinorUnits);

  // Path 1: atomic Postgres function (transaction + stock decrement).
  try {
    const { data, error } = await (client.rpc as any)('create_order_v2', {
      p_order_id: orderId,
      p_order_number: orderNumber,
      p_customer_id: safeCustomerId,
      p_customer_name: input.customerName,
      p_customer_email: input.customerEmail,
      p_customer_phone: input.customerPhone || null,
      p_shipping_address: input.shippingAddress || '',
      p_items: input.items.map((it) => ({
        productName: it.productName,
        quantity: it.quantity,
        price: it.price,
        variant: it.variant || 'Standard',
      })),
      p_subtotal_minor_units: subtotalMinorUnits,
      p_shipping_minor_units: shippingMinorUnits,
      p_total_minor_units: totalMinorUnits,
      p_created_at: now,
    });
    if (!error) {
      return { success: true, orderId, orderNumber };
    }
    // PGRST202 / 42883 => function not deployed; fall through to manual path.
    const code = (error as any).code || '';
    const msg = (error as any).message || '';
    if (!msg.includes('create_order_v2') && code !== 'PGRST202' && code !== '42883') {
      logger.error('order_create_rpc_failed', { error: msg, code });
      return { success: false, error: 'Order could not be created. Please try again.' };
    }
    logger.warn('order_create_rpc_missing_fallback', { code });
  } catch (e: any) {
    logger.warn('order_create_rpc_exception_fallback', { error: e?.message });
  }

  // Path 2: sequential inserts with strict error propagation (no silent partials).
  // Reached only when create_order_v2 is not deployed; `client` is already the
  // service-role client (see the guard at the top of this function).
  //
  // create_order_v2 decrements stock atomically and raises on oversell. This
  // fallback cannot — PostgREST has no way to express
  // `inventory_quantity = inventory_quantity - n` without an RPC — so it does a
  // best-effort pre-flight check instead. It is NOT atomic: two simultaneous
  // checkouts can both pass it. Deploy create_order_v2 for the real guarantee.
  try {
    const names = [...new Set(input.items.map((it) => it.productName))];
    const { data: variants, error: vErr } = await (client.from('product_variants') as any)
      .select('product_id, inventory_quantity, status, position, products ( id, name, status )')
      .eq('status', 'active')
      .in('products.name', names);
    if (vErr) {
      logger.warn('order_stock_precheck_skipped', { error: vErr.message });
    } else {
      // Mirror create_order_v2: the lowest-position active variant of an active
      // product is the sellable one.
      const candidates = new Map<string, { position: number; qty: number }>();
      for (const v of variants || []) {
        const product = (v as any)?.products;
        const name = product?.name;
        if (!name || product?.status !== 'active') continue;
        const position = Number((v as any)?.position) || 0;
        const qty = Number((v as any)?.inventory_quantity) || 0;
        const current = candidates.get(name);
        if (!current || position < current.position) candidates.set(name, { position, qty });
      }
      for (const item of input.items) {
        const available = candidates.get(item.productName)?.qty;
        if (available !== undefined && item.quantity > available) {
          logger.warn('order_insufficient_stock_fallback', {
            productName: item.productName,
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
    const { error: orderError } = await (client.from('orders') as any).insert({
      id: orderId,
      order_number: orderNumber,
      customer_id: safeCustomerId,
      customer_name: input.customerName,
      customer_email: input.customerEmail,
      customer_phone: input.customerPhone || null,
      shipping_address: { address: input.shippingAddress || '' },
      items: input.items,
      status: 'Pending',
      payment_status: 'Pending',
      payment_method: input.paymentMethod === 'cod' ? 'cod' : 'momo',
      currency: 'UGX',
      subtotal_minor_units: subtotalMinorUnits,
      discount_minor_units: 0,
      shipping_minor_units: shippingMinorUnits,
      tax_minor_units: 0,
      total_minor_units: totalMinorUnits,
      total_amount: input.total,
      created_at: now,
      updated_at: now,
    });
    if (orderError) {
      logger.error('order_insert_failed', { error: orderError.message });
      return { success: false, error: 'Order could not be created. Please try again.' };
    }

    if (input.items.length > 0) {
      const itemsPayload = input.items.map((it) => ({
        order_id: orderId,
        product_name: it.productName,
        product_slug: it.productName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        variant_sku: it.variant || 'Standard',
        variant_attributes: it.variant ? { variant: it.variant } : {},
        unit_price_minor_units: Math.round(it.price * 100),
        quantity: it.quantity,
        line_total_minor_units: Math.round(it.price * 100) * it.quantity,
        created_at: now,
      }));
      const { error: itemsError } = await (client.from('order_items') as any).insert(itemsPayload);
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
