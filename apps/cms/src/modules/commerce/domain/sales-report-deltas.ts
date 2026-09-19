/**
 * Sales-report delta rules — Issue #117 (epic #33 C8, contract #106 / ADR-0017
 * D7). PURE: no database, no I/O, no clock. Everything the three
 * `commerce.sales_*` reporting projections ever add to or subtract from
 * their tables is computed here, and ONLY here — the incremental worker, a
 * rebuild and the reconciliation control total all run the same functions
 * over the same event stream, which is what makes "rebuild equals live" and
 * "reconcile reports no mismatch" properties of the code rather than hopes.
 *
 * ## The rules (the issue's own words, made precise)
 *
 * The source is `awcms_commerce_order_events`, one append-only row per status
 * transition (`from_status -> to_status`). {@link resolveSalesDeltaDirection}
 * maps one event to a sign:
 *
 *   * `-> paid` from a NOT-yet-paid state is `+1`: the order's totals and
 *     line items are ADDED;
 *   * `-> cancelled` or `-> refunded` from a PAID state (`paid`,
 *     `processing`, `shipped`, `completed`) is `-1`: the same figures are
 *     SUBTRACTED again;
 *   * everything else is `0`: a cancellation or expiry of an order that was
 *     never paid, a plain fulfilment step (`processing`, `shipped`,
 *     `completed`), the creation row (`NULL -> pending_payment`).
 *
 * `from_status` is what makes "after a paid event" decidable from the ONE
 * row in hand: the transition table (`order-status.ts`) only lets an order
 * reach a paid state through `paid`, so an event leaving a paid state is,
 * by construction, an event after a paid event. `refunded` is not a status
 * the current graph emits (refunds arrive through `payment_status`), but the
 * contract names it and a gateway's refund notification may log it, so it is
 * handled identically to `cancelled` — and a refund AFTER a cancellation
 * (`cancelled -> refunded`) contributes nothing, because `cancelled` is not
 * a paid state, so an order can never be subtracted twice.
 *
 * ## Attribution day
 *
 * Every figure lands on the day of the order's `paid_at` (falling back to
 * the event's own `created_at` — the only case is a `paid` transition whose
 * header stamp is missing, which the order writer never produces), bucketed
 * in {@link SALES_REPORT_TIME_ZONE}. A reversal therefore always hits the
 * same day row its payment did, so `net` is a true per-day net rather than
 * "payments today minus refunds of some other day". The zone is a code
 * constant, not a per-user preference, because a materialised day bucket is
 * shared by every reader; changing it needs a rebuild.
 *
 * ## Money
 *
 * Integer cents as `bigint`, parsed with `price-calculation.ts`'s `toCents`
 * (the module's one decimal parser); {@link formatCentsDelta} renders a
 * SIGNED `numeric(14,2)` string for SQL — `fromCents` there is unsigned by
 * contract and would mangle a negative delta. `gross` is the order
 * `subtotal` (line totals before discounts), `discount` is
 * `discount + voucher_discount`, `shipping` is `shipping_cost`, `net` is the
 * order `total` (what the customer actually paid: subtotal - discounts +
 * shipping + insurance + tax).
 */
import { toCents } from "./price-calculation";

/** IANA zone every day bucket is computed in. Indonesian stores (BjekMart) report in WIB; a deployment elsewhere changes this constant and rebuilds. */
export const SALES_REPORT_TIME_ZONE = "Asia/Jakarta";

/** All-zero uuid used as the `category_id` of a line whose product has no category — `category_id` is part of the by-category primary key and cannot be NULL. */
export const SALES_REPORT_UNCATEGORISED_ID =
  "00000000-0000-0000-0000-000000000000";

/** Snapshot name stored for the uncategorised bucket; the read routes/screen translate the bucket by id, not by this text. */
export const SALES_REPORT_UNCATEGORISED_NAME = "Uncategorised";

/** Statuses an order can only hold AFTER a `paid` transition. */
export const SALES_PAID_STATES: ReadonlySet<string> = new Set([
  "paid",
  "processing",
  "shipped",
  "completed"
]);

/** Terminal transitions that reverse a paid order's figures. */
export const SALES_REVERSAL_STATES: ReadonlySet<string> = new Set([
  "cancelled",
  "refunded"
]);

export type SalesDeltaDirection = 1 | -1 | 0;

export type SalesOrderEvent = {
  orderId: string;
  fromStatus: string | null;
  toStatus: string;
  createdAt: Date;
};

export type SalesOrderItemSnapshot = {
  productId: string;
  productName: string;
  quantity: number;
  /** `numeric(14,2)` string, as `awcms_commerce_order_items.line_total` stores it. */
  lineTotal: string;
  categoryId: string | null;
  categoryName: string | null;
};

export type SalesOrderSnapshot = {
  orderId: string;
  paidAt: Date | null;
  subtotal: string;
  discount: string;
  voucherDiscount: string;
  shippingCost: string;
  total: string;
  items: readonly SalesOrderItemSnapshot[];
};

export type SalesDailyDelta = {
  day: string;
  ordersPaid: number;
  grossCents: bigint;
  discountCents: bigint;
  shippingCents: bigint;
  netCents: bigint;
};

export type SalesByProductDelta = {
  day: string;
  productId: string;
  productName: string;
  qty: number;
  grossCents: bigint;
};

export type SalesByCategoryDelta = {
  day: string;
  categoryId: string;
  categoryName: string;
  qty: number;
  grossCents: bigint;
};

