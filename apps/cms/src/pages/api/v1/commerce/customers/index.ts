import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../modules/_shared/keyset-pagination";
import { listCustomers } from "../../../../../modules/commerce/application/customer-directory";
import { COMMERCE_CUSTOMERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

/** `GET /api/v1/commerce/customers` — admin list (Issue #29). */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CUSTOMERS_ACTIVITY_CODE,
  action: "read"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  prepare: ({ url }): { cursor: KeysetCursor | null } | Response => {
    const cursorParam = url.searchParams.get("cursor");
    if (!cursorParam) return { cursor: null };
    const decoded = decodeKeysetCursor(cursorParam);
    if (!decoded) return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
    return { cursor: decoded };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) =>
    ok(await listCustomers(tx, tenantId, prepared.cursor))
});
