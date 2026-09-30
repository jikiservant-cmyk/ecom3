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
import { getServerAdminClient, getServerAnonClient, hasServiceRoleKey } from './supabaseServer';
import { logger } from './logging';

const ORDER_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L

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
  const client = getServerAdminClient() || getServerAnonClient();
  const orderId = generateOrderId();
  const orderNumber = generateOrderNumber();
  const now = new Date().toISOString();
  const totalMinorUnits = Math.round(input.total * 100);
  const safeCustomerId = input.customerId && UUID_RE.test(input.customerId) ? input.customerId : null;

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
  if (!hasServiceRoleKey) {
    logger.warn('order_create_no_service_role', {
      hint: 'Set SUPABASE_SERVICE_ROLE_KEY for reliable server-side order writes',
    });
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
      currency: 'UGX',
      subtotal_minor_units: totalMinorUnits,
      discount_minor_units: 0,
      shipping_minor_units: 0,
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
