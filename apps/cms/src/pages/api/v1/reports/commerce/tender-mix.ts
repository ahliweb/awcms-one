import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { listTenderMix } from "../../../../../modules/commerce/application/payment-allocation-directory";
import { COMMERCE_PAYMENTS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import { SALES_REPORT_TIME_ZONE } from "../../../../../modules/commerce/domain/sales-report-deltas";
import {
  validateSalesReportRange,
  type SalesReportRange
} from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/tender-mix?from&to` (Issue #285, ADR-0025) —
 * money movement by tender over an inclusive range of report days (default:
 * the last 30, the same window and `Asia/Jakarta` day boundaries the sales
 * reports use), read straight off the payment-allocation ledger: payments,
 * reversals and net per tender, plus the range totals. The ledger is the
 * source of truth, so there is no second projection to drift. Gated on
 * `commerce.payments.read` — a figure about money by tender is a payments
 * read, not a general dashboard read. `reporting` work class like its
 * siblings: an aggregate over a bounded range, never competing with
 * interactive traffic for pool slots.
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
    activityCode: COMMERCE_PAYMENTS_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId, prepared }) =>
    ok(await listTenderMix(tx, tenantId, prepared, SALES_REPORT_TIME_ZONE))
});
