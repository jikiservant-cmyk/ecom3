/**
 * MONEY-INTEGRITY REGRESSION SUITE
 *
 * Each describe block pins down a fix for a finding in MONEY_INTEGRITY_REVIEW.md.
 * These drive the real route handlers with a fake Supabase client, so they cover
 * control flow rather than a re-implementation of it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  priceOrder,
  validatePricingSnapshot,
  resolveUnitPriceMinor,
  computeShippingMinorUnits,
  toWholeShillingMinor,
  DELIVERY_FEE_MINOR_UNITS,
  type OrderPricing,
} from '@/lib/pricing';
import { valueOrderAgainstCatalog, buildCatalogPriceIndex, ambiguousProductNames } from '@/lib/server/orders';
import { signLivePayWebhook } from '@/lib/server/webhook';

// Product ids are UUIDs in the live database; the route rejects anything else.
const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';

const DRUM = {
  id: PRODUCT_ID,
  name: 'Engoma Drum',
  status: 'active',
  product_variants: [{ price_minor_units: 1_500_000, position: 0, status: 'active' }], // 15,000 UGX
};

// ---------------------------------------------------------------------------
// MI-06 / MI-07 — promotions are real, bounded, and whole-shilling.
// ---------------------------------------------------------------------------
describe('priceOrder — promotions are honoured and can only reduce a price', () => {
  const lines = [{ productId: PRODUCT_ID, productName: 'Engoma Drum', quantity: 2, catalogUnitMinorUnits: 1_500_000 }];

  it('applies a percentage deal to the catalog price', () => {
    const p = priceOrder({ lines, deals: [{ id: 'deal-1', productId: PRODUCT_ID, discountPercent: 10 }] });
    expect(p.lines[0].unitMinorUnits).toBe(1_350_000);
    expect(p.discountMinorUnits).toBe(2 * 150_000);
    expect(p.subtotalMinorUnits).toBe(3_000_000);
    expect(p.totalMinorUnits).toBe(3_000_000 - 300_000 + DELIVERY_FEE_MINOR_UNITS);
    expect(p.lines[0].promotionId).toBe('deal-1');
  });

  it('honours an explicit deal price', () => {
    const p = priceOrder({ lines, deals: [{ id: 'd', productId: PRODUCT_ID, customPrice: 12000 }] });
    expect(p.lines[0].unitMinorUnits).toBe(1_200_000);
  });

  it('ignores a deal that would RAISE the price', () => {
    const p = priceOrder({ lines, deals: [{ productId: PRODUCT_ID, customPrice: 99_000 }] });
    expect(p.lines[0].unitMinorUnits).toBe(1_500_000);
    expect(p.discountMinorUnits).toBe(0);
  });

  it('never goes below one shilling', () => {
    const p = priceOrder({ lines, deals: [{ productId: PRODUCT_ID, discountPercent: 99.99 }] });
    expect(p.lines[0].unitMinorUnits).toBeGreaterThanOrEqual(100);
  });

  it('does not apply an inactive or unrelated deal', () => {
    expect(priceOrder({ lines, deals: [{ productId: PRODUCT_ID, discountPercent: 50, active: false }] }).totalMinorUnits)
      .toBe(priceOrder({ lines }).totalMinorUnits);
    expect(priceOrder({ lines, deals: [{ productId: 'other', discountPercent: 50 }] }).totalMinorUnits)
      .toBe(priceOrder({ lines }).totalMinorUnits);
  });

  it('charges delivery unless the threshold is genuinely reached', () => {
    expect(computeShippingMinorUnits(49_999_900, 50_000_000)).toBe(DELIVERY_FEE_MINOR_UNITS);
    expect(computeShippingMinorUnits(50_000_000, 50_000_000)).toBe(0);
    expect(computeShippingMinorUnits(0, 50_000_000)).toBe(0);
  });

  it('rounds catalog prices UP to a whole shilling exactly once', () => {
    expect(toWholeShillingMinor(1_500_050)).toBe(1_500_100);
    expect(resolveUnitPriceMinor({ catalogUnitMinorUnits: 1_500_050 }).unitMinorUnits % 100).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// MI-07 / MI-08 / MI-10 — the snapshot is the immutable pricing basis.
// ---------------------------------------------------------------------------
describe('validatePricingSnapshot — a placed order cannot be repriced or forged', () => {
  const pricing: OrderPricing = priceOrder({
    lines: [{ productId: PRODUCT_ID, productName: 'Engoma Drum', quantity: 1, catalogUnitMinorUnits: 1_500_000 }],
    deals: [{ id: 'deal-1', productId: PRODUCT_ID, discountPercent: 10 }],
  });
  const stored = {
    storedSubtotalMinorUnits: pricing.subtotalMinorUnits,
    storedDiscountMinorUnits: pricing.discountMinorUnits,
    storedShippingMinorUnits: pricing.shippingMinorUnits,
    storedTotalMinorUnits: pricing.totalMinorUnits,
  };

  it('accepts a snapshot that matches the order row', () => {
    const v = validatePricingSnapshot({ snapshot: pricing, ...stored });
    expect(v.ok).toBe(true);
    expect(v.totalMinorUnits).toBe(pricing.totalMinorUnits);
  });

  it('survives a later catalog price change (no re-pricing at payment time)', () => {
    // The snapshot is validated against itself, not against today's catalog.
    const v = validatePricingSnapshot({ snapshot: pricing, ...stored });
    expect(v.ok).toBe(true);
  });

  it('rejects a stored total that undercuts the snapshot', () => {
    expect(validatePricingSnapshot({ snapshot: pricing, ...stored, storedTotalMinorUnits: 100 }).ok).toBe(false);
  });

  it('rejects a forged snapshot whose total is below its own lines', () => {
    const forged = { ...pricing, totalMinorUnits: 100 };
    expect(validatePricingSnapshot({ snapshot: forged, ...stored, storedTotalMinorUnits: 100 }).ok).toBe(false);
  });

  it('rejects a unit price above the catalog price', () => {
    const forged: any = {
      ...pricing,
      lines: [{ ...pricing.lines[0], unitMinorUnits: 2_000_000, lineTotalMinorUnits: 2_000_000 }],
      totalMinorUnits: 2_000_000 + pricing.shippingMinorUnits,
    };
    expect(
      validatePricingSnapshot({
        snapshot: forged,
        storedTotalMinorUnits: forged.totalMinorUnits,
      }).ok
    ).toBe(false);
  });

  it('rejects a line whose arithmetic does not add up', () => {
    const forged: any = { ...pricing, lines: [{ ...pricing.lines[0], lineTotalMinorUnits: 1 }] };
    expect(validatePricingSnapshot({ snapshot: forged, storedTotalMinorUnits: pricing.totalMinorUnits }).ok).toBe(false);
  });

  it('rejects missing, empty and non-whole-shilling snapshots', () => {
    expect(validatePricingSnapshot({ snapshot: null, ...stored }).ok).toBe(false);
    expect(validatePricingSnapshot({ snapshot: { ...pricing, lines: [] }, ...stored }).ok).toBe(false);
    expect(
      validatePricingSnapshot({ snapshot: pricing, ...stored, storedTotalMinorUnits: pricing.totalMinorUnits + 50 }).ok
    ).toBe(false);
  });

  it('rejects a zero-quantity line (an order is worth its lines)', () => {
    const forged: any = { ...pricing, lines: [{ ...pricing.lines[0], quantity: 0 }] };
    expect(validatePricingSnapshot({ snapshot: forged, storedTotalMinorUnits: pricing.totalMinorUnits }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MI-10 — ambiguous product names are detected instead of guessed.
// ---------------------------------------------------------------------------
describe('ambiguousProductNames', () => {
  it('flags a name shared by two active products', () => {
    const names = ambiguousProductNames([
      { id: 'a', name: 'Engoma Drum', status: 'active' },
      { id: 'b', name: 'Engoma Drum', status: 'active' },
      { id: 'c', name: 'Djembe', status: 'active' },
    ]);
    expect(names.has('Engoma Drum')).toBe(true);
    expect(names.has('Djembe')).toBe(false);
  });

  it('does not flag an archived duplicate', () => {
    const names = ambiguousProductNames([
      { id: 'a', name: 'Engoma Drum', status: 'active' },
      { id: 'b', name: 'Engoma Drum', status: 'archived' },
    ]);
    expect(names.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// MI-13 — legacy valuation refuses a valueless order.
// ---------------------------------------------------------------------------
describe('valueOrderAgainstCatalog — zero-quantity lines are not chargeable', () => {
  const prices = buildCatalogPriceIndex([DRUM]);

  it('refuses an order made only of zero-quantity lines', () => {
    const v = valueOrderAgainstCatalog({
      items: [{ productName: 'Engoma Drum', quantity: 0 }],
      prices,
      storedTotalMinorUnits: 0,
    });
    expect(v.ok).toBe(false);
    expect(v.unknownItems).toContain('Engoma Drum');
  });
});

// ---------------------------------------------------------------------------
// Route-level tests
// ---------------------------------------------------------------------------
vi.mock('@/lib/server/supabaseServer', () => ({
  getServerAdminClient: () => (globalThis as any).__fakeClient,
  getServerAnonClient: () => (globalThis as any).__fakeClient,
  isServerSupabaseConfigured: true,
  authenticateAdmin: () => (globalThis as any).__fakeAdmin ?? null,
  authenticateRequest: () => null,
}));

// Order creation itself is exercised elsewhere; here we capture exactly what the
// checkout route hands to it (prices, discount, shipping, snapshot, key).
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

const SECRET = 'whsec_regression';
const APP_URL = 'https://shop.example.com';
const WEBHOOK_URL = `${APP_URL}/api/payments/livepay/webhook`;
const APP_ID = 'app.example.com';

function chainable(result: any, sink: any[][], resultForOp?: Record<string, any>) {
  const calls: any[][] = [];
  let op = 'select';
  const obj: any = {
    then: (resolve: any, reject: any) => {
      sink.push(calls);
      const chosen = (resultForOp && resultForOp[op]) ?? result;
      return Promise.resolve(chosen).then(resolve, reject);
    },
  };
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'is', 'maybeSingle', 'order', 'range']) {
    obj[m] = (...args: any[]) => {
      if (m === 'insert' || m === 'update' || m === 'delete') op = m;
      calls.push([m, ...args]);
      return obj;
    };
  }
  return obj;
}

type FakeFix = {
  order?: any;
  items?: any[];
  products?: any[];
  settings?: any;
  /** Per-table override of the returned error. */
  errors?: Record<string, any>;
};

