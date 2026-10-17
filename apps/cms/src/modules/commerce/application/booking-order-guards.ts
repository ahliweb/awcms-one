/**
 * Small tenant-scoped questions the generic order paths ask about the booking
 * adapter (Issue #380, ADR-0045 D1/G11). They read ONLY the adapter's own
 * tables (`awcms_commerce_booking_*`), never Booking's, and never write.
 *
 *   - {@link orderHasBookingLink}: the order was created from a Booking hold.
 *     Such an order moves no product stock (capacity is Booking's), so the
 *     restock on cancel/expiry skips it; and a PAID one is refused by the
 *     generic admin-status cancel and by the returns path - those go through the
 *     adapter, which #381 builds.
 *   - {@link orderHasActiveBookingLink}: the order's reservation is still live.
 *
 * The product-level guard (a product with an active offering link cannot be sold
 * through the ordinary cart, storefront order, quotation or POS path) is in the
 * cart quote (`cart-quote-service.ts` / `domain/cart-quote.ts`): the line is
 * `unavailable`, so `canCheckout` is false on every path that quotes.
 */

/** `true` when ANY reservation link (active, superseded or released) names the order. */
export async function orderHasBookingLink(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<boolean> {
  const rows = (await tx`
    SELECT 1 AS found
    FROM awcms_commerce_booking_reservation_links
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
    LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}

/** `true` when an ACTIVE reservation link names the order. */
export async function orderHasActiveBookingLink(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<boolean> {
  const rows = (await tx`
    SELECT 1 AS found
    FROM awcms_commerce_booking_reservation_links
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
      AND status = 'active'
    LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}

/** Thrown by a generic order path that must not touch a paid booking order; the route answers `409 BOOKING_ORDER_USE_ADAPTER`. */
export class BookingOrderUseAdapterError extends Error {
  constructor() {
    super(
      "This order is a paid booking: cancel it through the booking reservation, not the generic order path."
    );
    this.name = "BookingOrderUseAdapterError";
  }
}
