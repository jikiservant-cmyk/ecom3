/**
 * Canonical money math. Imported by BOTH the browser and the server so the
 * price a customer is shown is computed by exactly the same code that charges
 * them. Nothing in here may import Node-only modules.
 *
 * Units: every monetary value is an INTEGER count of minor units (1 UGX = 100
 * minor units). Floats are never compared for equality and whole-shilling
 * rounding happens in exactly one place.
 */

export const MINOR_UNITS_PER_MAJOR = 100;

/** Flat delivery fee: 25,000 UGX. Single definition for client + server. */
export const DELIVERY_FEE_MINOR_UNITS = 2_500_000;

/** Free delivery above this net subtotal (500,000 UGX) unless settings say otherwise. */
export const DEFAULT_FREE_SHIPPING_THRESHOLD_MINOR_UNITS = 50_000_000;

/** True when a value is a valid, non-negative, whole-shilling minor amount. */
export function isWholeShillingMinor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value % MINOR_UNITS_PER_MAJOR === 0;
}

/** Round UP to the next whole shilling. UGX has no circulating subunit. */
export function toWholeShillingMinor(minorUnits: number): number {
  if (!Number.isFinite(minorUnits)) return 0;
  return Math.ceil(Math.max(0, minorUnits) / MINOR_UNITS_PER_MAJOR) * MINOR_UNITS_PER_MAJOR;
}

export function toMinorUnits(majorUnits: number): number {
  if (!Number.isFinite(majorUnits)) return NaN;
  return Math.round(majorUnits * MINOR_UNITS_PER_MAJOR);
}

export function toMajorUnits(minorUnits: number): number {
  return minorUnits / MINOR_UNITS_PER_MAJOR;
}

/** A promotion as stored in `store_settings.settings.hotDeals`. */
export interface PromoDeal {
  id?: string;
  productId?: string;
  customTitle?: string;
  discountPercent?: number;
  customPrice?: number; // major units (UGX)
  active?: boolean;
}

export interface CatalogLine {
  productId?: string | null;
  productName: string;
  quantity: number;
  /** Server-authoritative catalog price for one unit, in minor units. */
  catalogUnitMinorUnits: number;
}

export interface PricedLine extends CatalogLine {
  /** What the customer actually pays for one unit after promotions. */
  unitMinorUnits: number;
  lineCatalogMinorUnits: number;
  lineTotalMinorUnits: number;
  discountMinorUnits: number;
  promotionId?: string;
}

export interface OrderPricing {
  version: 1;
  currency: 'UGX';
  lines: {
    productId: string | null;
    productName: string;
    quantity: number;
    catalogUnitMinorUnits: number;
    unitMinorUnits: number;
    lineTotalMinorUnits: number;
    discountMinorUnits: number;
    promotionId?: string;
  }[];
  subtotalMinorUnits: number;
  discountMinorUnits: number;
  shippingMinorUnits: number;
  totalMinorUnits: number;
  freeShippingApplied: boolean;
}

/** Delivery fee for a net subtotal (after discounts). */
export function computeShippingMinorUnits(
  netSubtotalMinorUnits: number,
  freeShippingThresholdMinorUnits = 0
): number {
  if (!Number.isFinite(netSubtotalMinorUnits) || netSubtotalMinorUnits <= 0) return 0;
  if (freeShippingThresholdMinorUnits > 0 && netSubtotalMinorUnits >= freeShippingThresholdMinorUnits) {
    return 0;
  }
  return DELIVERY_FEE_MINOR_UNITS;
}

function safeQuantity(quantity: unknown): number {
  const n = Number(quantity);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1000, Math.round(n)));
}

/** Match a deal to a product. Ids first, then an EXACT case-insensitive title. */
export function findDealForProduct(
  opts: { productId?: string | null; productName?: string },
  deals: PromoDeal[] | null | undefined
): PromoDeal | null {
  if (!Array.isArray(deals) || deals.length === 0) return null;
  const id = opts.productId ? String(opts.productId) : '';
  const name = (opts.productName || '').trim().toLowerCase();
  for (const deal of deals) {
    if (!deal || deal.active === false) continue;
    if (id && deal.productId && String(deal.productId) === id) return deal;
  }
  if (!name) return null;
  for (const deal of deals) {
    if (!deal || deal.active === false) continue;
    if (!deal.productId && deal.customTitle && deal.customTitle.trim().toLowerCase() === name) return deal;
  }
  return null;
}

