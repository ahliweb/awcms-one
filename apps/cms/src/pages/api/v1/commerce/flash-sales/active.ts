import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { mediaLibraryPortAdapter } from "../../../../../modules/media-library/application/media-library-port-adapter";
import { listActiveFlashSalesPublic } from "../../../../../modules/commerce/application/flash-sale-directory";
import { COMMERCE_FLASH_SALES_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_FLASH_SALES_ACTIVITY_CODE,
  action: "read"
} as const;

/**
 * `GET /api/v1/commerce/flash-sales/active` — the storefront's read model
 * (contract: `commerce-public-read-models.md`). Same Bearer-token,
 * `read`-permission authentication every other commerce route uses — there
 * is no anonymous tier in this API (confirmed against
 * `products/by-slug/[slug].ts`'s identical shape); "public" describes the
 * FIELD SHAPE returned, not the authentication requirement.
 */
export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, now }) => {
    return ok(
      await listActiveFlashSalesPublic(
        tx,
        tenantId,
        mediaLibraryPortAdapter,
        now
      )
    );
  }
});