/** `+1` add, `-1` subtract, `0` ignore — see the file header for the exact rule. */
export function resolveSalesDeltaDirection(
  event: Pick<SalesOrderEvent, "fromStatus" | "toStatus">
): SalesDeltaDirection {
  const wasPaid =
    event.fromStatus !== null && SALES_PAID_STATES.has(event.fromStatus);

  if (event.toStatus === "paid") {
    return wasPaid ? 0 : 1;
  }
  if (SALES_REVERSAL_STATES.has(event.toStatus)) {
    return wasPaid ? -1 : 0;
  }
  return 0;
}

const dayFormatterCache = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD` of `instant` in `timeZone` (default {@link SALES_REPORT_TIME_ZONE}). `en-CA` is the locale whose default date pattern IS ISO-8601. */
export function resolveSalesReportDay(
  instant: Date,
  timeZone: string = SALES_REPORT_TIME_ZONE
): string {
  let formatter = dayFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    dayFormatterCache.set(timeZone, formatter);
  }
  return formatter.format(instant);
}

/** The day an order's figures are attributed to: `paid_at`, else the event's own timestamp. */
export function resolveSalesAttributionDay(
  order: Pick<SalesOrderSnapshot, "paidAt">,
  event: Pick<SalesOrderEvent, "createdAt">
): string {
  return resolveSalesReportDay(order.paidAt ?? event.createdAt);
}

export function computeSalesDailyDelta(
  order: SalesOrderSnapshot,
  direction: SalesDeltaDirection,
  day: string
): SalesDailyDelta | null {
  if (direction === 0) return null;
  const sign = BigInt(direction);
  return {
    day,
    ordersPaid: direction,
    grossCents: sign * toCents(order.subtotal),
    discountCents:
      sign * (toCents(order.discount) + toCents(order.voucherDiscount)),
    shippingCents: sign * toCents(order.shippingCost),
    netCents: sign * toCents(order.total)
  };
}

/** One delta per DISTINCT product in the order (two lines of the same product — e.g. two variants — fold into one row, matching the by-product table's key). */
export function computeSalesByProductDeltas(
  order: SalesOrderSnapshot,
  direction: SalesDeltaDirection,
  day: string
): SalesByProductDelta[] {
  if (direction === 0) return [];
  const sign = BigInt(direction);
  const byProduct = new Map<string, SalesByProductDelta>();

  for (const item of order.items) {
    const existing = byProduct.get(item.productId);
    const qty = direction * item.quantity;
    const grossCents = sign * toCents(item.lineTotal);
    if (existing) {
      existing.qty += qty;
      existing.grossCents += grossCents;
    } else {
      byProduct.set(item.productId, {
        day,
        productId: item.productId,
        productName: item.productName,
        qty,
        grossCents
      });
    }
  }

  return Array.from(byProduct.values());
}

/** One delta per DISTINCT category in the order; a product without a category lands in the {@link SALES_REPORT_UNCATEGORISED_ID} bucket. */
export function computeSalesByCategoryDeltas(
  order: SalesOrderSnapshot,
  direction: SalesDeltaDirection,
  day: string
): SalesByCategoryDelta[] {
  if (direction === 0) return [];
  const sign = BigInt(direction);
  const byCategory = new Map<string, SalesByCategoryDelta>();

  for (const item of order.items) {
    const categoryId = item.categoryId ?? SALES_REPORT_UNCATEGORISED_ID;
    const categoryName =
      item.categoryId === null
        ? SALES_REPORT_UNCATEGORISED_NAME
        : (item.categoryName ?? SALES_REPORT_UNCATEGORISED_NAME);
    const existing = byCategory.get(categoryId);
    const qty = direction * item.quantity;
    const grossCents = sign * toCents(item.lineTotal);
    if (existing) {
      existing.qty += qty;
      existing.grossCents += grossCents;
    } else {
      byCategory.set(categoryId, {
        day,
        categoryId,
        categoryName,
        qty,
        grossCents
      });
    }
  }

  return Array.from(byCategory.values());
}

/** Signed `numeric(14,2)` string for a cents delta (`-150n` -> `"-1.50"`). */
export function formatCentsDelta(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = absolute % 100n;
  return `${negative ? "-" : ""}${whole}.${fraction.toString().padStart(2, "0")}`;
}

/** Sum of the pure deltas over a whole event stream — the in-memory control total reconciliation compares with the tables. Keys are the projection-private reconciliation metric keys. */
export type SalesControlTotals = {
  ordersPaid: number;
  grossCents: bigint;
  discountCents: bigint;
  shippingCents: bigint;
  netCents: bigint;
  itemQty: number;
  itemGrossCents: bigint;
};

export function emptySalesControlTotals(): SalesControlTotals {
  return {
    ordersPaid: 0,
    grossCents: 0n,
    discountCents: 0n,
    shippingCents: 0n,
    netCents: 0n,
    itemQty: 0,
    itemGrossCents: 0n
  };
}

/** Folds one (event, order) pair into running control totals — the same three delta functions, summed. */
export function accumulateSalesControlTotals(
  totals: SalesControlTotals,
  event: SalesOrderEvent,
  order: SalesOrderSnapshot
): SalesControlTotals {
  const direction = resolveSalesDeltaDirection(event);
  if (direction === 0) return totals;
  const day = resolveSalesAttributionDay(order, event);

  const daily = computeSalesDailyDelta(order, direction, day)!;
  totals.ordersPaid += daily.ordersPaid;
  totals.grossCents += daily.grossCents;
  totals.discountCents += daily.discountCents;
  totals.shippingCents += daily.shippingCents;
  totals.netCents += daily.netCents;

  for (const line of computeSalesByProductDeltas(order, direction, day)) {
    totals.itemQty += line.qty;
    totals.itemGrossCents += line.grossCents;
  }

  return totals;
}
