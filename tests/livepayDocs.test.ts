/**
 * LivePay documentation alignment.
 *
 * Pins the wire contract of BOTH documented products to what this app sends:
 *
 *   Collect Money   https://docs.livepay.me/request-money
 *   Card Collection https://docs.livepay.me/card-collection
 *
 * Each assertion below maps to a documented field, limit or error code. If
 * LivePay changes its contract, one of these fails loudly rather than the shop
 * silently losing or mis-collecting money.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetRateLimits } from '@/lib/server/rateLimit';
import { priceOrder } from '@/lib/pricing';
import { signLivePayWebhook } from '@/lib/server/webhook';
import {
  buildCardReference,
  buildCardReturnUrl,
  buildCollectReference,
  getCardConfig,
  getCollectConfig,
  isTrustedCheckoutUrl,
  orderNumberFromReference,
  usdMinorFromUgxMinor,
  ugxMinorFromUsdMinor,
  CARD_MAX_MINOR,
  CARD_MIN_MINOR,
} from '@/lib/server/livepay';

// Product ids are UUIDs in the live database; the route rejects anything else.
const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('@/lib/server/supabaseServer', () => ({
  getServerAdminClient: () => (globalThis as any).__fakeClient,
  getServerAnonClient: () => (globalThis as any).__fakeClient,
  isServerSupabaseConfigured: true,
  authenticateAdmin: () => null,
  authenticateRequest: () => null,
}));

const APP_URL = 'https://shop.example.com';
const WEBHOOK_URL = `${APP_URL}/api/payments/livepay/webhook`;
const SECRET = 'whsec_docs';
const RATE = 3800;

// 100,000 UGX of goods (below the free-delivery threshold) + 10,000 UGX delivery.
const SNAPSHOT = priceOrder({
  lines: [{ productId: PRODUCT_ID, productName: 'Engoma Drum', quantity: 1, catalogUnitMinorUnits: 10_000_000 }],
});

const CARD_ORDER = {
  id: 'order-card',
  order_number: 'DP-CARD-0001',
  customer_id: 'user-1',
  customer_name: 'Amina',
  customer_email: 'amina@example.com',
  customer_phone: '256700000111',
  status: 'Pending',
  payment_status: 'pending',
  payment_method: 'card',
  currency: 'UGX',
  subtotal_minor_units: 10_000_000,
  discount_minor_units: 0,
  shipping_minor_units: 1_000_000,
  total_minor_units: 11_000_000,
  refunded_minor_units: 0,
  pricing_snapshot: SNAPSHOT,
};

const MOMO_ORDER = {
  ...CARD_ORDER,
  id: 'order-momo',
  order_number: 'DP-MOMO-0001',
  payment_method: 'momo',
  customer_email: 'amina@example.com',
};

interface FakeOpts {
  ordersSelect?: any;
  ordersUpdate?: any;
  paymentsSelect?: any;
  paymentsInsert?: any;
  paymentsUpdate?: any;
  eventsInsert?: any;
}

function fakeDb(opts: FakeOpts = {}) {
  const sink: any[][] = [];
  const tableResult = (table: string, op: string) => {
    if (table === 'orders') {
      return op === 'update' ? opts.ordersUpdate ?? { data: null, error: null } : opts.ordersSelect ?? { data: null, error: null };
    }
    if (table === 'payments') {
      if (op === 'insert') return opts.paymentsInsert ?? { data: null, error: null };
      if (op === 'update') return opts.paymentsUpdate ?? { data: null, error: null };
      return opts.paymentsSelect ?? { data: null, error: null };
    }
    if (table === 'payment_webhook_events') {
      return op === 'insert' ? opts.eventsInsert ?? { data: null, error: null } : { data: null, error: null };
    }
    return { data: null, error: null };
  };

  const client: any = {
    from: (table: string) => {
      const calls: any[] = [];
      let op = 'select';
      const obj: any = {
        then: (resolve: any, reject: any) => {
          sink.push(calls);
          return Promise.resolve(tableResult(table, op)).then(resolve, reject);
        },
      };
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'is', 'maybeSingle', 'order', 'range', 'limit', 'filter']) {
        obj[m] = (...args: any[]) => {
          if (m === 'insert' || m === 'update' || m === 'delete') op = m;
          calls.push([m, ...args]);
          return obj;
        };
      }
      return obj;
    },
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'not found' } }),
  };
  (globalThis as any).__fakeClient = client;
  return { sink };
}

const calls: { url: string; init: any; body: any }[] = [];
function stubFetch(responder: (url: string) => any) {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, body });
    const payload = await responder(String(url));
    return {
      ok: payload.status >= 200 && payload.status < 300,
      status: payload.status,
      json: async () => payload.body,
    } as any;
  }));
}

async function initPayment(body: any) {
  const { POST } = await import('@/app/api/payments/livepay/route');
  const res = await POST(
    new Request(`${APP_URL}/api/payments/livepay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as any
  );
  return { res, body: await res.json() };
}

beforeEach(() => {
  resetRateLimits();
  process.env.LIVEPAY_API_KEY = 'sk_collect';
  process.env.LIVEPAY_MERCHANT_ID = 'LP0000000001';
  process.env.LIVEPAY_CARD_API_KEY = 'keyid.secretvalue';
  process.env.LIVEPAY_USD_RATE_UGX = String(RATE);
  process.env.LIVEPAY_API_URL = 'https://livepay.me/api';
  process.env.APP_URL = APP_URL;
  process.env.LIVEPAY_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of [
    'LIVEPAY_API_KEY',
    'LIVEPAY_MERCHANT_ID',
    'LIVEPAY_CARD_API_KEY',
    'LIVEPAY_CARD_MERCHANT_ID',
    'LIVEPAY_USD_RATE_UGX',
    'LIVEPAY_API_URL',
    'APP_URL',
    'LIVEPAY_WEBHOOK_SECRET',
  ]) {
    delete process.env[k];
  }
});

// ---------------------------------------------------------------------------
// Pure contract helpers
// ---------------------------------------------------------------------------
describe('documented reference rules (unique, no spaces, max 30 chars)', () => {
  it('builds a stable collect reference from the order number', () => {
    expect(buildCollectReference('DP-8FK3-QM2Z')).toBe('ORDDP-8FK3-QM2Z');
  });

  it('never emits a space or an exotic character, even from a hostile order number', () => {
    const ref = buildCollectReference('DP 8FK3/QM2Z<script>');
    expect(ref).not.toMatch(/\s/);
    expect(ref).toMatch(/^[A-Z0-9-]+$/);
    expect(ref.length).toBeLessThanOrEqual(30);
  });

  it('caps references at 30 characters', () => {
    expect(buildCollectReference('DP-'.padEnd(60, 'A')).length).toBeLessThanOrEqual(30);
    expect(buildCardReference('DP-CARD-0001', 'NONCE12345ABCDE').length).toBeLessThanOrEqual(30);
  });

  it('recovers the order number from both reference shapes', () => {
    expect(orderNumberFromReference('ORDDP-8FK3-QM2Z')).toBe('DP-8FK3-QM2Z');
    expect(orderNumberFromReference('ORDDP-8FK3-QM2Z-AB12CD')).toBe('DP-8FK3-QM2Z');
    expect(orderNumberFromReference('garbage')).toBeNull();
  });
});

describe('card currency conversion (docs: USD only, $1.00–$5,000.00)', () => {
  it('converts UGX to USD cents, rounding UP so the shop never undercharges', () => {
    // 110,000 UGX / 3800 = 28.9473… USD → 2895 cents ($28.95)
    expect(usdMinorFromUgxMinor(11_000_000, RATE)).toBe(2895);
    expect(ugxMinorFromUsdMinor(2895, RATE)).toBeGreaterThanOrEqual(11_000_000);
  });

  it('enforces the documented $1 floor and $5,000 ceiling', () => {
    expect(usdMinorFromUgxMinor(1_000, RATE)).toBeNull(); // 1,000 UGX ≈ $0.26
    // $5,000 = 500,000 cents = 5,000 × 3,800 UGX = 19,000,000 UGX = 1,900,000,000 minor units
    expect(usdMinorFromUgxMinor(5_000 * RATE * 100, RATE)).toBe(CARD_MAX_MINOR);
    expect(usdMinorFromUgxMinor(5_001 * RATE * 100, RATE)).toBeNull();
    expect(usdMinorFromUgxMinor(100 * RATE * 100, RATE)).toBe(10_000); // $100
  });

  it('refuses to guess an amount when the rate is missing or silly', () => {
    expect(usdMinorFromUgxMinor(1_000_000, NaN)).toBeNull();
    expect(usdMinorFromUgxMinor(1_000_000, 0)).toBeNull();
    expect(usdMinorFromUgxMinor(1_000_000, -3800)).toBeNull();
    expect(usdMinorFromUgxMinor(-5, RATE)).toBeNull();
  });
});

describe('checkout_url allow-list', () => {
  it('accepts LivePay hosts only', () => {
    expect(isTrustedCheckoutUrl('https://partners.livepay.me/checkout?ref=REF-1')).toBe(true);
    expect(isTrustedCheckoutUrl('https://livepay.me/checkout?ref=REF-1')).toBe(true);
  });

  it('rejects look-alikes and non-https schemes', () => {
    expect(isTrustedCheckoutUrl('https://livepay.me.evil.com/checkout')).toBe(false);
    expect(isTrustedCheckoutUrl('https://evil-livepay.me/x')).toBe(false);
    expect(isTrustedCheckoutUrl('http://livepay.me/x')).toBe(false);
    expect(isTrustedCheckoutUrl('javascript:alert(1)')).toBe(false);
    expect(isTrustedCheckoutUrl(undefined)).toBe(false);
  });
});

describe('gateway configuration', () => {
  it('uses the documented bearer formats', () => {
    expect(getCollectConfig()?.apiKey).toBe('sk_collect');
    expect(getCardConfig()?.apiKey).toBe('keyid.secretvalue');
  });

  it('refuses a non-LivePay base URL (SSRF guard)', () => {
    process.env.LIVEPAY_API_URL = 'https://evil.example.com/api';
    expect(getCollectConfig()).toBeNull();
    expect(getCardConfig()).toBeNull();
  });

  it('builds a return URL that carries the order number for the tracking view', () => {
    const url = new URL(buildCardReturnUrl(APP_URL, 'DP-CARD-0001')!);
    expect(url.origin).toBe(APP_URL);
    expect(url.searchParams.get('order')).toBe('DP-CARD-0001');
  });
});

// ---------------------------------------------------------------------------
// Collect Money — POST /collect-money
// ---------------------------------------------------------------------------
describe('collect money request matches the documented contract', () => {
  it('sends the documented fields with the DGX account and bearer key', async () => {
    fakeDb({ ordersSelect: { data: MOMO_ORDER, error: null } });
    stubFetch(() => ({
      status: 200,
      body: { success: true, message: 'Collection request sent successfully', reference: 'ORDDP-MOMO-0001', internal_reference: '550e8400-e29b-41d4-a716-446655440000', network: 'MTN' },
    }));

    const { res, body } = await initPayment({ orderId: 'order-momo', phoneNumber: '256700000111', paymentMethod: 'momo' });
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://livepay.me/api/collect-money');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer sk_collect');
    const sent = calls[0].body;
    expect(sent).toMatchObject({
      accountNumber: 'LP0000000001',
      phoneNumber: '256700000111',
      amount: 110_000, // UGX major units, whole shillings
      currency: 'UGX',
      reference: 'ORDDP-MOMO-0001',
      description: 'Order #DP-MOMO-0001',
    });
    // `network` is documented as conditional — required only for non-UGX.
    expect(sent.network).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Card Collection — POST /card-collection
// ---------------------------------------------------------------------------
describe('card collection request matches the documented contract', () => {
  it('creates a USD checkout for a UGX order and returns the hosted URL', async () => {
    const { sink } = fakeDb({ ordersSelect: { data: CARD_ORDER, error: null } });
    stubFetch(() => ({
      status: 200,
      body: {
        success: true,
        message: 'Card transaction created successfully',
        checkout_url: 'https://partners.livepay.me/checkout?ref=REF-MVE60LII-DVFWSB',
        reference: 'REF-MVE60LII-DVFWSB',
        internal_reference: 'c33fafc4-e0b6-4235-bf1b-319cc6271b64',
      },
    }));

    const { res, body } = await initPayment({ orderId: 'order-card', paymentMethod: 'card' });
    expect(res.status).toBe(200);
    expect(body.checkoutUrl).toBe('https://partners.livepay.me/checkout?ref=REF-MVE60LII-DVFWSB');
    expect(body.currency).toBe('USD');
    expect(body.amountUsd).toBe(28.95);

    expect(calls[0].url).toBe('https://livepay.me/api/card-collection');
    expect(calls[0].init.headers.Authorization).toBe('Bearer keyid.secretvalue');
    const sent = calls[0].body;
    expect(sent.currency).toBe('USD');
    expect(sent.amount).toBe(28.95);
    expect(sent.email).toBe('amina@example.com');
    expect(sent.accountNumber).toBe('LP0000000001');
    expect(sent.reference).toMatch(/^ORDDP-CARD-0001-[A-Z0-9]+$/);
    expect(sent.reference.length).toBeLessThanOrEqual(30);
    expect(sent.reference).not.toMatch(/\s/);
    expect(String(sent.return_url)).toMatch(/^https:\/\/shop\.example\.com\//);
    expect(new URL(sent.return_url).searchParams.get('order')).toBe('DP-CARD-0001');

    // The frozen FX rate is persisted so the webhook can verify the charge.
    const insert = sink.map((c) => c.find((x) => x[0] === 'insert')).find(Boolean);
    const row = insert?.[1];
    expect(row.currency).toBe('USD');
    expect(row.amount_minor_units).toBe(2895);
    expect(row.raw_payload.fx).toMatchObject({ ugx_per_usd: RATE, ugx_minor: 11_000_000, usd_minor: 2895 });
  });

  it('does not require a phone number for card (the docs do not send one)', async () => {
    fakeDb({ ordersSelect: { data: { ...CARD_ORDER, customer_phone: null }, error: null } });
    stubFetch(() => ({ status: 200, body: { success: true, checkout_url: 'https://partners.livepay.me/checkout?ref=x' } }));
    const { res } = await initPayment({ orderId: 'order-card', paymentMethod: 'card' });
    expect(res.status).toBe(200);
    expect(calls[0].body.phoneNumber).toBeUndefined();
  });

  it('ignores any client-supplied amount and always charges the order total', async () => {
    fakeDb({ ordersSelect: { data: CARD_ORDER, error: null } });
    stubFetch(() => ({ status: 200, body: { success: true, checkout_url: 'https://partners.livepay.me/checkout?ref=x' } }));
    await initPayment({ orderId: 'order-card', paymentMethod: 'card', amount: 1, total: 1, amountUsd: 0.01 });
    expect(calls[0].body.amount).toBe(28.95);
  });

  it('refuses an untrusted checkout_url instead of redirecting the customer there', async () => {
    fakeDb({ ordersSelect: { data: CARD_ORDER, error: null } });
    stubFetch(() => ({ status: 200, body: { success: true, checkout_url: 'https://livepay.me.evil.com/checkout' } }));
    const { res, body } = await initPayment({ orderId: 'order-card', paymentMethod: 'card' });
    expect(res.status).toBe(502);
    expect(body.checkoutUrl).toBeUndefined();
  });

  it('is disabled (503) when no FX rate is configured rather than guessing one', async () => {
    delete process.env.LIVEPAY_USD_RATE_UGX;
    fakeDb({ ordersSelect: { data: CARD_ORDER, error: null } });
    stubFetch(() => ({ status: 200, body: { success: true, checkout_url: 'https://partners.livepay.me/checkout?ref=x' } }));
    const { res } = await initPayment({ orderId: 'order-card', paymentMethod: 'card' });
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('is disabled (503) when the card credential is not configured', async () => {
    delete process.env.LIVEPAY_CARD_API_KEY;
    delete process.env.LIVEPAY_API_KEY;
    fakeDb({ ordersSelect: { data: CARD_ORDER, error: null } });
    stubFetch(() => ({ status: 200, body: { success: true, checkout_url: 'https://partners.livepay.me/checkout?ref=x' } }));
    const { res } = await initPayment({ orderId: 'order-card', paymentMethod: 'card' });
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('refuses an order below the documented $1 card minimum', async () => {
    fakeDb({
      ordersSelect: {
        data: {
          ...CARD_ORDER,
          subtotal_minor_units: 0,
          shipping_minor_units: 0,
          total_minor_units: 1_000, // 10 UGX ≈ $0.0026
          pricing_snapshot: null,
        },
        error: null,
      },
    });
    stubFetch(() => ({ status: 200, body: { success: true, checkout_url: 'https://partners.livepay.me/checkout?ref=x' } }));
    const { res } = await initPayment({ orderId: 'order-card', paymentMethod: 'card' });
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('refuses a card order that is actually a MoMo order (method confusion)', async () => {
    fakeDb({ ordersSelect: { data: MOMO_ORDER, error: null } });
    stubFetch(() => ({ status: 200, body: { success: true, checkout_url: 'https://partners.livepay.me/checkout?ref=x' } }));
    const { res } = await initPayment({ orderId: 'order-momo', paymentMethod: 'card' });
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it('refuses a card order paid as MoMo (no prompt for a card order)', async () => {
    fakeDb({ ordersSelect: { data: CARD_ORDER, error: null } });
    stubFetch(() => ({ status: 200, body: { success: true } }));
    const { res } = await initPayment({ orderId: 'order-card', paymentMethod: 'momo', phoneNumber: '256700000111' });
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it('rejects an unknown payment method instead of treating it as MoMo', async () => {
    fakeDb({ ordersSelect: { data: MOMO_ORDER, error: null } });
    stubFetch(() => ({ status: 200, body: { success: true } }));
    const { res } = await initPayment({ orderId: 'order-momo', paymentMethod: 'bitcoin' });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('gateway reference handling (the docs echo a reference we did not send)', () => {
  it('stores the gateway-assigned reference so a webhook carrying it still resolves', async () => {
    const { sink } = fakeDb({
      ordersSelect: { data: CARD_ORDER, error: null },
      paymentsSelect: { data: [], error: null },
    });
    stubFetch(() => ({
      status: 200,
      body: {
        success: true,
        checkout_url: 'https://partners.livepay.me/checkout?ref=REF-MVE60LII-DVFWSB',
        // The docs' success example returns its own reference, not ours.
        reference: 'REF-MVE60LII-DVFWSB',
        internal_reference: 'c33fafc4-e0b6-4235-bf1b-319cc6271b64',
      },
    }));

    const { res } = await initPayment({ orderId: 'order-card', paymentMethod: 'card' });
    expect(res.status).toBe(200);

    const update = sink.map((c) => c.find((x) => x[0] === 'update')).find(Boolean);
    expect(update?.[1].provider_transaction_id).toBe('c33fafc4-e0b6-4235-bf1b-319cc6271b64');
    expect(update?.[1].raw_payload.gateway_reference).toBe('REF-MVE60LII-DVFWSB');
    // The FX freeze must survive the merge.
    expect(update?.[1].raw_payload.fx).toMatchObject({ ugx_per_usd: RATE, usd_minor: 2895 });
  });

  it('resolves a webhook that carries only the gateway-assigned reference', async () => {
    const { sink } = fakeDb({
      ordersSelect: { data: CARD_ORDER, error: null },
      paymentsSelect: { data: [], error: null }, // no row matches provider_reference
    });
    const { POST } = await import('@/app/api/payments/livepay/webhook/route');
    const payload = {
      status: 'Success',
      customer_reference: 'REF-MVE60LII-DVFWSB',
      internal_reference: 'int-ref',
      amount: 28.95,
      currency: 'USD',
    };
    const t = String(Math.floor(Date.now() / 1000));
    const v = signLivePayWebhook({ webhookUrl: WEBHOOK_URL, timestamp: t, payload, secret: SECRET });
    const res = await POST(
      new Request(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'x-webhook-signature': `t=${t},v=${v}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }) as any
    );
    await res.json();

    // It tried every identifier the gateway might echo, including the JSON one.
    const lookups = sink.flatMap((c) => c).filter((x) => x[0] === 'eq' || x[0] === 'filter');
    const columns = lookups.map((x) => x[1]);
    expect(columns).toContain('provider_reference');
    expect(columns).toContain('provider_transaction_id');
    expect(columns).toContain('raw_payload->>gateway_reference');
  });

  it('does not fail on repeated Mobile Money attempts that reuse one reference', async () => {
    // Two pending rows share provider_reference; the lookup must take the newest
    // instead of erroring on maybeSingle().
    fakeDb({
      ordersSelect: { data: MOMO_ORDER, error: null },
      paymentsSelect: { data: [{ id: 'pay-2' }, { id: 'pay-1' }], error: null },
    });
    const payload = {
      status: 'Success',
      customer_reference: 'ORDDP-MOMO-0001',
      internal_reference: 'int-momo',
      amount: 110_000,
      currency: 'UGX',
    };
    const t = String(Math.floor(Date.now() / 1000));
    const v = signLivePayWebhook({ webhookUrl: WEBHOOK_URL, timestamp: t, payload, secret: SECRET });
    const { POST } = await import('@/app/api/payments/livepay/webhook/route');
    const res = await POST(
      new Request(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'x-webhook-signature': `t=${t},v=${v}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }) as any
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Card settlement through the documented webhook
// ---------------------------------------------------------------------------
function signedWebhook(payload: any) {
  const t = String(Math.floor(Date.now() / 1000));
  const v = signLivePayWebhook({ webhookUrl: WEBHOOK_URL, timestamp: t, payload, secret: SECRET });
  return { 'x-webhook-signature': `t=${t},v=${v}`, 'Content-Type': 'application/json' };
}

async function postWebhook(payload: any) {
  const { POST } = await import('@/app/api/payments/livepay/webhook/route');
  const res = await POST(
    new Request(WEBHOOK_URL, { method: 'POST', headers: signedWebhook(payload), body: JSON.stringify(payload) }) as any
  );
  return { res, body: await res.json() };
}

const CARD_PAYMENT_ROW = {
  id: 'pay-1',
  order_id: 'order-card',
  provider_reference: 'ORDDP-CARD-0001-AB12CD',
  amount_minor_units: 2895,
  currency: 'USD',
  raw_payload: { method: 'card', fx: { ugx_per_usd: RATE, ugx_minor: 11_000_000, usd_minor: 2895 } },
};

describe('card settlement reconciliation', () => {
  it('marks the order Paid when the USD amount matches the frozen rate', async () => {
    const { sink } = fakeDb({
      ordersSelect: { data: CARD_ORDER, error: null },
      paymentsSelect: { data: CARD_PAYMENT_ROW, error: null },
    });
    const { res, body } = await postWebhook({
      status: 'Success',
      customer_reference: 'ORDDP-CARD-0001-AB12CD',
      internal_reference: 'c33fafc4-e0b6-4235-bf1b-319cc6271b64',
      amount: 28.95,
      currency: 'USD',
      provider: 'bachs',
      charge: 0.5,
    });
    expect(res.status).toBe(200);
    expect(body.received).toBe(true);

    const orderUpdate = sink.find((c) => c.some((x) => x[0] === 'update' && x[1]?.payment_status === 'paid'));
    expect(orderUpdate).toBeTruthy();
  });

  it('refuses a card settlement that is one cent short', async () => {
    const { sink } = fakeDb({
      ordersSelect: { data: CARD_ORDER, error: null },
      paymentsSelect: { data: CARD_PAYMENT_ROW, error: null },
    });
    const { res, body } = await postWebhook({
      status: 'Success',
      customer_reference: 'ORDDP-CARD-0001-AB12CD',
      internal_reference: 'int-1',
      amount: 28.94,
      currency: 'USD',
    });
    expect(res.status).toBe(200);
    expect(body.verified).toBe(false);
    expect(body.reason).toBe('amount mismatch');
    expect(sink.some((c) => c.some((x) => x[0] === 'update' && x[1]?.payment_status === 'paid'))).toBe(false);
  });

  it('refuses a card settlement denominated in UGX when the charge was USD', async () => {
    fakeDb({
      ordersSelect: { data: CARD_ORDER, error: null },
      paymentsSelect: { data: CARD_PAYMENT_ROW, error: null },
    });
    const { body } = await postWebhook({
      status: 'Success',
      customer_reference: 'ORDDP-CARD-0001-AB12CD',
      internal_reference: 'int-2',
      amount: 110_000,
      currency: 'UGX',
    });
    expect(body.verified).toBe(false);
  });

  it('rejects a payments row whose USD amount does not follow from the order and rate', async () => {
    fakeDb({
      ordersSelect: { data: CARD_ORDER, error: null },
      // Attacker lowered the recorded charge to $5.
      paymentsSelect: { data: { ...CARD_PAYMENT_ROW, amount_minor_units: 500 }, error: null },
    });
    const { body } = await postWebhook({
      status: 'Success',
      customer_reference: 'ORDDP-CARD-0001-AB12CD',
      internal_reference: 'int-3',
      amount: 5,
      currency: 'USD',
    });
    expect(body.verified).toBe(false);
    expect(body.reason).toBe('card fx inconsistent');
  });

  it('rejects a card settlement with a tampered FX rate on the row', async () => {
    fakeDb({
      ordersSelect: { data: CARD_ORDER, error: null },
      paymentsSelect: {
        data: { ...CARD_PAYMENT_ROW, raw_payload: { fx: { ugx_per_usd: 1, ugx_minor: 11_000_000, usd_minor: 2895 } } },
        error: null,
      },
    });
    const { body } = await postWebhook({
      status: 'Success',
      customer_reference: 'ORDDP-CARD-0001-AB12CD',
      internal_reference: 'int-4',
      amount: 28.95,
      currency: 'USD',
    });
    expect(body.verified).toBe(false);
  });
});
