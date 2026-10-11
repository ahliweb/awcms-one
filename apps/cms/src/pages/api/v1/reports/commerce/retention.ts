import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchRetentionReport } from "../../../../../modules/commerce/application/retention-report-directory";
import { COMMERCE_REPORT_RETENTION_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import {
  validateRetentionRange,
  type RetentionRange
} from "../../../../../modules/commerce/domain/retention";

/**
 * `GET /api/v1/reports/commerce/retention?months=` (Issue #364, ADR-0044;
 * metrics spec section 6) - the 90-day repeat rate of each customer cohort (the
 * `Asia/Jakarta` calendar month of the customer's first qualifying paid order),
 * for the last `months` cohort months (default 12, at most 36), read from the
 * `commerce.customer_retention` projection. Counts only: no customer id, name or
 * contact is ever returned. A cohort whose 90-day window has not fully elapsed
 * is `mature: false` ("to date"); a cohort under 20 customers has
 * `rateShown: false` and a `null` percentage; a closed cohort changed by a late
 * event is `restated: true`. Gated on `commerce.report_retention.read`, a
 * permission of its own (not implied by `reporting.dashboard.read` or
 * `commerce.customers.read`). While the tenant's `retention` feature is OFF the
 * answer is `200` with `enabled: false` and no cohorts.
 */
export const GET = defineTenantRoute<RetentionRange>({
  workClass: "reporting",
  prepare: ({ url }) => {
    const range = validateRetentionRange({
      months: url.searchParams.get("months")
    });
    if (!range.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Invalid retention range.",
        {},
        range.errors
      );
    }
    return range.value;
  },
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REPORT_RETENTION_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId, prepared }) =>
    ok(await fetchRetentionReport(tx, tenantId, prepared))
});