/**
 * Effective unit price for one product.
 *
 * A promotion may only ever make a line CHEAPER than the catalog; a mis-entered
 * deal can never inflate a price. The result is always a whole shilling so the
 * charge and the reconciliation use the same integer.
 */
export function resolveUnitPriceMinor(opts: {
  productId?: string | null;
  productName?: string;
  catalogUnitMinorUnits: number;
  deals?: PromoDeal[] | null;
}): { unitMinorUnits: number; discountMinorUnits: number; catalogUnitMinorUnits: number; promotionId?: string } {
  const catalog = toWholeShillingMinor(opts.catalogUnitMinorUnits);
  const deal = findDealForProduct(opts, opts.deals);
  if (!deal) return { unitMinorUnits: catalog, discountMinorUnits: 0, catalogUnitMinorUnits: catalog };

  let candidate = catalog;
  const customPriceMinor = deal.customPrice == null ? NaN : toMinorUnits(Number(deal.customPrice));
  const percent = Number(deal.discountPercent);

  if (Number.isFinite(customPriceMinor) && customPriceMinor > 0) {
    candidate = toWholeShillingMinor(customPriceMinor);
  } else if (Number.isFinite(percent) && percent > 0 && percent < 100) {
    candidate = toWholeShillingMinor(Math.floor((catalog * (100 - percent)) / 100));
  }

  // Never charge more than the catalog, never less than 1 shilling.
  const unit = Math.min(catalog, Math.max(MINOR_UNITS_PER_MAJOR, candidate));
  return {
    unitMinorUnits: unit,
    discountMinorUnits: Math.max(0, catalog - unit),
    catalogUnitMinorUnits: catalog,
    promotionId: deal.id ? String(deal.id) : undefined,
  };
}

/**
 * Price a whole order. This is THE function; the checkout page and the order
 * API both call it, so a displayed total and a charged total cannot drift.
 */
export function priceOrder(opts: {
  lines: CatalogLine[];
  deals?: PromoDeal[] | null;
  freeShippingThresholdMinorUnits?: number;
}): OrderPricing {
  const priced: PricedLine[] = [];
  for (const line of opts.lines || []) {
    const quantity = safeQuantity(line.quantity);
    const catalogUnit = toWholeShillingMinor(Number(line.catalogUnitMinorUnits));
    const resolved = resolveUnitPriceMinor({
      productId: line.productId,
      productName: line.productName,
      catalogUnitMinorUnits: catalogUnit,
      deals: opts.deals,
    });
    priced.push({
      productId: line.productId ?? null,
      productName: line.productName,
      quantity,
      catalogUnitMinorUnits: resolved.catalogUnitMinorUnits,
      unitMinorUnits: resolved.unitMinorUnits,
      lineCatalogMinorUnits: resolved.catalogUnitMinorUnits * quantity,
      lineTotalMinorUnits: resolved.unitMinorUnits * quantity,
      discountMinorUnits: resolved.discountMinorUnits * quantity,
      promotionId: resolved.promotionId,
    });
  }

  const subtotalMinorUnits = priced.reduce((sum, l) => sum + l.lineCatalogMinorUnits, 0);
  const discountMinorUnits = priced.reduce((sum, l) => sum + l.discountMinorUnits, 0);
  const netSubtotal = subtotalMinorUnits - discountMinorUnits;
  const shippingMinorUnits = computeShippingMinorUnits(netSubtotal, opts.freeShippingThresholdMinorUnits);
  const totalMinorUnits = netSubtotal + shippingMinorUnits;

  return {
    version: 1,
    currency: 'UGX',
    lines: priced.map((l) => ({
      productId: l.productId ?? null,
      productName: l.productName,
      quantity: l.quantity,
      catalogUnitMinorUnits: l.catalogUnitMinorUnits,
      unitMinorUnits: l.unitMinorUnits,
      lineTotalMinorUnits: l.lineTotalMinorUnits,
      discountMinorUnits: l.discountMinorUnits,
      ...(l.promotionId ? { promotionId: l.promotionId } : {}),
    })),
    subtotalMinorUnits,
    discountMinorUnits,
    shippingMinorUnits,
    totalMinorUnits,
    freeShippingApplied: netSubtotal > 0 && shippingMinorUnits === 0,
  };
}

