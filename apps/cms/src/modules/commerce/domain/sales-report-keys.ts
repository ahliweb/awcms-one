/**
 * Stable identifiers of the three sales-report projections `commerce`
 * contributes to the `reporting` engine (Issue #117, contract #106 / ADR-0017
 * D7) — same role `reporting/domain/projection-keys.ts` plays for that
 * module's own three. Pure constants; the descriptors themselves live in
 * `commerce/module.ts` (`reportingProjections`), the sinks and hooks in
 * `application/sales-report-projection.ts`, the arithmetic in
 * `domain/sales-report-deltas.ts`.
 */

export const SALES_DAILY_PROJECTION_KEY = "commerce.sales_daily";
export const SALES_BY_PRODUCT_PROJECTION_KEY = "commerce.sales_by_product";
export const SALES_BY_CATEGORY_PROJECTION_KEY = "commerce.sales_by_category";

export const SALES_REPORT_PROJECTION_KEYS = [
  SALES_DAILY_PROJECTION_KEY,
  SALES_BY_PRODUCT_PROJECTION_KEY,
  SALES_BY_CATEGORY_PROJECTION_KEY
] as const;

export type SalesReportProjectionKey =
  (typeof SALES_REPORT_PROJECTION_KEYS)[number];

/** The one source stream all three share — `awcms_commerce_order_events`, cursor `created_at`. Each descriptor keys its OWN cursor row under this stream key (cursors are per (tenant, projection, stream)). */
export const SALES_ORDER_EVENTS_STREAM_KEY = "order_events";

/**
 * The scalar counter each descriptor keeps in the engine's own
 * `awcms_reporting_projection_metrics` alongside its dimensional table: the
 * number of `-> paid` events consumed. It is the figure the generic
 * projection card shows and the engine's own reconciliation (`COUNT(*)
 * WHERE to_status = 'paid'`) checks; the money/quantity control totals are
 * the dimensional hooks' job.
 */
export const SALES_REPORT_METRIC_KEYS = {
  paidEvents: "paid_events"
} as const;

/** Reconciliation keys of the dimensional control totals (integers: counts, or money in cents). */
export const SALES_DAILY_CONTROL_KEYS = {
  ordersPaid: "sales_orders_paid",
  grossCents: "sales_gross_cents",
  discountCents: "sales_discount_cents",
  shippingCents: "sales_shipping_cents",
  netCents: "sales_net_cents"
} as const;

export const SALES_LINE_CONTROL_KEYS = {
  qty: "sales_item_qty",
  grossCents: "sales_item_gross_cents"
} as const;
