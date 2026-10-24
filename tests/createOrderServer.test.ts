import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpcMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
}));

vi.mock('@/lib/server/supabaseServer', () => ({
  getServerAdminClient: () => ({ rpc: rpcMock }),
}));

vi.mock('@/lib/server/logging', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { createOrderServer } from '@/lib/server/orders';

describe('createOrderServer payment method', () => {
  beforeEach(() => {
    rpcMock.mockReset().mockResolvedValue({ data: null, error: null });
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
      expect.objectContaining({ p_payment_method: paymentMethod }),
    );
  });
});
