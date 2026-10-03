import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  listOutstandingBalances,
  OUTSTANDING_BALANCES_DEFAULT_LIMIT,
  OUTSTANDING_BALANCES_MAX_LIMIT
} from "../../../../../modules/commerce/application/payment-allocation-directory";
import { COMMERCE_PAYMENTS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

type PreparedOutstanding = { channel: string | null; limit: number };

/**
 * `GET /api/v1/reports/commerce/outstanding-balances?channel&limit` (Issue
 * #285, ADR-0025) — every order that still owes money (not cancelled/expired,
 * `total − settled > 0`, `settled` re-derived from the payment-allocation
 * ledger), largest balance first, with the count and total outstanding of
 * EVERY match and the first `limit` rows (default 100, max 500). Optional
 * `channel=storefront|pos` filter. Gated on `commerce.payments.read`;
 * `reporting` work class.
 */
export const GET = defineTenantRoute<PreparedOutstanding>({
  workClass: "reporting",
  prepare: ({ url }): PreparedOutstanding | Response => {
    const channel = url.searchParams.get("channel");
    if (channel !== null && channel !== "storefront" && channel !== "pos") {
      return fail(
        400,
        "VALIDATION_ERROR",
        "channel must be storefront or pos."
      );
    }

    const limitParam = url.searchParams.get("limit");
    let limit = OUTSTANDING_BALANCES_DEFAULT_LIMIT;
    if (limitParam !== null) {
      const parsed = Number(limitParam);
      if (
        !/^\d+$/.test(limitParam) ||
        !Number.isInteger(parsed) ||
        parsed < 1 ||
        parsed > OUTSTANDING_BALANCES_MAX_LIMIT
      ) {
        return fail(
          400,
          "VALIDATION_ERROR",
          `limit must be an integer between 1 and ${OUTSTANDING_BALANCES_MAX_LIMIT}.`
        );
      }
      limit = parsed;
    }
    return { channel, limit };
  },
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_PAYMENTS_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId, prepared }) =>
    ok(await listOutstandingBalances(tx, tenantId, prepared))
});
