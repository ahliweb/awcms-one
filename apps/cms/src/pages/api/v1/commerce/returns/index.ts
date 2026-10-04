/**
 * `GET /api/v1/commerce/returns` - the tenant's returns, newest first, keyset
 * paged (`?status=open|completed&limit=&cursor=`) (Issue #287, ADR-0033).
 * Gated on `commerce.returns.read` and the `returns` feature.
 */
import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { requireReturnsFeature } from "../../../../../modules/commerce/application/return-http";
import {
  decodeKeysetCursor,
  listReturns
} from "../../../../../modules/commerce/application/return-records";
import { COMMERCE_RETURNS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import {
  RETURN_STATUSES,
  type ReturnStatus
} from "../../../../../modules/commerce/domain/returns";

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_RETURNS_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId, url }) => {
    const gate = await requireReturnsFeature(tx, tenantId);
    if (gate) return gate;

    const statusParam = url.searchParams.get("status");
    if (
      statusParam !== null &&
      !(RETURN_STATUSES as readonly string[]).includes(statusParam)
    ) {
      return fail(400, "VALIDATION_ERROR", "status must be open or completed.");
    }
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam === null ? undefined : Number(limitParam);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return fail(400, "VALIDATION_ERROR", "limit must be a positive integer.");
    }
    const cursorParam = url.searchParams.get("cursor");
    const cursor =
      cursorParam === null ? null : decodeKeysetCursor(cursorParam);
    if (cursorParam !== null && cursor === null) {
      return fail(400, "VALIDATION_ERROR", "cursor is not valid.");
    }

    const page = await listReturns(tx, tenantId, {
      status: statusParam as ReturnStatus | null,
      limit,
      cursor
    });
    return ok({ items: page.items, nextCursor: page.nextCursor });
  }
});