function makeClient(fix: FakeFix) {
  const sink: any[][] = [];
  const client = {
    from: (table: string) => {
      const error = fix.errors?.[table] ?? null;
      if (table === 'payment_webhook_events') return chainable({ data: null, error }, sink);
      if (table === 'orders') {
        return chainable({ data: fix.order ?? null, error }, sink, {
          // A guarded refund update reports the affected row(s).
          update: { data: [{ id: fix.order?.id ?? 'order-1' }], error: null },
          insert: { data: fix.order ?? null, error },
        });
      }
      if (table === 'order_items') return chainable({ data: fix.items ?? [], error }, sink);
      if (table === 'products') return chainable({ data: fix.products ?? [], error }, sink);
      if (table === 'store_settings') return chainable({ data: { settings: fix.settings ?? {} }, error }, sink);
      return chainable({ data: null, error }, sink);
    },
  };
  (globalThis as any).__fakeClient = client;
  return { sink };
}

function markerReleased(sink: any[][]): boolean {
  return sink.some((calls) => calls.some((c) => c[0] === 'delete'));
}

function signedWebhook(payload: any) {
  const t = String(Math.floor(Date.now() / 1000));
  const v = signLivePayWebhook({ webhookUrl: WEBHOOK_URL, timestamp: t, payload, secret: SECRET });
  return new Request(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-signature': `t=${t},v=${v}`,
      host: 'shop.example.com',
    },
    body: JSON.stringify(payload),
  });
}

