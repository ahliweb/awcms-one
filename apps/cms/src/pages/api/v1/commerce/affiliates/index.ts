import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../modules/_shared/keyset-pagination";
import { listAffiliatesForAdmin } from "../../../../../modules/commerce/application/affiliate-directory";
import { COMMERCE_AFFILIATES_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

/** `GET /api/v1/commerce/affiliates` — staff list, keyset (Issue #92). */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_AFFILIATES_ACTIVITY_CODE,
  action: "read"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  prepare: ({ url }): KeysetCursor | null | Response => {
    const cursorParam = url.searchParams.get("cursor");
    if (!cursorParam) return null;
    const decoded = decodeKeysetCursor(cursorParam);
    if (!decoded) return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
    return decoded;
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) =>
    ok(await listAffiliatesForAdmin(tx, tenantId, prepared))
});
