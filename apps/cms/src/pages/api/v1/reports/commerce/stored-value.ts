import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchStoredValueReport } from "../../../../../modules/commerce/application/stored-value-directory";
import { requireStoredValueFeature } from "../../../../../modules/commerce/application/stored-value-http";
import { COMMERCE_STORED_VALUE_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import { SALES_REPORT_TIME_ZONE } from "../../../../../modules/commerce/domain/sales-report-deltas";
import {
  validateSalesReportRange,
  type SalesReportRange
} from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/stored-value?from&to` (Issue #288, ADR-0030) —
 * the closed-loop liability report: per kind (`gift_card`, `store_credit`)
 * what was issued, loaded, redeemed, refunded, adjusted (up and down kept
 * apart) and expired over an inclusive range of report days (default: the last
 * 30, the same window and `Asia/Jakarta` day boundaries the sales reports use),
 * plus what is OUTSTANDING now (the sum of every ledger entry ever written —
 * what is owed), of which how much sits on disabled accounts and how much is
 * lapsed but not yet released by the expiry sweep. Read straight off the
 * append-only ledger, so there is no second projection to drift. Gated on
 * `commerce.stored_value.read` and the tenant's `storedValue` feature; the
 * `reporting` work class like its siblings.
 */
export const GET = defineTenantRoute<SalesReportRange>({
  workClass: "reporting",
  prepare: ({ url }) => {
    const range = validateSalesReportRange({
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
    moduleKey: "commerce",
    activityCode: COMMERCE_STORED_VALUE_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireStoredValueFeature(tx, tenantId);
    if (gate) return gate;
    return ok(
      await fetchStoredValueReport(
        tx,
        tenantId,
        prepared,
        SALES_REPORT_TIME_ZONE
      )
    );
  }
});
