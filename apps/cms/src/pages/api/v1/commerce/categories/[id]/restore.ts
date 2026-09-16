import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  DuplicateCategorySlugError,
  restoreCategory
} from "../../../../../../modules/commerce/application/category-directory";
import { COMMERCE_CATEGORIES_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const RESTORE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CATEGORIES_ACTIVITY_CODE,
  action: "restore"
} as const;

/**
 * `POST /api/v1/commerce/categories/{id}/restore` (Issue #23) — same shape
 * as `products/[id]/restore.ts`: 404 when the id is not currently
 * soft-deleted, 409 when a live category has since taken the same slug.
 */
export const POST = defineTenantRoute({
  workClass: "interactive",
  authorize: RESTORE_GUARD,
  handler: async ({ tx, tenantId, auth, params, locals }) => {
    const categoryId = params.id;
    if (!categoryId) {
      return fail(400, "VALIDATION_ERROR", "Category id is required.");
    }

    try {
      const category = await restoreCategory(
        tx,
        tenantId,
        auth.context.tenantUserId,
        categoryId,
        locals.correlationId
      );

      if (!category) {
        return fail(
          404,
          "RESOURCE_NOT_FOUND",
          "Category not found or not currently soft-deleted."
        );
      }

      return ok(category);
    } catch (error) {
      if (error instanceof DuplicateCategorySlugError) {
        return fail(409, "CATEGORY_SLUG_ALREADY_EXISTS", error.message);
      }

      throw error;
    }
  }
});
