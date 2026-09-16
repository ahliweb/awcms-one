import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import {
  deleteProductImage,
  updateProductImage
} from "../../../../../../../modules/commerce/application/product-image-directory";
import {
  validateUpdateProductImageInput,
  type UpdateProductImageInput
} from "../../../../../../../modules/commerce/domain/product-image-validation";
import { COMMERCE_PRODUCTS_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
  action: "update"
} as const;

/** `PATCH /api/v1/commerce/products/{id}/images/{imageId}` (Issue #23) — edit `altText`/`sortOrder`. `mediaObjectId` is immutable once attached; remove and re-add to point at a different object. */
export const PATCH = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<UpdateProductImageInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateUpdateProductImageInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Product image update input is invalid.",
        {},
        validation.errors
      );
    }

    return validation.value;
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const productId = params.id;
    const imageId = params.imageId;
    if (!productId || !imageId) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Product id and image id are required."
      );
    }

    const image = await updateProductImage(
      tx,
      tenantId,
      auth.context.tenantUserId,
      productId,
      imageId,
      prepared,
      locals.correlationId
    );
    if (!image) {
      return fail(404, "RESOURCE_NOT_FOUND", "Product image not found.");
    }

    return ok(image);
  }
});

/** `DELETE /api/v1/commerce/products/{id}/images/{imageId}` (Issue #23) — soft delete (audited). */
export const DELETE = defineTenantRoute({
  workClass: "interactive",
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, locals }) => {
    const productId = params.id;
    const imageId = params.imageId;
    if (!productId || !imageId) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Product id and image id are required."
      );
    }

    const deleted = await deleteProductImage(
      tx,
      tenantId,
      auth.context.tenantUserId,
      productId,
      imageId,
      locals.correlationId
    );
    if (!deleted) {
      return fail(404, "RESOURCE_NOT_FOUND", "Product image not found.");
    }

    return ok({ id: imageId, status: "deleted" });
  }
});
