/**
 * Order/cart-quote type unions shared across `domain/`, `application/` and
 * the API routes for Issue #29 — kept in one small file (rather than
 * scattered `type` literals per consumer) for the same reason
 * `product-status.ts`/`product-type.ts` are their own files elsewhere in
 * this module: one place a value's full vocabulary is declared, so a
 * `switch` that handles every case can be checked for exhaustiveness against
 * it.
 *
 * These are the SAME five unions `packages/kontrak/src/commerce-orders.ts`
 * exports for `apps/storefront` to import — kept in sync by hand (this repo
 * has no cross-workspace type generation), the same convention every other
 * `packages/kontrak` DTO already follows for this module's catalog/marketing
 * types.
 */
export type OrderStatus =
  | "pending_payment"
  | "paid"
  | "processing"
  | "shipped"
  | "completed"
  | "cancelled"
  | "expired";

export type PaymentMethod = "manual_bank" | "manual_qris" | "dp" | "gateway";

export type PaymentStatus = "unpaid" | "dp_paid" | "paid" | "refunded";

export type ShippingMethod = "alternative" | "self_pickup" | "courier";

export type CartLineStatus =
  | "ok"
  | "price_changed"
  | "out_of_stock"
  | "quantity_reduced"
  | "unavailable"
  | "min_purchase"
  | "service_form_invalid";
