/**
 * Canonical status vocabulary.
 *
 * The DATABASE is lowercase — it is the source of truth and the live schema's
 * CHECK constraints use lowercase (`pending`, `processing`, `shipped`,
 * `delivered`, `cancelled`; `pending`, `paid`, `failed`, `refunded`). Writing
 * `'Pending'` against those constraints is rejected, and mixing case in one
 * column breaks every SQL report and `WHERE status = 'delivered'` filter.
 *
 * The UI keeps using Title Case for display only. `mapOrderRow` already maps the
 * stored value up for the view model, so nothing in the components changes.
 *
 * RULE: write only these constants. Never a string literal.
 */

export const ORDER_STATUS = {
  pending: 'pending',
  processing: 'processing',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
} as const;

export const PAYMENT_STATUS = {
  pending: 'pending',
  paid: 'paid',
  failed: 'failed',
  refunded: 'refunded',
} as const;

/**
 * `payments.status` is the LEDGER state of a single payment attempt, which is a
 * different vocabulary from the order's `payment_status`: a settlement is
 * `success`, not `paid`.
 */
export const PAYMENT_ROW_STATUS = {
  pending: 'pending',
  success: 'success',
  failed: 'failed',
  refunded: 'refunded',
} as const;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];
export type PaymentRowStatus = (typeof PAYMENT_ROW_STATUS)[keyof typeof PAYMENT_ROW_STATUS];

const ORDER_VALUES = new Set<string>(Object.values(ORDER_STATUS));
const PAYMENT_VALUES = new Set<string>(Object.values(PAYMENT_STATUS));
const PAYMENT_ROW_VALUES = new Set<string>(Object.values(PAYMENT_ROW_STATUS));

/** Accept `Processing`, `PROCESSING`, `processing` → `processing`; unknown → pending. */
export function normaliseOrderStatus(value: unknown): OrderStatus {
  const v = String(value ?? '').trim().toLowerCase();
  return (ORDER_VALUES.has(v) ? v : ORDER_STATUS.pending) as OrderStatus;
}

/** Accept any casing; unknown → pending (never claim money arrived by accident). */
export function normalisePaymentStatus(value: unknown): PaymentStatus {
  const v = String(value ?? '').trim().toLowerCase();
  return (PAYMENT_VALUES.has(v) ? v : PAYMENT_STATUS.pending) as PaymentStatus;
}

export function normalisePaymentRowStatus(value: unknown): PaymentRowStatus {
  const v = String(value ?? '').trim().toLowerCase();
  return (PAYMENT_ROW_VALUES.has(v) ? v : PAYMENT_ROW_STATUS.pending) as PaymentRowStatus;
}

/** Ledger status for a payment attempt, derived from the order's payment state. */
export function paymentRowStatusFor(status: PaymentStatus): PaymentRowStatus {
  if (status === PAYMENT_STATUS.paid) return PAYMENT_ROW_STATUS.success;
  if (status === PAYMENT_STATUS.refunded) return PAYMENT_ROW_STATUS.refunded;
  if (status === PAYMENT_STATUS.failed) return PAYMENT_ROW_STATUS.failed;
  return PAYMENT_ROW_STATUS.pending;
}

/** `processing` → `Processing`, for UI labels only. Never write this to the DB. */
export function orderStatusLabel(value: unknown): string {
  const v = normaliseOrderStatus(value);
  return v.charAt(0).toUpperCase() + v.slice(1);
}

export function paymentStatusLabel(value: unknown): string {
  const v = normalisePaymentStatus(value);
  return v.charAt(0).toUpperCase() + v.slice(1);
}

export const isPaid = (value: unknown): boolean => normalisePaymentStatus(value) === PAYMENT_STATUS.paid;
export const isRefunded = (value: unknown): boolean =>
  normalisePaymentStatus(value) === PAYMENT_STATUS.refunded;
export const isCancelled = (value: unknown): boolean =>
  normaliseOrderStatus(value) === ORDER_STATUS.cancelled;

/** The only order statuses an admin may set by hand. */
export const ADMIN_SETTABLE_ORDER_STATUSES: readonly OrderStatus[] = [
  ORDER_STATUS.pending,
  ORDER_STATUS.processing,
  ORDER_STATUS.shipped,
  ORDER_STATUS.delivered,
  ORDER_STATUS.cancelled,
];
