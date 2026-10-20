import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchBookingRevenueReport } from "../../../../../modules/commerce/application/booking-revenue-report";
import {
  validateBookingRevenueRange,
  type BookingRevenueRange
} from "../../../../../modules/commerce/domain/booking-revenue";

/**
 * `GET /api/v1/reports/commerce/booking-revenue?from&to` (Issue #389, ADR-0045
 * amendment note; metrics spec sections 3, 3.7 and 8.2) - the booking-sourced
 * revenue waterfall per Asia/Jakarta paid day in the inclusive range (default:
 * the last 30 days), read from the `commerce.booking_revenue` projection:
 * gross, discounts, refunds (split into "paid back" and "uncollected balance,
 * no money moved"), net, the shipping / insurance / tax companions, the balance
 * still outstanding on open orders, and the stay and no-show counts and rate.
 * Revenue follows the commerce order and the payment ledger only; a day is the
 * day of the order's first paid transition, so a later refund, a no-show or a
 * cancellation restates THAT day. Aggregates only - no order, customer, name or
 * contact. Gated on `reporting.dashboard.read`, the sales report routes' own
 * permission; while the tenant's `booking` feature is OFF the answer is `200`
 * with `enabled: false` and no days. Freshness / rebuild / reconcile of the
 * underlying projection live on `GET /api/v1/reports/projections/{key}`.
 */
export const GET = defineTenantRoute<BookingRevenueRange>({
  workClass: "reporting",
  prepare: ({ url }) => {
    const range = validateBookingRevenueRange({
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to")
    });
    if (!range.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Invalid date range.",
        {},
        range.errors
      );
    }
    return range.value;
  },
  authorize: {
    moduleKey: "reporting",
    activityCode: "dashboard",
    action: "read"
  },
  handler: async ({ tx, tenantId, prepared }) =>
    ok(await fetchBookingRevenueReport(tx, tenantId, prepared))
});
