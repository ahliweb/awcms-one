import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../modules/_shared/keyset-pagination";
import { listEntitlementsForAdmin } from "../../../../../modules/commerce/application/commerce-entitlement-directory";
import { COMMERCE_ENTITLEMENTS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import { isCommerceEntitlementStatus } from "../../../../../modules/commerce/domain/commerce-entitlement";

/**
 * `GET /api/v1/commerce/entitlements` (Issue #267, IRMbyDUS) — admin list,
 * optional `ownerCustomerId`/`productId`/`status` filters. The lookup an
 * admin uses to find the id `POST .../entitlements/{id}/revoke` needs.
 */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_ENTITLEMENTS_ACTIVITY_CODE,
  action: "read"
} as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PreparedList = {
  cursor: KeysetCursor | null;
  ownerCustomerId?: string;
  productId?: string;
  status?: string;
};

export const GET = defineTenantRoute({
  workClass: "interactive",
  prepare: ({ url }): PreparedList | Response => {
    const cursorParam = url.searchParams.get("cursor");
    let cursor: KeysetCursor | null = null;
    if (cursorParam) {
      const decoded = decodeKeysetCursor(cursorParam);
      if (!decoded)
        return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
      cursor = decoded;
    }

    const statusParam = url.searchParams.get("status") ?? undefined;
    if (statusParam && !isCommerceEntitlementStatus(statusParam)) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "status must be one of: active, revoked."
      );
    }

    const ownerCustomerIdParam =
      url.searchParams.get("ownerCustomerId") ?? undefined;
    if (ownerCustomerIdParam && !UUID_PATTERN.test(ownerCustomerIdParam)) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "ownerCustomerId must be a valid uuid."
      );
    }

    const productIdParam = url.searchParams.get("productId") ?? undefined;
    if (productIdParam && !UUID_PATTERN.test(productIdParam)) {
      return fail(400, "VALIDATION_ERROR", "productId must be a valid uuid.");
    }

    return {
      cursor,
      ownerCustomerId: ownerCustomerIdParam,
      productId: productIdParam,
      status: statusParam
    };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) =>
    ok(
      await listEntitlementsForAdmin(
        tx,
        tenantId,
        {
          ownerCustomerId: prepared.ownerCustomerId,
          productId: prepared.productId,
          status: prepared.status
        },
        prepared.cursor
      )
    )
});
