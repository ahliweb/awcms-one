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
 * ## Returns (Issue #287, ADR-0033)
 *
 * A return does not move the order's status, so it announces itself on the
 * same stream with one `order_events` row (`to_status = 'returned'`,
 * `return_id` set). {@link resolveSalesDeltaDirection} maps it to `0` (it is
 * not a status transition); the sinks route such a row to the `computeSalesReturn*`
 * functions below, which SUBTRACT exactly what the return gave back: the goods
 * (per product / category), the discount released with them, the shipping
 * refunded, and the money (`refund_total`) from `net`. `orders_paid` is not
 * touched - the order was paid; it simply has a smaller net. A later
 * cancellation of a partly-returned order must subtract only what is left, so
 * a `-1` event is netted with {@link netOfPriorReturns} over the returns whose
 * events precede it in the stream - which makes a rebuild (replaying the
 * stream) produce the same tables as the live pass.
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
  /** The `order_events` row id, when known (orders the stream with `createdAt`). */
  id?: string;
  /** Issue #287: set on a `returned` row - the return it announces. */
  returnId?: string | null;
  orderId: string;
  fromStatus: string | null;
  toStatus: string;
  createdAt: Date;
};

export type SalesOrderItemSnapshot = {
  /** `order_items.id`; needed only to net earlier returns (Issue #287). */
  orderItemId?: string;
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

// ---------------------------------------------------------------------------
// Returns (Issue #287, ADR-0033)
// ---------------------------------------------------------------------------

export type SalesReturnLineSnapshot = {
  productId: string;
  productName: string;
  quantity: number;
  /** `numeric(14,2)` string - the line's goods value before discount. */
  goodsGross: string;
  categoryId: string | null;
  categoryName: string | null;
};

export type SalesReturnSnapshot = {
  returnId: string;
  orderId: string;
  /** The order's `paid_at` - a return lands on the day its sale did. */
  paidAt: Date | null;
  goodsGross: string;
  discountShare: string;
  shippingRefund: string;
  refundTotal: string;
  lines: readonly SalesReturnLineSnapshot[];
};

/** The day a return's figures are attributed to: the order's `paid_at`, else the event's own timestamp. */
export function resolveSalesReturnDay(
  ret: Pick<SalesReturnSnapshot, "paidAt">,
  event: Pick<SalesOrderEvent, "createdAt">
): string {
  return resolveSalesReportDay(ret.paidAt ?? event.createdAt);
}

/** A return subtracts its goods, discount, shipping and money; it removes no paid order. */
export function computeSalesReturnDailyDelta(
  ret: SalesReturnSnapshot,
  day: string
): SalesDailyDelta {
  return {
    day,
    ordersPaid: 0,
    grossCents: -toCents(ret.goodsGross),
    discountCents: -toCents(ret.discountShare),
    shippingCents: -toCents(ret.shippingRefund),
    netCents: -toCents(ret.refundTotal)
  };
}

export function computeSalesReturnProductDeltas(
  ret: SalesReturnSnapshot,
  day: string
): SalesByProductDelta[] {
  const byProduct = new Map<string, SalesByProductDelta>();
  for (const line of ret.lines) {
    const existing = byProduct.get(line.productId);
    if (existing) {
      existing.qty -= line.quantity;
      existing.grossCents -= toCents(line.goodsGross);
    } else {
      byProduct.set(line.productId, {
        day,
        productId: line.productId,
        productName: line.productName,
        qty: -line.quantity,
        grossCents: -toCents(line.goodsGross)
      });
    }
  }
  return Array.from(byProduct.values());
}

export function computeSalesReturnCategoryDeltas(
  ret: SalesReturnSnapshot,
  day: string
): SalesByCategoryDelta[] {
  const byCategory = new Map<string, SalesByCategoryDelta>();
  for (const line of ret.lines) {
    const categoryId = line.categoryId ?? SALES_REPORT_UNCATEGORISED_ID;
    const categoryName =
      line.categoryId === null
        ? SALES_REPORT_UNCATEGORISED_NAME
        : (line.categoryName ?? SALES_REPORT_UNCATEGORISED_NAME);
    const existing = byCategory.get(categoryId);
    if (existing) {
      existing.qty -= line.quantity;
      existing.grossCents -= toCents(line.goodsGross);
    } else {
      byCategory.set(categoryId, {
        day,
        categoryId,
        categoryName,
        qty: -line.quantity,
        grossCents: -toCents(line.goodsGross)
      });
    }
  }
  return Array.from(byCategory.values());
}

/** Folds one return into the running control totals - the same three delta functions, summed. */
export function accumulateSalesReturnControlTotals(
  totals: SalesControlTotals,
  ret: SalesReturnSnapshot,
  day: string
): SalesControlTotals {
  const daily = computeSalesReturnDailyDelta(ret, day);
  totals.grossCents += daily.grossCents;
  totals.discountCents += daily.discountCents;
  totals.shippingCents += daily.shippingCents;
  totals.netCents += daily.netCents;
  for (const line of computeSalesReturnProductDeltas(ret, day)) {
    totals.itemQty += line.qty;
    totals.itemGrossCents += line.grossCents;
  }
  return totals;
}

/** What earlier returns of an order already gave back (in stream order). */
export type SalesPriorReturns = {
  goodsGrossCents: bigint;
  discountShareCents: bigint;
  shippingRefundCents: bigint;
  refundTotalCents: bigint;
  byItem: ReadonlyMap<string, { quantity: number; goodsGrossCents: bigint }>;
};

export function emptySalesPriorReturns(): SalesPriorReturns {
  return {
    goodsGrossCents: 0n,
    discountShareCents: 0n,
    shippingRefundCents: 0n,
    refundTotalCents: 0n,
    byItem: new Map()
  };
}

/**
 * The order as it still stands after earlier returns: what a later `-1`
 * (cancelled / refunded from a paid state) event must subtract, so a
 * partly-returned order that is then cancelled nets to zero rather than going
 * negative. The discount released is taken from `discount` first, then from
 * `voucherDiscount`; every figure stays non-negative.
 */
export function netOfPriorReturns(
  order: SalesOrderSnapshot,
  prior: SalesPriorReturns
): SalesOrderSnapshot {
  const max0 = (v: bigint): bigint => (v < 0n ? 0n : v);
  const discount = toCents(order.discount);
  const takeFromDiscount =
    prior.discountShareCents < discount ? prior.discountShareCents : discount;
  const takeFromVoucher = prior.discountShareCents - takeFromDiscount;
  return {
    ...order,
    subtotal: formatCentsDelta(
      max0(toCents(order.subtotal) - prior.goodsGrossCents)
    ),
    discount: formatCentsDelta(discount - takeFromDiscount),
    voucherDiscount: formatCentsDelta(
      max0(toCents(order.voucherDiscount) - takeFromVoucher)
    ),
    shippingCost: formatCentsDelta(
      max0(toCents(order.shippingCost) - prior.shippingRefundCents)
    ),
    total: formatCentsDelta(
      max0(toCents(order.total) - prior.refundTotalCents)
    ),
    items: order.items.map((item) => {
      const returned = item.orderItemId
        ? prior.byItem.get(item.orderItemId)
        : undefined;
      if (!returned) return item;
      return {
        ...item,
        quantity: Math.max(0, item.quantity - returned.quantity),
        lineTotal: formatCentsDelta(
          max0(toCents(item.lineTotal) - returned.goodsGrossCents)
        )
      };
    })
  };
}
