import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchBookingPipeline } from "../../../../../modules/commerce/application/booking-pipeline";

/**
 * `GET /api/v1/reports/commerce/booking-pipeline` (Issue #389, ADR-0045
 * amendment note; metrics spec sections 4.3 and 8.2) - the booking hold
 * pipeline AS OF NOW: the holds the adapter is waiting to see paid, with the
 * held units (resource-nights for a stay product, one per slot), their value,
 * the age of the oldest hold and the soonest expiry. Held space is neither
 * occupancy nor revenue; it is a line of its own. A live, read-only,
 * tenant-scoped query over the adapter's link table and the order (a hold is a
 * current state, not an event sum), so it is as fresh as the database. Counts
 * and money only. Gated on `reporting.dashboard.read`; while the tenant's
 * `booking` feature is OFF the answer is `200` with `enabled: false`.
 */
export const GET = defineTenantRoute({
  workClass: "reporting",
  authorize: {
    moduleKey: "reporting",
    activityCode: "dashboard",
    action: "read"
  },
  handler: async ({ tx, tenantId }) =>
    ok(await fetchBookingPipeline(tx, tenantId))
});
