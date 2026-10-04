/**
 * `GET /api/v1/commerce/returns/reconcile` - read-only reconciliation of the
 * returns, refunds and payment-ledger trio (Issue #287, ADR-0033): an
 * over-returned line, a settled refund with no matching reversal, a refund
 * reversal that belongs to no refund, a payment refunded beyond its amount, a
 * return whose money split disagrees with its lines, a restock that
 * disagrees with its disposition, an open return that is fully refunded.
 * Nothing is repaired - every table involved is append-only or a state
 * machine. Gated on `commerce.refunds.read` and the `returns` feature.
 */
import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { reconcileReturns } from "../../../../../modules/commerce/application/return-directory";
import { requireReturnsFeature } from "../../../../../modules/commerce/application/return-http";
import { COMMERCE_REFUNDS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

export const GET = defineTenantRoute({
  workClass: "reporting",
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REFUNDS_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId }) => {
    const gate = await requireReturnsFeature(tx, tenantId);
    if (gate) return gate;
    return ok(await reconcileReturns(tx, tenantId));
  }
});