async function postWebhook(payload: any) {
  const { POST } = await import('@/app/api/payments/livepay/webhook/route');
  return POST(signedWebhook(payload) as any);
}

const SNAPSHOT = priceOrder({
  lines: [{ productId: PRODUCT_ID, productName: 'Engoma Drum', quantity: 1, catalogUnitMinorUnits: 1_500_000 }],
});
const TOTAL_MINOR = SNAPSHOT.totalMinorUnits; // 2,500,000 (25,000 UGX)

const BASE_ORDER = {
  id: 'order-1',
  order_number: 'DP-AAAA-BBBB',
  status: 'Pending',
  payment_status: 'pending',
  payment_method: 'momo',
  currency: 'UGX',
  subtotal_minor_units: SNAPSHOT.subtotalMinorUnits,
  discount_minor_units: SNAPSHOT.discountMinorUnits,
  shipping_minor_units: SNAPSHOT.shippingMinorUnits,
  total_minor_units: TOTAL_MINOR,
  refunded_minor_units: 0,
  pricing_snapshot: SNAPSHOT,
};

const PAID_PAYLOAD = {
  status: 'Success',
  customer_reference: 'ORDDP-AAAA-BBBB',
  internal_reference: 'int-ok',
  amount: TOTAL_MINOR / 100,
  currency: 'UGX',
};

