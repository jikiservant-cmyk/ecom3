/**
 * Handler-level tests for the LivePay webhook.
 *
 * These drive the real route handler with a fake Supabase client, so they
 * exercise the control flow rather than re-implementing it. The behaviour under
 * test is the idempotency marker: a notification we REFUSE must not stay marked
 * as processed, or the gateway's corrected retry is swallowed as a duplicate and
 * a customer who paid never has their order marked Paid.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signLivePayWebhook } from '@/lib/server/webhook';

vi.mock('@/lib/server/supabaseServer', () => ({
  getServerAdminClient: () => (globalThis as any).__fakeClient,
}));

const SECRET = 'whsec_handler_test';
const APP_URL = 'https://shop.example.com';
const WEBHOOK_URL = `${APP_URL}/api/payments/livepay/webhook`;

/**
 * A chainable PostgREST-ish builder that records every call it receives.
 * It is a thenable rather than a function because the route awaits terminal
 * builders (`await chain.maybeSingle()`), which a plain function would not
 * resolve.
 */
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

function makeClient(fix: {
  order?: any;
  items?: any[];
  products?: any[];
  updateError?: any;
}) {
  const sink: any[][] = [];
  const client = {
    from: (table: string) => {
      if (table === 'payment_webhook_events') return chainable({ error: null }, sink);
      if (table === 'orders') return chainable({ data: fix.order ?? null, error: fix.updateError ?? null }, sink);
      if (table === 'order_items') return chainable({ data: fix.items ?? [] }, sink);
      if (table === 'products') return chainable({ data: fix.products ?? [] }, sink);
      return chainable({ data: null, error: null }, sink);
    },
  };
  (globalThis as any).__fakeClient = client;
  return { sink };
}

/** True when some recorded chain deleted the idempotency marker. */
function markerReleased(sink: any[][]): boolean {
  return sink.some((calls) => calls.some((c) => c[0] === 'delete'));
}

// Drum 475,000 minor + flat delivery 2,500,000 minor = 2,975,000 minor
// = 29,750 UGX major. The fixtures must agree or the catalog check rejects them.
const CATALOG_TOTAL_MINOR = 475_000 + 2_500_000;
const CATALOG_TOTAL_MAJOR = CATALOG_TOTAL_MINOR / 100;

const PAID_ORDER = {
  id: 'order-1',
  order_number: 'DP-AAAA-BBBB',
  payment_status: 'Pending',
  total_amount: CATALOG_TOTAL_MAJOR,
  total_minor_units: CATALOG_TOTAL_MINOR,
  currency: 'UGX',
};

const DRUM_ITEM = { product_name: 'Engoma Drum', quantity: 1 };
// 5,000 UGX = 500,000 minor; catalog total adds the flat delivery fee.
const CATALOG = [{
  id: 'p1', name: 'Engoma Drum', status: 'active',
  product_variants: [{ price_minor_units: 475_000, position: 0, status: 'active' }],
}];

function signedRequest(payload: any) {
  const t = String(Math.floor(Date.now() / 1000));
  const v = signLivePayWebhook({ webhookUrl: WEBHOOK_URL, timestamp: t, payload, secret: SECRET });
  const body = JSON.stringify(payload);
  return new Request(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-signature': `t=${t},v=${v}`,
      host: 'shop.example.com',
    },
    body,
  });
}

async function call(payload: any) {
  const { POST } = await import('@/app/api/payments/livepay/webhook/route');
  return POST(signedRequest(payload) as any);
}

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

describe('webhook signature gate', () => {
  it('rejects a payload with no signature header', async () => {
    makeClient({ order: PAID_ORDER });
    const { POST } = await import('@/app/api/payments/livepay/webhook/route');
    const res = await POST(new Request(WEBHOOK_URL, { method: 'POST', body: '{}' }) as any);
    expect(res.status).toBe(401);
  });
});

describe('refused notifications must release the idempotency marker', () => {
  it('releases the marker on an amount mismatch so a corrected retry can land', async () => {
    const { sink } = makeClient({ order: PAID_ORDER, items: [DRUM_ITEM], products: CATALOG });
    // Order total is 2,975,000 minor; claim 1 UGX.
    const res = await call({
      status: 'Success',
      customer_reference: 'ORDDP-AAAA-BBBB',
      internal_reference: 'int-1',
      amount: 1,
      currency: 'UGX',
    });
    const body: any = await res.json();
    expect(body.verified).toBe(false);
    expect(body.reason).toBe('amount mismatch');
    expect(markerReleased(sink)).toBe(true);
  });

  it('releases the marker when the paid amount is below catalog value', async () => {
    const { sink } = makeClient({
      // Order row claims a total that matches the (small) payment...
      order: { ...PAID_ORDER, total_amount: 50, total_minor_units: 5_000 },
      items: [DRUM_ITEM],
      // ...but the catalog says the drum costs far more.
      products: CATALOG,
    });
    const res = await call({
      status: 'Success',
      customer_reference: 'ORDDP-AAAA-BBBB',
      internal_reference: 'int-2',
      amount: 50,
      currency: 'UGX',
    });
    const body: any = await res.json();
    expect(body.verified).toBe(false);
    expect(body.reason).toBe('amount below catalog value');
    expect(markerReleased(sink)).toBe(true);
  });
});

describe('accepted notifications', () => {
  it('marks the order Paid and KEEPS the marker (so retries are deduped)', async () => {
    const { sink } = makeClient({ order: PAID_ORDER, items: [DRUM_ITEM], products: CATALOG });
    const res = await call({
      status: 'Success',
      customer_reference: 'ORDDP-AAAA-BBBB',
      internal_reference: 'int-3',
      amount: CATALOG_TOTAL_MAJOR, // matches total_amount exactly
      currency: 'UGX',
    });
    const body: any = await res.json();
    expect(body.received).toBe(true);
    expect(body.verified).toBeUndefined();
    expect(markerReleased(sink)).toBe(false);

    // And the order row was actually updated.
    const orderUpdate = sink.find((calls) => calls.some((c) => c[0] === 'update' && c[1]?.payment_status === 'Paid'));
    expect(orderUpdate).toBeTruthy();
  });

  it('does not mark a failed payment as Paid', async () => {
    const { sink } = makeClient({ order: PAID_ORDER, items: [DRUM_ITEM], products: CATALOG });
    const res = await call({
      status: 'Failed',
      customer_reference: 'ORDDP-AAAA-BBBB',
      internal_reference: 'int-4',
      amount: CATALOG_TOTAL_MAJOR,
      currency: 'UGX',
    });
    expect(res.status).toBe(200);
    const paid = sink.find((calls) => calls.some((c) => c[0] === 'update' && c[1]?.payment_status === 'Paid'));
    expect(paid).toBeUndefined();
  });
});
