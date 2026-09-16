import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  DuplicateProductSkuError,
  DuplicateProductSlugError,
  restoreProduct
} from "../../../../../../modules/commerce/application/product-directory";
import { COMMERCE_PRODUCTS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

/**
 * `restore` is its OWN permission (Issue #23), unlike
 * `offices/[id]/restore.ts`'s reuse of `.update` — see
 * `commerce-permissions.ts`'s header for why this module chose a distinct
 * key.
 */
const RESTORE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
  action: "restore"
} as const;

/**
 * `POST /api/v1/commerce/products/{id}/restore` (Issue #23) —
 * `offices/[id]/restore.ts`'s shape: 404 when the id is not currently
 * soft-deleted (idempotent-safe — a repeat restore is a 404, never a
 * duplicate), 409 when a live product has since taken the same slug or sku.
 */
export const POST = defineTenantRoute({
  workClass: "interactive",
  authorize: RESTORE_GUARD,
  handler: async ({ tx, tenantId, auth, params, locals }) => {
    const productId = params.id;
    if (!productId) {
      return fail(400, "VALIDATION_ERROR", "Product id is required.");
    }

    try {
      const product = await restoreProduct(
        tx,
        tenantId,
        auth.context.tenantUserId,
        productId,
        locals.correlationId
      );

      if (!product) {
        return fail(
          404,
          "RESOURCE_NOT_FOUND",
          "Product not found or not currently soft-deleted."
        );
      }

      return ok(product);
    } catch (error) {
      if (error instanceof DuplicateProductSlugError) {
        return fail(409, "PRODUCT_SLUG_ALREADY_EXISTS", error.message);
      }
      if (error instanceof DuplicateProductSkuError) {
        return fail(409, "PRODUCT_SKU_ALREADY_EXISTS", error.message);
      }

      throw error;
    }
  }
});
