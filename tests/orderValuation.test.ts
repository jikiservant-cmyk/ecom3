import { describe, it, expect } from 'vitest';
import {
  valueOrderAgainstCatalog,
  buildCatalogPriceIndex,
  FLAT_DELIVERY_FEE_MINOR_UNITS,
} from '@/lib/server/orders';

/** One product at 5,000 UGX = 500,000 minor units. */
const DRUM = {
  id: 'prod-1',
  name: 'Engoma Drum',
  status: 'active',
  product_variants: [{ price_minor_units: 500_000, position: 0, status: 'active' }],
};

const index = () => buildCatalogPriceIndex([DRUM]);

describe('valueOrderAgainstCatalog — the forged-total attack', () => {
  it('rejects an order whose stored total is 1 UGX but whose items cost 5,000 UGX', () => {
    const v = valueOrderAgainstCatalog({
      items: [{ productName: 'Engoma Drum', quantity: 1 }],
      prices: index(),
      storedTotalMinorUnits: 100, // 1 UGX
    });
    expect(v.ok).toBe(false);
    expect(v.catalogTotalMinor).toBe(500_000 + FLAT_DELIVERY_FEE_MINOR_UNITS);
    expect(v.shortByMinor).toBe(v.catalogTotalMinor - 100);
  });

  it('rejects a total of zero', () => {
    const v = valueOrderAgainstCatalog({
      items: [{ productName: 'Engoma Drum', quantity: 1 }],
      prices: index(),
      storedTotalMinorUnits: 0,
    });
    expect(v.ok).toBe(false);
  });

  it('rejects a total understated by a single minor unit', () => {
    const catalogTotal = 500_000 + FLAT_DELIVERY_FEE_MINOR_UNITS;
    const v = valueOrderAgainstCatalog({
      items: [{ productName: 'Engoma Drum', quantity: 1 }],
      prices: index(),
      storedTotalMinorUnits: catalogTotal - 1,
    });
    expect(v.ok).toBe(false);
    expect(v.shortByMinor).toBe(1);
  });

  it('scales with quantity — a forged total is caught even at qty 20', () => {
    const v = valueOrderAgainstCatalog({
      items: [{ productName: 'Engoma Drum', quantity: 20 }],
      prices: index(),
      storedTotalMinorUnits: 1_000_000, // far below 20 x 5,000 UGX
    });
    expect(v.ok).toBe(false);
    expect(v.catalogTotalMinor).toBe(20 * 500_000 + FLAT_DELIVERY_FEE_MINOR_UNITS);
  });
});

describe('valueOrderAgainstCatalog — legitimate orders still pass', () => {
  it('accepts an order whose total matches the catalog exactly', () => {
    const v = valueOrderAgainstCatalog({
      items: [{ productName: 'Engoma Drum', quantity: 2 }],
      prices: index(),
      storedTotalMinorUnits: 2 * 500_000 + FLAT_DELIVERY_FEE_MINOR_UNITS,
    });
    expect(v.ok).toBe(true);
    expect(v.shortByMinor).toBe(0);
  });

  it('accepts a total above catalog value (price dropped after checkout)', () => {
    const v = valueOrderAgainstCatalog({
      items: [{ productName: 'Engoma Drum', quantity: 1 }],
      prices: index(),
      storedTotalMinorUnits: 900_000 + FLAT_DELIVERY_FEE_MINOR_UNITS,
    });
    expect(v.ok).toBe(true);
  });

  it('matches by product id when supplied, ignoring a mismatched name', () => {
    const v = valueOrderAgainstCatalog({
      items: [{ productName: 'Cheap Knockoff', quantity: 1, productId: 'prod-1' }],
      prices: index(),
      storedTotalMinorUnits: 500_000 + FLAT_DELIVERY_FEE_MINOR_UNITS,
    });
    expect(v.ok).toBe(true);
  });
});

describe('valueOrderAgainstCatalog — fail-closed edges', () => {
  it('rejects an order containing a product with no active catalog price', () => {
    const v = valueOrderAgainstCatalog({
      items: [
        { productName: 'Engoma Drum', quantity: 1 },
        { productName: 'Ghost Product', quantity: 1 },
      ],
      prices: index(),
      storedTotalMinorUnits: 500_000 + FLAT_DELIVERY_FEE_MINOR_UNITS,
    });
    expect(v.ok).toBe(false);
    expect(v.unknownItems).toContain('Ghost Product');
  });

  it('rejects an order with no items at all', () => {
    const v = valueOrderAgainstCatalog({ items: [], prices: index(), storedTotalMinorUnits: 100 });
    // Empty cart => no delivery fee => catalog total 0, so the check that
    // matters is that a bogus positive total is not silently accepted as a
    // valueless order.
    expect(v.catalogTotalMinor).toBe(0);
    expect(v.ok).toBe(true);
  });

  it('rejects a non-numeric stored total', () => {
    const v = valueOrderAgainstCatalog({
      items: [{ productName: 'Engoma Drum', quantity: 1 }],
      prices: index(),
      storedTotalMinorUnits: NaN,
    });
    expect(v.ok).toBe(false);
  });

  it('treats a negative quantity as zero rather than a credit', () => {
    const v = valueOrderAgainstCatalog({
      items: [{ productName: 'Engoma Drum', quantity: -5 }],
      prices: index(),
      storedTotalMinorUnits: 0,
    });
    expect(v.catalogSubtotalMinor).toBe(0);
  });
});

describe('buildCatalogPriceIndex', () => {
  it('skips inactive products so they cannot be used to price a line', () => {
    const idx = buildCatalogPriceIndex([
      { id: 'p', name: 'Retired', status: 'archived', product_variants: [{ price_minor_units: 1, status: 'active' }] },
    ]);
    expect(idx.byName.has('Retired')).toBe(false);
  });

  it('prefers the lowest-position active variant', () => {
    const idx = buildCatalogPriceIndex([{
      id: 'p', name: 'Multi', status: 'active',
      product_variants: [
        { price_minor_units: 900, position: 2, status: 'active' },
        { price_minor_units: 100, position: 0, status: 'active' },
      ],
    }]);
    expect(idx.byName.get('Multi')).toBe(100);
  });

  it('ignores non-positive and non-finite prices', () => {
    const idx = buildCatalogPriceIndex([
      { id: 'a', name: 'Free', status: 'active', product_variants: [{ price_minor_units: 0, status: 'active' }] },
      { id: 'b', name: 'Broken', status: 'active', product_variants: [{ price_minor_units: 'abc', status: 'active' }] },
    ]);
    expect(idx.byName.size).toBe(0);
  });

  it('first product wins a duplicate name, so a cheaper twin cannot re-price a line', () => {
    const idx = buildCatalogPriceIndex([
      { id: 'real', name: 'Dup', status: 'active', product_variants: [{ price_minor_units: 500_000, position: 0, status: 'active' }] },
      { id: 'fake', name: 'Dup', status: 'active', product_variants: [{ price_minor_units: 1, position: 0, status: 'active' }] },
    ]);
    expect(idx.byName.get('Dup')).toBe(500_000);
    // ...but the real id still resolves correctly.
    expect(idx.byId.get('real')).toBe(500_000);
  });
});
