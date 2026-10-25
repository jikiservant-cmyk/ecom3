import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpcMock, fromMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock('@/lib/server/supabaseServer', () => ({
  getServerAdminClient: () => ({ rpc: rpcMock, from: fromMock }),
}));

vi.mock('@/lib/server/logging', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { createOrderServer } from '@/lib/server/orders';

describe('createOrderServer payment method', () => {
  beforeEach(() => {
    rpcMock.mockReset().mockResolvedValue({ data: null, error: null });
    fromMock.mockReset();
  });

  it.each(['momo', 'cod'] as const)('passes %s to the atomic order RPC', async (paymentMethod) => {
    const result = await createOrderServer({
      customerName: 'Test Customer',
      customerEmail: 'customer@example.com',
      paymentMethod,
      items: [{ productName: 'Test Instrument', quantity: 1, price: 100 }],
      total: 100,
      subtotalMinorUnits: 10_000,
      shippingMinorUnits: 0,
    });

    expect(result.success).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith(
      'create_order_v2',
      expect.objectContaining({
        p_order_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
        p_payment_method: paymentMethod,
      }),
    );
  });

  it('returns a safe diagnostic code when the service-role RPC is denied', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'permission denied for function create_order_v2' },
    });

    const result = await createOrderServer({
      customerName: 'Test Customer',
      customerEmail: 'customer@example.com',
      paymentMethod: 'cod',
      items: [{ productName: 'Test Instrument', quantity: 1, price: 100 }],
      total: 100,
    });

    expect(result).toEqual({
      success: false,
      error: 'Order could not be created. Please try again.',
      diagnosticCode: 'RPC_42501',
    });
  });

  it('uses lowercase enum values for fallback order status', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST202', message: 'function not found in schema cache' },
    });

    const variantQuery = {
      select: vi.fn(),
      eq: vi.fn(),
      in: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    variantQuery.select.mockReturnValue(variantQuery);
    variantQuery.eq.mockReturnValue(variantQuery);
    const insertOrderMock = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockImplementation((table: string) => {
      if (table === 'product_variants') return variantQuery;
      if (table === 'orders') return { insert: insertOrderMock };
      throw new Error(`Unexpected table ${table}`);
    });

    const result = await createOrderServer({
      customerName: 'Test Customer',
      customerEmail: 'customer@example.com',
      paymentMethod: 'cod',
      items: [],
      total: 0,
      subtotalMinorUnits: 0,
      shippingMinorUnits: 0,
    });

    expect(result.success).toBe(true);
    expect(insertOrderMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pending',
      payment_status: 'Pending',
    }));
  });
});