export interface SnapshotValidation {
  ok: boolean;
  reason?: string;
  totalMinorUnits: number;
}

/**
 * Re-derive an order's total from its OWN pricing snapshot and check that it is
 * internally consistent with the stored columns. Used at payment time so a
 * price change in the catalog can never strand (or reprice) a placed order, and
 * so a forged snapshot cannot claim a lower total than its own lines imply.
 */
export function validatePricingSnapshot(opts: {
  snapshot: unknown;
  storedSubtotalMinorUnits?: unknown;
  storedDiscountMinorUnits?: unknown;
  storedShippingMinorUnits?: unknown;
  storedTotalMinorUnits?: unknown;
}): SnapshotValidation {
  const s = opts.snapshot as any;
  const fail = (reason: string): SnapshotValidation => ({ ok: false, reason, totalMinorUnits: NaN });

  if (!s || typeof s !== 'object') return fail('missing snapshot');
  if (s.version !== 1) return fail('unsupported snapshot version');
  if (String(s.currency || '').toUpperCase() !== 'UGX') return fail('snapshot currency');
  if (!Array.isArray(s.lines) || s.lines.length === 0) return fail('snapshot has no lines');
  if (s.lines.length > 100) return fail('snapshot has too many lines');

  let subtotal = 0;
  let discount = 0;
  let total = 0;

  for (const line of s.lines) {
    const quantity = Number(line?.quantity);
    const catalogUnit = Number(line?.catalogUnitMinorUnits);
    const unit = Number(line?.unitMinorUnits);
    const lineTotal = Number(line?.lineTotalMinorUnits);
    const lineDiscount = Number(line?.discountMinorUnits);

    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) return fail('snapshot quantity');
    if (!isWholeShillingMinor(catalogUnit) || catalogUnit <= 0) return fail('snapshot catalog price');
    if (!isWholeShillingMinor(unit) || unit <= 0) return fail('snapshot unit price');
    if (unit > catalogUnit) return fail('snapshot unit price above catalog');
    if (lineTotal !== unit * quantity) return fail('snapshot line total');
    if (lineDiscount !== (catalogUnit - unit) * quantity) return fail('snapshot line discount');

    subtotal += catalogUnit * quantity;
    discount += lineDiscount;
    total += lineTotal;
  }

  if (!isWholeShillingMinor(Number(s.subtotalMinorUnits)) || Number(s.subtotalMinorUnits) !== subtotal) {
    return fail('snapshot subtotal');
  }
  if (!isWholeShillingMinor(Number(s.discountMinorUnits)) || Number(s.discountMinorUnits) !== discount) {
    return fail('snapshot discount');
  }
  if (Number(s.shippingMinorUnits) !== 0 && !isWholeShillingMinor(Number(s.shippingMinorUnits))) {
    return fail('snapshot shipping');
  }
  if (Number(s.totalMinorUnits) !== total + Number(s.shippingMinorUnits)) return fail('snapshot total');

  const storedTotal = Number(opts.storedTotalMinorUnits);
  if (!isWholeShillingMinor(storedTotal)) return fail('stored total is not a whole shilling');
  if (storedTotal !== Number(s.totalMinorUnits)) return fail('stored total disagrees with snapshot');

  const comparison: [string, unknown, number][] = [
    ['stored subtotal', opts.storedSubtotalMinorUnits, subtotal],
    ['stored discount', opts.storedDiscountMinorUnits, discount],
    ['stored shipping', opts.storedShippingMinorUnits, Number(s.shippingMinorUnits)],
  ];
  for (const [label, stored, expected] of comparison) {
    if (stored === undefined || stored === null) continue;
    if (Number(stored) !== expected) return fail(label);
  }

  return { ok: true, totalMinorUnits: storedTotal };
}
