import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  deleteProduct,
  DuplicateProductSkuError,
  DuplicateProductSlugError,
  fetchProductById,
  IllegalProductStatusTransitionError,
  ProductCategoryNotFoundError,
  updateProduct
} from "../../../../../modules/commerce/application/product-directory";
import {
  validateUpdateProductInput,
  type UpdateProductInput
} from "../../../../../modules/commerce/domain/product-validation";
import { COMMERCE_PRODUCTS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
  action: "read"
} as const;
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
  action: "update"
} as const;
const DELETE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
  action: "delete"
} as const;

/** `GET /api/v1/commerce/products/{id}` — fetch one product. */
export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const productId = params.id;
    if (!productId) {
      return fail(400, "VALIDATION_ERROR", "Product id is required.");
    }

    const product = await fetchProductById(tx, tenantId, productId);
    if (!product) {
      return fail(404, "RESOURCE_NOT_FOUND", "Product not found.");
    }

    return ok(product);
  }
});

/**
 * `PATCH /api/v1/commerce/products/{id}` — update, including a status
 * transition. There is no dedicated status endpoint: `status` travels through
 * this same request, checked against `product-status.ts`'s `LEGAL_TRANSITIONS`
 * by `updateProduct` before any write.
 */
export const PATCH = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<UpdateProductInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateUpdateProductInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Product update input is invalid.",
        {},
        validation.errors
      );
    }

    return validation.value;
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const productId = params.id;
    if (!productId) {
      return fail(400, "VALIDATION_ERROR", "Product id is required.");
    }

    try {
      const product = await updateProduct(
        tx,
        tenantId,
        auth.context.tenantUserId,
        productId,
        prepared,
        locals.correlationId
      );
      if (!product) {
        return fail(404, "RESOURCE_NOT_FOUND", "Product not found.");
      }

      return ok(product);
    } catch (error) {
      // Every one of these is raised either before the UPDATE runs
      // (`ProductCategoryNotFoundError`, `IllegalProductStatusTransitionError`)
      // or after a unique violation already aborted the transaction (the two
      // duplicate errors) — so nothing further may be written in any branch.
      if (error instanceof ProductCategoryNotFoundError) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "Product update input is invalid.",
          {},
          [{ field: "categoryId", message: error.message }]
        );
      }

      if (error instanceof IllegalProductStatusTransitionError) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "Product update input is invalid.",
          {},
          error.errors
        );
      }

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

/**
 * `DELETE /api/v1/commerce/products/{id}` — soft delete (audited). Not a hard
 * delete, and this slice ships no restore endpoint — see the module README's
 * "No restore endpoint" section.
 */
export const DELETE = defineTenantRoute({
  workClass: "interactive",
  authorize: DELETE_GUARD,
  handler: async ({ tx, tenantId, auth, params, locals }) => {
    const productId = params.id;
    if (!productId) {
      return fail(400, "VALIDATION_ERROR", "Product id is required.");
    }

    const deleted = await deleteProduct(
      tx,
      tenantId,
      auth.context.tenantUserId,
      productId,
      locals.correlationId
    );
    if (!deleted) {
      return fail(404, "RESOURCE_NOT_FOUND", "Product not found.");
    }

    return ok({ id: productId, status: "deleted" });
  }
});
