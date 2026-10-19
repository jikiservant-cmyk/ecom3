/**
 * ADVERSARIAL MONEY-INTEGRITY PROBES
 *
 * These tests do not describe desired behaviour — they pin down behaviour that
 * is currently WRONG, so the fix cannot silently regress. Each one is a
 * reproduction of a way the app mis-handles money today.
 *
 * Run: npx vitest run tests/moneyIntegrity.challenge.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  computeOrderTotals,
  valueOrderAgainstCatalog,
  buildCatalogPriceIndex,
  reconcilePaymentAmount,
  FLAT_DELIVERY_FEE_MINOR_UNITS,
} from '@/lib/server/orders';
import { signLivePayWebhook } from '@/lib/server/webhook';

const DRUM = {
  id: 'prod-1',
  name: 'Engoma Drum',
  status: 'active',
  product_variants: [{ price_minor_units: 1_500_000, position: 0, status: 'active' }], // 15,000 UGX
};

const indexOf = (products: any[]) => buildCatalogPriceIndex(products);
const CATALOG_TOTAL = computeOrderTotals([1_500_000]).totalMinorUnits;

// ---------------------------------------------------------------------------
// 1. A total that is not a whole shilling is charged, then refused forever.
// ---------------------------------------------------------------------------
describe('PROBE 1 — fractional-shilling order is debited and can never be marked Paid', () => {
  // The pay route charges `Math.round(total_amount)` (whole UGX) because LivePay
  // takes integer amounts; the webhook then demands minor units EXACTLY equal to
  // `round(total_amount * 100)`. Any cents in the total => permanent mismatch.
  it('reconciliation fails for every 1..99-cent tail after the charge rounds', () => {
    const failures: string[] = [];
    for (let cents = 1; cents <= 99; cents++) {
      const orderTotalAmount = 29_750 + cents / 100; // what is stored on the order
      const chargedUgx = Math.round(orderTotalAmount); // what the gateway is asked for
      const r = reconcilePaymentAmount({
        orderTotalAmount,
        orderTotalMinorUnits: Math.round(orderTotalAmount * 100),
        orderCurrency: 'UGX',
        payloadAmount: chargedUgx, // gateway echoes the integer it collected
        payloadCurrency: 'UGX',
      });
      if (!r.amountOk) failures.push(`${cents}¢`);
    }
    // 99 out of 99 cent values are unpayable. The customer IS debited; the order
    // stays Pending and only a manual admin reconciliation can rescue it.
    expect(failures).toHaveLength(99);
  });

  it('shows the size of the divergence between stored total and amount collected', () => {
    const orderTotalAmount = 29_750.4;
    const charged = Math.round(orderTotalAmount);
    const r = reconcilePaymentAmount({
      orderTotalAmount,
      orderTotalMinorUnits: 2_975_040,
      orderCurrency: 'UGX',
      payloadAmount: charged,
      payloadCurrency: 'UGX',
    });
    expect(r.expectedMinor).toBe(2_975_040);
    expect(r.paidMinor).toBe(2_975_000); // 40 minor units short of the order
    expect(r.amountOk).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Overcharges are never detected — only undercharges are.
// ---------------------------------------------------------------------------
describe('PROBE 2 — no upper bound: a stale/overstated total is charged and accepted', () => {
  it('accepts an order priced 25% above today\'s catalog and charges the higher price', () => {
    const staleTotal = 2_000_000 + FLAT_DELIVERY_FEE_MINOR_UNITS; // 20,000 UGX
    const v = valueOrderAgainstCatalog({
      items: [{ productName: 'Engoma Drum', quantity: 1 }],
      prices: indexOf([DRUM]),
      storedTotalMinorUnits: staleTotal,
    });
    expect(v.ok).toBe(true); // <- deliberate: "total above catalog is allowed"
    expect(staleTotal - v.catalogTotalMinor).toBe(500_000); // 5,000 UGX overcharge

    // ...and the webhook is happy to mark it Paid at the inflated amount.
    const r = reconcilePaymentAmount({
      orderTotalAmount: staleTotal / 100,
      orderTotalMinorUnits: staleTotal,
      orderCurrency: 'UGX',
      payloadAmount: staleTotal / 100,
      payloadCurrency: 'UGX',
    });
    expect(r.amountOk).toBe(true);
  });

  it('the same rule makes every discount/voucher/promo order unpayable', () => {
    const tenPercentOff = Math.round(CATALOG_TOTAL * 0.9);
    const v = valueOrderAgainstCatalog({
      items: [{ productName: 'Engoma Drum', quantity: 1 }],
      prices: indexOf([DRUM]),
      storedTotalMinorUnits: tenPercentOff,
    });
    expect(v.ok).toBe(false); // any discount = "total no longer matches our catalog"
    expect(v.shortByMinor).toBe(CATALOG_TOTAL - tenPercentOff);
  });

  it('a catalog price rise strands orders that are already in flight', () => {
    const orderedAt = CATALOG_TOTAL; // 17,500 UGX incl. delivery
    const priceRisen = {
      ...DRUM,
      product_variants: [{ price_minor_units: 1_600_000, position: 0, status: 'active' }],
    };
    const v = valueOrderAgainstCatalog({
      items: [{ productName: 'Engoma Drum', quantity: 1 }],
      prices: indexOf([priceRisen]),
      storedTotalMinorUnits: orderedAt,
    });
    expect(v.ok).toBe(false); // pay endpoint returns 409; the order can never be paid
  });
});

// ---------------------------------------------------------------------------
// 3. Currency of valuation is "product name", which is not unique or stable.
// ---------------------------------------------------------------------------
describe('PROBE 3 — post-hoc valuation keys on product NAME, not id', () => {
  const cheapTwin = {
    id: 'prod-cheap',
    name: 'Engoma Drum',
    status: 'active',
    product_variants: [{ price_minor_units: 100_000, position: 0, status: 'active' }],
  };
  const expensiveTwin = {
    id: 'prod-expensive',
    name: 'Engoma Drum',
    status: 'active',
    product_variants: [{ price_minor_units: 1_500_000, position: 0, status: 'active' }],
  };

  it('the valuation depends on database row order for identically named products', () => {
    const order = { productName: 'Engoma Drum', quantity: 1 };
    const a = valueOrderAgainstCatalog({
      items: [order],
      prices: indexOf([cheapTwin, expensiveTwin]),
      storedTotalMinorUnits: 100_000 + FLAT_DELIVERY_FEE_MINOR_UNITS,
    });
    const b = valueOrderAgainstCatalog({
      items: [order],
      prices: indexOf([expensiveTwin, cheapTwin]),
      storedTotalMinorUnits: 100_000 + FLAT_DELIVERY_FEE_MINOR_UNITS,
    });
    // Same order, same catalog, opposite verdicts — the `.in('name', ...)` query
    // has no ORDER BY, so this is nondeterministic in production.
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. A zero-quantity line valuates to zero and passes.
// ---------------------------------------------------------------------------
describe('PROBE 4 — a zero-quantity line makes the order worth nothing, and "ok"', () => {
  it('returns ok=true with a catalog total of 0', () => {
    const v = valueOrderAgainstCatalog({
      items: [{ productName: 'Engoma Drum', quantity: 0 }],
      prices: indexOf([DRUM]),
      storedTotalMinorUnits: 0,
    });
    expect(v.ok).toBe(true);
    expect(v.catalogTotalMinor).toBe(0);
    expect(v.unknownItems).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. A paid notification can be overwritten by a later failure.
// ---------------------------------------------------------------------------
vi.mock('@/lib/server/supabaseServer', () => ({
  getServerAdminClient: () => (globalThis as any).__fakeClient,
}));

const SECRET = 'whsec_challenge';
const APP_URL = 'https://shop.example.com';
const WEBHOOK_URL = `${APP_URL}/api/payments/livepay/webhook`;

function chainable(result: any, sink: any[][]) {
  const calls: any[][] = [];
  const obj: any = {
    then: (resolve: any, reject: any) => {
      sink.push(calls);
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'maybeSingle', 'order', 'range']) {
    obj[m] = (...args: any[]) => {
      calls.push([m, ...args]);
      return obj;
    };
  }
  return obj;
}

function makeClient(fix: { order?: any; items?: any[]; products?: any[] }) {
  const sink: any[][] = [];
  const client = {
    from: (table: string) => {
      if (table === 'payment_webhook_events') return chainable({ error: null }, sink);
      if (table === 'orders') return chainable({ data: fix.order ?? null, error: null }, sink);
      if (table === 'order_items') return chainable({ data: fix.items ?? [] }, sink);
      if (table === 'products') return chainable({ data: fix.products ?? [] }, sink);
      return chainable({ data: null, error: null }, sink);
    },
  };
  (globalThis as any).__fakeClient = client;
  return { sink };
}

function signedRequest(payload: any) {
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

async function call(payload: any) {
  const { POST } = await import('@/app/api/payments/livepay/webhook/route');
  return POST(signedRequest(payload) as any);
}

function markerReleased(sink: any[][]): boolean {
  return sink.some((calls) => calls.some((c) => c[0] === 'delete'));
}

const PAID_ORDER = {
  id: 'order-1',
  order_number: 'DP-AAAA-BBBB',
  payment_status: 'Paid',
  total_amount: CATALOG_TOTAL / 100,
  total_minor_units: CATALOG_TOTAL,
  currency: 'UGX',
};

const CATALOG = [DRUM];
const DRUM_ITEM = { product_name: 'Engoma Drum', quantity: 1 };

beforeEach(() => {
  process.env.LIVEPAY_WEBHOOK_SECRET = SECRET;
  process.env.APP_URL = APP_URL;
});

afterEach(() => {
  delete process.env.LIVEPAY_WEBHOOK_SECRET;
  delete process.env.APP_URL;
  delete (globalThis as any).__fakeClient;
  vi.resetModules();
});

describe('PROBE 5 — the payment state machine is not monotonic or terminal', () => {
  it('a "Failed" notification rewrites an ALREADY-PAID order to Failed', async () => {
    const { sink } = makeClient({ order: PAID_ORDER, items: [DRUM_ITEM], products: CATALOG });
    const res = await call({
      status: 'Failed',
      customer_reference: 'ORDDP-AAAA-BBBB',
      internal_reference: 'int-late-failure', // a new notification => new event id => not deduped
      amount: CATALOG_TOTAL / 100,
      currency: 'UGX',
    });
    expect(res.status).toBe(200);

    const regression = sink.find((calls) =>
      calls.some((c) => c[0] === 'update' && c[1]?.payment_status === 'Failed')
    );
    // The order was Paid. It is now Failed. Revenue disappears; goods do not ship.
    expect(regression).toBeTruthy();
  });

  it('an unknown order ref keeps the idempotency marker, so the retry is swallowed', async () => {
    const { sink } = makeClient({ order: null, items: [], products: [] });
    const res = await call({
      status: 'Success',
      customer_reference: 'ORDDP-ZZZZ-ZZZZ', // order row not visible yet (or typo/missed insert)
      internal_reference: 'int-orphan',
      amount: 17_500,
      currency: 'UGX',
    });
    const body: any = await res.json();
    expect(body.matched).toBe(false);
    expect(res.status).toBe(200);
    // No marker release => LivePay's retry hits the duplicate path and is acked.
    expect(markerReleased(sink)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. The admin finance view maps Failed/Refunded to "Pending" and invents totals.
// ---------------------------------------------------------------------------
vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  getActiveSupabaseConfig: () => ({ url: 'https://x.supabase.co', anonKey: 'anon', source: 'env' }),
  supabase: {},
}));

describe('PROBE 6 — getOrdersFromDb corrupts the payment ledger it feeds the dashboard', () => {
  function fakeDb(rows: any[]) {
    const builder: any = {
      then: (resolve: any) => Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    for (const m of ['select', 'order', 'eq', 'in', 'range', 'limit']) builder[m] = () => builder;
    return { from: () => builder };
  }

  it('collapses Refunded and Failed into "Pending", and 0-total orders into 99', async () => {
    const { getOrdersFromDb } = await import('@/lib/supabaseDb');
    const supa = (await import('@/lib/supabase')) as any;
    supa.supabase = fakeDb([
      {
        id: 'aaaaaaaa-1111-4111-8111-111111111111',
        order_number: 'DP-AAAA-AAAA',
        customer_name: 'A',
        customer_email: 'a@x.ug',
        status: 'Processing',
        payment_status: 'Refunded',
        total_amount: 0,
        total_minor_units: 0,
        order_items: [],
        payments: [],
      },
      {
        id: 'bbbbbbbb-1111-4111-8111-111111111111',
        order_number: 'DP-BBBB-BBBB',
        customer_name: 'B',
        customer_email: 'b@x.ug',
        status: 'Pending',
        payment_status: 'Failed',
        total_amount: 17500,
        total_minor_units: 1_750_000,
        order_items: [],
        payments: [],
      },
    ]);

    const orders = await getOrdersFromDb();
    expect(orders).toHaveLength(2);
    expect(orders[0].paymentStatus).toBe('Pending'); // Refunded reported as Pending
    expect(orders[0].total).toBe(99); // a zero-value order becomes "99"
    expect(orders[1].paymentStatus).toBe('Pending'); // Failed reported as Pending
    // A fabricated line item is injected when the real item query returns none.
    expect(orders[0].items[0].productName).toBe('Drum Palace Order Item');
  });
});
