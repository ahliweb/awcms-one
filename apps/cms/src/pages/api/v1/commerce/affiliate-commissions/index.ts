import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../modules/_shared/keyset-pagination";
import { listAffiliateCommissionsForAdmin } from "../../../../../modules/commerce/application/affiliate-directory";
import { COMMERCE_AFFILIATE_COMMISSIONS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const COMMISSION_STATUSES = ["pending", "approved", "paid", "void"] as const;
type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

/** `GET /api/v1/commerce/affiliate-commissions?status=` — staff list, keyset (Issue #92). */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_AFFILIATE_COMMISSIONS_ACTIVITY_CODE,
  action: "read"
} as const;

type Prepared = { cursor: KeysetCursor | null; status?: CommissionStatus };

export const GET = defineTenantRoute({
  workClass: "interactive",
  prepare: ({ url }): Prepared | Response => {
    const cursorParam = url.searchParams.get("cursor");
    let cursor: KeysetCursor | null = null;
    if (cursorParam) {
      const decoded = decodeKeysetCursor(cursorParam);
      if (!decoded)
        return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
      cursor = decoded;
    }

    const statusParam = url.searchParams.get("status");
    if (
      statusParam &&
      !(COMMISSION_STATUSES as readonly string[]).includes(statusParam)
    ) {
      return fail(
        400,
        "VALIDATION_ERROR",
        `status must be one of: ${COMMISSION_STATUSES.join(", ")}.`
      );
    }

    return { cursor, status: statusParam as CommissionStatus | undefined };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) =>
    ok(
      await listAffiliateCommissionsForAdmin(tx, tenantId, prepared.cursor, {
        status: prepared.status
      })
    )
});
