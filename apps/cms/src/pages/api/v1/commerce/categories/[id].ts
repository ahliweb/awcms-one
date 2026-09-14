import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  deleteCategory,
  DuplicateCategorySlugError,
  fetchCategoryById,
  updateCategory
} from "../../../../../modules/commerce/application/category-directory";
import {
  validateUpdateCategoryInput,
  type UpdateCategoryInput
} from "../../../../../modules/commerce/domain/category-validation";
import { COMMERCE_CATEGORIES_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CATEGORIES_ACTIVITY_CODE,
  action: "read"
} as const;
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CATEGORIES_ACTIVITY_CODE,
  action: "update"
} as const;
const DELETE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CATEGORIES_ACTIVITY_CODE,
  action: "delete"
} as const;

/** `GET /api/v1/commerce/categories/{id}` — fetch one category. */
export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const categoryId = params.id;
    if (!categoryId) {
      return fail(400, "VALIDATION_ERROR", "Category id is required.");
    }

    const category = await fetchCategoryById(tx, tenantId, categoryId);
    if (!category) {
      return fail(404, "RESOURCE_NOT_FOUND", "Category not found.");
    }

    return ok(category);
  }
});

/** `PATCH /api/v1/commerce/categories/{id}` — update name/slug/icon. No `parentId` — see `category-validation.ts`. */
export const PATCH = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<UpdateCategoryInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateUpdateCategoryInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Category update input is invalid.",
        {},
        validation.errors
      );
    }

    return validation.value;
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const categoryId = params.id;
    if (!categoryId) {
      return fail(400, "VALIDATION_ERROR", "Category id is required.");
    }

    try {
      const category = await updateCategory(
        tx,
        tenantId,
        auth.context.tenantUserId,
        categoryId,
        prepared,
        locals.correlationId
      );
      if (!category) {
        return fail(404, "RESOURCE_NOT_FOUND", "Category not found.");
      }

      return ok(category);
    } catch (error) {
      // `DuplicateCategorySlugError` follows a unique violation that already
      // aborted the transaction, so the commit degrades to a rollback and
      // nothing further is written (same rule as `POST /categories`).
      if (error instanceof DuplicateCategorySlugError) {
        return fail(409, "CATEGORY_SLUG_ALREADY_EXISTS", error.message);
      }

      throw error;
    }
  }
});

/**
 * `DELETE /api/v1/commerce/categories/{id}` — soft delete (audited). Not a
 * hard delete, and this slice ships no restore endpoint — see the module
 * README's "No restore endpoint" section.
 */
export const DELETE = defineTenantRoute({
  workClass: "interactive",
  authorize: DELETE_GUARD,
  handler: async ({ tx, tenantId, auth, params, locals }) => {
    const categoryId = params.id;
    if (!categoryId) {
      return fail(400, "VALIDATION_ERROR", "Category id is required.");
    }

    const deleted = await deleteCategory(
      tx,
      tenantId,
      auth.context.tenantUserId,
      categoryId,
      locals.correlationId
    );
    if (!deleted) {
      return fail(404, "RESOURCE_NOT_FOUND", "Category not found.");
    }

    return ok({ id: categoryId, status: "deleted" });
  }
});
