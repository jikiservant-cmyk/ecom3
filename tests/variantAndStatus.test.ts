/**
 * VARIANT PRICING, STATUS VOCABULARY AND WRITE-OWNERSHIP
 *
 * Three things the live database forced:
 *
 *  1. `orders.status` / `payments.status` are lowercase. Writing `Pending` or
 *     `Paid` violates the live CHECK constraints and mixes case in one column.
 *  2. A cart may pick a specific `product_variants` row. That row's price is
 *     what the customer must be charged — never the primary variant's price and
 *     never the price the browser sent.
 *  3. No money table is writable from the browser. Admin status changes go
 *     through PATCH /api/orders, which is authorised and audit-logged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ORDER_STATUS,
  PAYMENT_STATUS,
  PAYMENT_ROW_STATUS,
  normaliseOrderStatus,
  normalisePaymentStatus,
  normalisePaymentRowStatus,
  paymentRowStatusFor,
  ADMIN_SETTABLE_ORDER_STATUSES,
} from '@/lib/status';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PRODUCT_ID = '22222222-2222-4222-8222-222222222222';
const VARIANT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_VARIANT_ID = '44444444-4444-4444-8444-444444444444';

vi.mock('@/lib/server/supabaseServer', () => ({
  getServerAdminClient: () => (globalThis as any).__fakeClient,
  getServerAnonClient: () => (globalThis as any).__fakeClient,
  isServerSupabaseConfigured: true,
  authenticateAdmin: () => (globalThis as any).__fakeAdmin ?? null,
  authenticateRequest: () => (globalThis as any).__fakeUser ?? null,
}));

vi.mock('@/lib/server/orders', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createOrderServer: vi.fn(async (input: any) => {
      (globalThis as any).__lastOrderInput = input;
      return { success: true, orderId: 'order-new', orderNumber: 'DP-NEW0-0001' };
    }),
  };
});

const CATALOG = [
  {
    id: PRODUCT_ID,
    name: 'Engoma Drum',
    status: 'active',
    // Primary variant is the CHEAP one; the customer selects a pricier one.
    product_variants: [
      { id: VARIANT_ID, price_minor_units: 1_500_000, position: 0, status: 'active' },
      { id: OTHER_VARIANT_ID, price_minor_units: 2_500_000, position: 1, status: 'active' },
    ],
  },
  {
    id: OTHER_PRODUCT_ID,
    name: 'Amadinda',
    status: 'active',
    product_variants: [{ id: '55555555-5555-4555-8555-555555555555', price_minor_units: 900_000, position: 0, status: 'active' }],
  },
];

function fakeDb(opts: { products?: any; settings?: any } = {}) {
  const sink: any[][] = [];
  const client: any = {
    from: (table: string) => {
      const calls: any[] = [];
      let op = 'select';
      const obj: any = {
        then: (resolve: any, reject: any) => {
          sink.push(calls);
          const result =
            table === 'products'
              ? opts.products ?? { data: CATALOG, error: null }
              : table === 'store_settings'
                ? { data: { settings: opts.settings ?? {} }, error: null }
                : { data: null, error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'is', 'maybeSingle', 'order', 'limit']) {
        obj[m] = (...args: any[]) => {
          if (m === 'insert' || m === 'update' || m === 'delete') op = m;
          calls.push([m, ...args]);
          return obj;
        };
      }
      return obj;
    },
    rpc: async () => ({ data: 'order-new', error: null }),
  };
  (globalThis as any).__fakeClient = client;
  return { sink };
}

const CHECKOUT = {
  customerName: 'Amina',
  customerEmail: 'amina@example.ug',
  phone: '256700000000',
  shippingAddress: 'Kampala Road 12',
  paymentMethod: 'momo',
};

async function createOrder(overrides: Record<string, unknown> = {}) {
  const { POST } = await import('@/app/api/orders/route');
  const res = await POST(
    new Request('https://shop.example.com/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...CHECKOUT,
        items: [{ productId: PRODUCT_ID, productName: 'Engoma Drum', quantity: 1 }],
        ...overrides,
      }),
    }) as any
  );
  return { res, body: await res.json() };
}

beforeEach(() => {
  (globalThis as any).__lastOrderInput = undefined;
  fakeDb();
});

// ---------------------------------------------------------------------------
// 1. One vocabulary, lowercase, matching the live CHECK constraints.
// ---------------------------------------------------------------------------
describe('status vocabulary matches the live database', () => {
  it('only knows lowercase order statuses', () => {
    for (const value of Object.values(ORDER_STATUS)) {
      expect(value).toBe(value.toLowerCase());
    }
    expect(Object.values(ORDER_STATUS)).toEqual([
      'pending',
      'processing',
      'shipped',
      'delivered',
      'cancelled',
    ]);
  });

  it('says paid, not success, on the order', () => {
    expect(PAYMENT_STATUS.paid).toBe('paid');
    expect(Object.values(PAYMENT_STATUS)).not.toContain('success');
  });

  it('keeps success for the payments ledger row, which is a different thing', () => {
    expect(PAYMENT_ROW_STATUS.success).toBe('success');
    expect(paymentRowStatusFor(PAYMENT_STATUS.paid)).toBe('success');
    expect(paymentRowStatusFor(PAYMENT_STATUS.failed)).toBe('failed');
  });

  it('normalises any casing coming from an old client', () => {
    expect(normaliseOrderStatus('Pending')).toBe('pending');
    expect(normaliseOrderStatus('CANCELLED')).toBe('cancelled');
    expect(normalisePaymentStatus('Paid')).toBe('paid');
    expect(normalisePaymentRowStatus('Success')).toBe('success');
  });

  it('never invents a paid order from junk input', () => {
    expect(normaliseOrderStatus('teleported')).toBe('pending');
    expect(normalisePaymentStatus(undefined)).toBe('pending');
    expect(normalisePaymentStatus('paid-ish')).toBe('pending');
  });

  it('lets an admin set only the fulfilment statuses', () => {
    expect(ADMIN_SETTABLE_ORDER_STATUSES).toContain('delivered');
    expect(ADMIN_SETTABLE_ORDER_STATUSES).not.toContain('refunded');
  });
});

// ---------------------------------------------------------------------------
// 2. Variant pricing — the selected variant is the price AND the stock line.
// ---------------------------------------------------------------------------
describe('checkout charges the selected variant, not the primary one', () => {
  it('uses the chosen variant price', async () => {
    const { res, body } = await createOrder({
      items: [{ productId: PRODUCT_ID, variantId: OTHER_VARIANT_ID, productName: 'Engoma Drum', quantity: 1 }],
      total: 35_000, // 25,000 drum + 10,000 delivery
    });
    expect(res.status).toBe(201);
    expect(body.success).toBe(true);
    const input: any = (globalThis as any).__lastOrderInput;
    expect(input.items[0].price).toBe(25_000);
    expect(input.items[0].variantId).toBe(OTHER_VARIANT_ID);
    expect(input.totalMinorUnits).toBe(3_500_000);
  });

  it('falls back to the primary variant when none is chosen', async () => {
    const { res } = await createOrder({ total: 25_000 });
    expect(res.status).toBe(201);
    const input: any = (globalThis as any).__lastOrderInput;
    expect(input.items[0].price).toBe(15_000);
  });

  it('refuses a variant that belongs to a different product', async () => {
    const { res, body } = await createOrder({
      items: [
        {
          productId: OTHER_PRODUCT_ID,
          variantId: OTHER_VARIANT_ID, // a Drum variant, not an Amadinda one
          productName: 'Amadinda',
          quantity: 1,
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/not available/i);
    expect((globalThis as any).__lastOrderInput).toBeUndefined();
  });

  it('refuses a variant id that does not exist', async () => {
    const { res } = await createOrder({
      items: [{ productId: PRODUCT_ID, variantId: '99999999-9999-4999-8999-999999999999', productName: 'Engoma Drum', quantity: 1 }],
    });
    expect(res.status).toBe(400);
  });

  it('refuses an inactive variant', async () => {
    fakeDb({
      products: [
        {
          ...CATALOG[0],
          product_variants: [
            { id: VARIANT_ID, price_minor_units: 1_500_000, position: 0, status: 'active' },
            { id: OTHER_VARIANT_ID, price_minor_units: 2_500_000, position: 1, status: 'archived' },
          ],
        },
      ],
    });
    const { res } = await createOrder({
      items: [{ productId: PRODUCT_ID, variantId: OTHER_VARIANT_ID, productName: 'Engoma Drum', quantity: 1 }],
    });
    expect(res.status).toBe(400);
  });

  it('refuses a malformed id instead of silently repricing by name', async () => {
    const bad = await createOrder({
      items: [{ productId: 'prod-1', productName: 'Engoma Drum', quantity: 1 }],
    });
    expect(bad.res.status).toBe(400);
    expect(bad.body.error).toMatch(/product identifier/i);

    const badVariant = await createOrder({
      items: [{ productId: PRODUCT_ID, variantId: 'cheap', productName: 'Engoma Drum', quantity: 1 }],
    });
    expect(badVariant.res.status).toBe(400);
    expect(badVariant.body.error).toMatch(/variant identifier/i);
  });

  it('ignores a price sent by the browser even with a variant', async () => {
    const { res } = await createOrder({
      items: [
        { productId: PRODUCT_ID, variantId: OTHER_VARIANT_ID, productName: 'Engoma Drum', quantity: 1, price: 1 },
      ],
      total: 100,
    });
    // The server recomputes 35,000 and rejects the claimed 100.
    expect(res.status).toBe(400);
    expect((globalThis as any).__lastOrderInput).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. The browser cannot write the money tables any more.
// ---------------------------------------------------------------------------
describe('admin status changes go through the audited API', () => {
  it('updateOrderStatusInDb calls PATCH /api/orders and never touches Supabase directly', async () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/supabaseDb.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function updateOrderStatusInDb'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    expect(body).toContain("method: 'PATCH'");
    expect(body).toContain("'/api/orders'");
    expect(body).not.toMatch(/from\('orders'\)\s*\)?\s*\.update/);
  });

  it('no browser module inserts or updates orders directly', () => {
    const dirs = ['lib', 'components'];
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const file of fs.readdirSync(path.join(process.cwd(), dir))) {
        if (!/\.(ts|tsx)$/.test(file)) continue;
        const full = path.join(process.cwd(), dir, file);
        const src = fs.readFileSync(full, 'utf8');
        // Only the server-side modules may name these tables as write targets.
        if (/from\(['"]orders['"]\)[\s\S]{0,80}\.(insert|update|delete)\(/.test(src)) offenders.push(full);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the pending migration never reintroduces Title Case statuses', () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20261020_finish_alignment.sql'),
      'utf8'
    );
    const writes = sql.match(/(status|payment_status)\s*(:=|=)\s*'[^']+'/g) || [];
    for (const w of writes) {
      expect(w).not.toMatch(/'Pending'|'Paid'|'Failed'|'Refunded'|'Cancelled'|'Processing'|'Shipped'|'Delivered'/);
    }
  });

  it('the migration tightens the money tables instead of widening them', () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20261020_finish_alignment.sql'),
      'utf8'
    );
    expect(sql).toMatch(/REVOKE ALL ON public\.payments FROM anon, authenticated/);
    expect(sql).toMatch(/REVOKE ALL ON public\.refunds\s+FROM anon, authenticated/);
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE[^;]*ON public\.orders, public\.order_items/);
    expect(sql).toContain('"Orders: owner or admin read"');
    // No policy may grant INSERT/UPDATE/DELETE on orders to the browser.
    const orderWritePolicy = /CREATE POLICY[^;]+ON public\.orders\s+FOR (INSERT|UPDATE|DELETE|ALL)/i;
    expect(sql).not.toMatch(orderWritePolicy);
  });

  it('create_order_v2 records the variant and decrements that variant only', () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20261020_finish_alignment.sql'),
      'utf8'
    );
    expect(sql).toMatch(/order_id, product_id, variant_id, product_name/);
    expect(sql).toMatch(/UPDATE public\.product_variants[\s\S]{0,140}inventory_quantity >= item\.quantity/);
    expect(sql).toMatch(/pv\.product_id = v_product_id AND pv\.status = 'active'/);
  });
});