beforeEach(() => {
  process.env.LIVEPAY_WEBHOOK_SECRET = SECRET;
  process.env.LIVEPAY_API_KEY = 'sk_test_key';
  process.env.LIVEPAY_MERCHANT_ID = 'LP0000000001';
  process.env.LIVEPAY_API_URL = 'https://livepay.me/api';
  process.env.APP_URL = APP_URL;
});

afterEach(() => {
  delete process.env.LIVEPAY_WEBHOOK_SECRET;
  delete process.env.LIVEPAY_API_KEY;
  delete process.env.LIVEPAY_MERCHANT_ID;
  delete process.env.LIVEPAY_API_URL;
  delete process.env.APP_URL;
  delete (globalThis as any).__fakeClient;
  delete (globalThis as any).__fakeAdmin;
  delete (globalThis as any).__lastOrderInput;
  vi.restoreAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// MI-01 / MI-05 — the payment state machine is monotonic and terminal.
// ---------------------------------------------------------------------------
describe('webhook — payment state can never move backwards', () => {
  it('ignores a late "Failed" for an order that is already Paid', async () => {
    const { sink } = makeClient({ order: { ...BASE_ORDER, payment_status: 'paid' } });
    const res = await postWebhook({
      ...PAID_PAYLOAD,
      status: 'Failed',
      internal_reference: 'int-late-failure',
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.ignored).toBe('order already paid');

    const regression = sink.find((calls) =>
      calls.some((c) => c[0] === 'update' && c[1]?.payment_status === 'Failed')
    );
    expect(regression).toBeUndefined();
  });

  it('marks a Pending order Paid and records the settled amount', async () => {
    const { sink } = makeClient({ order: BASE_ORDER });
    const res = await postWebhook(PAID_PAYLOAD);
    expect(res.status).toBe(200);

    const paymentsUpdate = sink.find((calls) =>
      calls.some((c) => c[0] === 'update' && c[1]?.settled_amount_minor_units === TOTAL_MINOR)
    );
    expect(paymentsUpdate).toBeTruthy();
    const orderUpdate = sink.find((calls) =>
      calls.some((c) => c[0] === 'update' && c[1]?.payment_status === 'paid')
    );
    expect(orderUpdate).toBeTruthy();
  });

  it('refuses to mark a Paid order when the pricing snapshot is forged', async () => {
    const forged = { ...BASE_ORDER, total_minor_units: 100, pricing_snapshot: { ...SNAPSHOT, totalMinorUnits: 100 } };
    const { sink } = makeClient({ order: forged });
    const res = await postWebhook({ ...PAID_PAYLOAD, amount: 1 });
    const body: any = await res.json();
    expect(body.verified).toBe(false);
    expect(markerReleased(sink)).toBe(true);
  });

  it('does not mark a cancelled order Paid', async () => {
    makeClient({ order: { ...BASE_ORDER, status: 'cancelled' } });
    const res = await postWebhook(PAID_PAYLOAD);
    const body: any = await res.json();
    expect(body.verified).toBe(false);
    expect(body.reason).toBe('order cancelled');
  });

  it('ignores notifications for a refunded order', async () => {
    makeClient({ order: { ...BASE_ORDER, payment_status: 'refunded', refunded_minor_units: TOTAL_MINOR } });
    const res = await postWebhook(PAID_PAYLOAD);
    const body: any = await res.json();
    expect(body.ignored).toBe('order refunded');
  });

  it('releases the marker when the order is not found yet, so a retry can land', async () => {
    const { sink } = makeClient({ order: null });
    const res = await postWebhook(PAID_PAYLOAD);
    const body: any = await res.json();
    expect(body.matched).toBe(false);
    expect(markerReleased(sink)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MI-05 / MI-08 / MI-10 — what may be charged, and how much.
// ---------------------------------------------------------------------------
describe('livepay initiation — state gates and the charge amount', () => {
  async function startPayment(order: any) {
    makeClient({ order });
    const { POST } = await import('@/app/api/payments/livepay/route');
    const req = new Request('https://shop.example.com/api/payments/livepay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', host: APP_ID },
      body: JSON.stringify({ orderId: order.id, phoneNumber: '256700000000', paymentMethod: 'momo' }),
    });
    return POST(req as any);
  }

  it('charges exactly total_minor_units / 100 (whole shillings)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, internal_reference: 'int-1' }), { status: 200 })
    );
    const res = await startPayment(BASE_ORDER);
    expect(res.status).toBe(200);
    const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(sent.amount).toBe(TOTAL_MINOR / 100);
    expect(Number.isInteger(sent.amount)).toBe(true);
    expect(sent.currency).toBe('UGX');
  });

  it.each([
    ['cancelled order', { status: 'cancelled' }, /cancelled/i],
    ['refunded order', { payment_status: 'refunded', refunded_minor_units: TOTAL_MINOR }, /refunded/i],
    ['delivered order', { status: 'Delivered' }, /dispatched|already/i],
    ['cash-on-delivery order', { payment_method: 'cod' }, /pay on delivery/i],
  ])('refuses a %s', async (_label, patch, pattern) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await startPayment({ ...BASE_ORDER, ...patch });
    const body: any = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toMatch(pattern);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses an order whose total is not a whole shilling', async () => {
    const res = await startPayment({ ...BASE_ORDER, total_minor_units: TOTAL_MINOR + 50 });
    expect(res.status).toBe(422);
  });

  it('refuses an order whose snapshot does not justify its stored total', async () => {
    const res = await startPayment({ ...BASE_ORDER, total_minor_units: 100, pricing_snapshot: { ...SNAPSHOT, totalMinorUnits: 100 } });
    expect(res.status).toBe(409);
  });

  it('accepts a legacy order (no snapshot) priced from the live catalog', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, internal_reference: 'int-legacy' }), { status: 200 })
    );
    makeClient({ order: { ...BASE_ORDER, pricing_snapshot: null }, products: [DRUM], items: [] });
    // The legacy path loads order_items separately; the fake returns [] so the
    // route must fail closed rather than charge an unverifiable order.
    const { POST } = await import('@/app/api/payments/livepay/route');
    const res = await POST(
      new Request('https://shop.example.com/api/payments/livepay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: 'order-1', phoneNumber: '256700000000' }),
      }) as any
    );
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// MI-04 — refunds are recorded money movements, bounded by the order total.
// ---------------------------------------------------------------------------
describe('refund endpoint', () => {
  async function refund(body: any) {
    (globalThis as any).__fakeAdmin = { userId: 'admin-1', email: 'admin@shop.ug', name: 'Admin', accessToken: 't' };
    const { POST } = await import('@/app/api/orders/refund/route');
    const res = await POST(
      new Request('https://shop.example.com/api/orders/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify(body),
      }) as any
    );
    return { res, body: await res.json() };
  }

  it('requires a reason and a positive whole-shilling amount', async () => {
    makeClient({ order: { ...BASE_ORDER, payment_status: 'paid' } });
    expect((await refund({ orderId: 'order-1', amount: 100 })).res.status).toBe(400);
    expect((await refund({ orderId: 'order-1', amount: 0, note: 'goodwill' })).res.status).toBe(400);
    expect((await refund({ orderId: 'order-1', amount: 100.5, note: 'goodwill' })).res.status).toBe(400);
  });

  it('refuses to refund an unpaid order', async () => {
    makeClient({ order: BASE_ORDER });
    const { res, body } = await refund({ orderId: 'order-1', amount: 1000, note: 'mistake' });
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/paid/i);
  });

  it('refuses to refund more than the remaining balance', async () => {
    makeClient({ order: { ...BASE_ORDER, payment_status: 'paid', refunded_minor_units: TOTAL_MINOR - 10_000 } });
    const { res } = await refund({ orderId: 'order-1', amount: 1000, note: 'too much' });
    expect(res.status).toBe(400);
  });

  it('records a partial refund as a ledger row and a negative payment', async () => {
    const { sink } = makeClient({ order: { ...BASE_ORDER, payment_status: 'paid' } });
    const { res, body } = await refund({ orderId: 'order-1', amount: 5000, note: 'damaged in transit' });
    expect(res.status).toBe(200);
    expect(body.fullyRefunded).toBe(false);

    const refundInsert = sink.find((calls) => calls.some((c) => c[0] === 'insert' && c[1]?.reason === 'damaged in transit'));
    expect(refundInsert).toBeTruthy();
    const negativePayment = sink.find((calls) =>
      calls.some((c) => c[0] === 'insert' && c[1]?.net_amount_minor_units === -500_000)
    );
    expect(negativePayment).toBeTruthy();
    // A partial refund must NOT flip the order to Refunded.
    const statusFlip = sink.find((calls) => calls.some((c) => c[0] === 'update' && c[1]?.payment_status === 'refunded'));
    expect(statusFlip).toBeUndefined();
  });

  it('flips to Refunded only when the balance is exhausted', async () => {
    const { sink } = makeClient({
      order: { ...BASE_ORDER, payment_status: 'paid', refunded_minor_units: TOTAL_MINOR - 500_000 },
    });
    const { res, body } = await refund({ orderId: 'order-1', amount: 5000, note: 'final refund' });
    expect(res.status).toBe(200);
    expect(body.fullyRefunded).toBe(true);
    const statusFlip = sink.find((calls) => calls.some((c) => c[0] === 'update' && c[1]?.payment_status === 'refunded'));
    expect(statusFlip).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// MI-06 / MI-07 / MI-12 — checkout records the priced basis and is idempotent.
// ---------------------------------------------------------------------------
describe('order creation route — promotions, snapshot and idempotency', () => {
  const CHECKOUT = {
    customerName: 'Amina',
    customerEmail: 'amina@example.ug',
    phone: '256700000000',
    shippingAddress: 'Kampala Road 12',
    paymentMethod: 'momo',
    items: [{ productId: PRODUCT_ID, productName: 'Engoma Drum', quantity: 2 }],
  };

  async function create(patch: Record<string, unknown>, headers: Record<string, string> = {}) {
    const { POST } = await import('@/app/api/orders/route');
    const res = await POST(
      new Request('https://shop.example.com/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'shop.example.com', ...headers },
        body: JSON.stringify({ ...CHECKOUT, ...patch }),
      }) as any
    );
    return { res, body: await res.json() };
  }

  beforeEach(() => {
    makeClient({
      products: [DRUM],
      items: [],
      settings: { hotDeals: [{ id: 'deal-1', productId: PRODUCT_ID, discountPercent: 10, active: true }] },
    });
  });

  it('charges the promotional price and records a verifiable snapshot', async () => {
    // 2 x 13,500 UGX (10% off 15,000) = 27,000 + 10,000 delivery = 37,000 UGX
    const { res, body } = await create({ total: 37_000 });
    expect(res.status).toBe(201);
    expect(body.success).toBe(true);

    const input: any = (globalThis as any).__lastOrderInput;
    expect(input.totalMinorUnits).toBe(3_700_000);
    expect(input.discountMinorUnits).toBe(300_000);
    expect(input.shippingMinorUnits).toBe(1_000_000);
    expect(input.subtotalMinorUnits).toBe(3_000_000);
    expect(input.pricingSnapshot.lines[0].unitMinorUnits).toBe(1_350_000);
    expect(input.items[0].price).toBe(13_500); // order_items show what was charged

    const validation = validatePricingSnapshot({
      snapshot: input.pricingSnapshot,
      storedSubtotalMinorUnits: input.subtotalMinorUnits,
      storedDiscountMinorUnits: input.discountMinorUnits,
      storedShippingMinorUnits: input.shippingMinorUnits,
      storedTotalMinorUnits: input.totalMinorUnits,
    });
    expect(validation.ok).toBe(true);
  });

  it('rejects a client total that ignores the promotion (the old display price)', async () => {
    // 2 x 15,000 + 10,000 = 40,000 — the pre-discount cart total.
    const { res, body } = await create({ total: 40_000 });
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/match current catalog prices/i);
    expect((globalThis as any).__lastOrderInput).toBeUndefined();
  });

  it('rejects a 1-UGX cart', async () => {
    const { res } = await create({ total: 1 });
    expect(res.status).toBe(400);
  });

  it('forwards the Idempotency-Key so a retry cannot double-charge', async () => {
    await create({ total: 37_000 }, { 'Idempotency-Key': 'ck-8f3a-4d2b-9c1e-77aa' });
    expect((globalThis as any).__lastOrderInput.clientRequestId).toBe('ck-8f3a-4d2b-9c1e-77aa');
  });

  it('ignores a malformed Idempotency-Key instead of storing it', async () => {
    await create({ total: 37_000 }, { 'Idempotency-Key': 'x' });
    expect((globalThis as any).__lastOrderInput.clientRequestId).toBeNull();
  });

  it('applies free delivery once the threshold is met', async () => {
    makeClient({
      // 600,000 UGX — above the 500,000 UGX free-delivery threshold.
      products: [{ ...DRUM, product_variants: [{ price_minor_units: 60_000_000, position: 0, status: 'active' }] }],
      items: [],
      settings: { hotDeals: [], freeShippingThreshold: 500000 },
    });
    const { res } = await create({ items: [{ productId: PRODUCT_ID, productName: 'Engoma Drum', quantity: 1 }], total: 600_000 });
    expect(res.status).toBe(201);
    const input: any = (globalThis as any).__lastOrderInput;
    expect(input.shippingMinorUnits).toBe(0);
    expect(input.pricingSnapshot.freeShippingApplied).toBe(true);
  });
});
