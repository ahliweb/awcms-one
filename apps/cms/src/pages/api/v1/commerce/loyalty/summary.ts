import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../modules/commerce/application/commerce-feature-gate";
import { fetchLoyaltySummary } from "../../../../../modules/commerce/application/loyalty-ledger";
import { parseDateRange } from "../../../../../modules/commerce/application/loyalty-route-support";
import { COMMERCE_LOYALTY_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

/**
 * `GET /api/v1/commerce/loyalty/summary?from=&to=` (Issue #289) — earned /
 * redeemed / expired / reversed / net for the window, plus the all-time
 * outstanding points, all SUMMED FROM THE LEDGER by `kind` so no point is
 * counted twice. `from`/`to` are ISO instants or `YYYY-MM-DD` days; both are
 * optional (omitted = unbounded).
 */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_LOYALTY_ACTIVITY_CODE,
  action: "read"
} as const;

export const GET = defineTenantRoute<{ from?: Date; to?: Date }>({
  workClass: "interactive",
  prepare: ({ url }) => parseDateRange(url),
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "loyalty"
    );
    if (gate) return gate;

    return ok(await fetchLoyaltySummary(tx, tenantId, prepared));
  }
});
