import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import {
  deleteProductVariant,
  DuplicateVariantSkuError,
  updateProductVariant
} from "../../../../../../../modules/commerce/application/product-variant-directory";
import {
  validateUpdateProductVariantInput,
  type UpdateProductVariantInput
} from "../../../../../../../modules/commerce/domain/product-variant-validation";
import { COMMERCE_PRODUCTS_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
  action: "update"
} as const;

/** `PATCH /api/v1/commerce/products/{id}/variants/{variantId}` (Issue #23). */
export const PATCH = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({
    request
  }): Promise<UpdateProductVariantInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateUpdateProductVariantInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Product variant update input is invalid.",
        {},
        validation.errors
      );
    }

    return validation.value;
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const productId = params.id;
    const variantId = params.variantId;
    if (!productId || !variantId) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Product id and variant id are required."
      );
    }

    try {
      const variant = await updateProductVariant(
        tx,
        tenantId,
        auth.context.tenantUserId,
        productId,
        variantId,
        prepared,
        locals.correlationId
      );
      if (!variant) {
        return fail(404, "RESOURCE_NOT_FOUND", "Product variant not found.");
      }

      return ok(variant);
    } catch (error) {
      if (error instanceof DuplicateVariantSkuError) {
        return fail(409, "VARIANT_SKU_ALREADY_EXISTS", error.message);
      }

      throw error;
    }
  }
});

/** `DELETE /api/v1/commerce/products/{id}/variants/{variantId}` (Issue #23) — soft delete (audited). */
export const DELETE = defineTenantRoute({
  workClass: "interactive",
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, locals }) => {
    const productId = params.id;
    const variantId = params.variantId;
    if (!productId || !variantId) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Product id and variant id are required."
      );
    }

    const deleted = await deleteProductVariant(
      tx,
      tenantId,
      auth.context.tenantUserId,
      productId,
      variantId,
      locals.correlationId
    );
    if (!deleted) {
      return fail(404, "RESOURCE_NOT_FOUND", "Product variant not found.");
    }

    return ok({ id: variantId, status: "deleted" });
  }
});
