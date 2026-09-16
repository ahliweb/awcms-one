import {
  created,
  fail
} from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import { mediaLibraryPortAdapter } from "../../../../../../../modules/media-library/application/media-library-port-adapter";
import {
  createProductImage,
  ProductImageMediaReferenceInvalidError,
  ProductNotFoundForImageError
} from "../../../../../../../modules/commerce/application/product-image-directory";
import {
  validateCreateProductImageInput,
  type CreateProductImageInput
} from "../../../../../../../modules/commerce/domain/product-image-validation";
import { COMMERCE_PRODUCTS_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";

/** Images/variants are edited as part of editing a PRODUCT — gated on `products.update`, not a resource of their own (`commerce-permissions.ts`'s header). */
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
  action: "update"
} as const;

/**
 * `POST /api/v1/commerce/products/{id}/images` (Issue #23) — attach a media
 * object to a product. `mediaObjectId` must be a live, verified, same-tenant
 * media object (`mediaLibraryPortAdapter`, the composition-root pattern
 * `blog_content`'s write routes already use); the response is the raw
 * reference (no resolved `publicUrl`) — `GET .../products/{id}` is where a
 * caller reads the resolved image list.
 */
export const POST = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<CreateProductImageInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateCreateProductImageInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Product image input is invalid.",
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
      const image = await createProductImage(
        tx,
        tenantId,
        auth.context.tenantUserId,
        productId,
        prepared,
        mediaLibraryPortAdapter,
        locals.correlationId
      );
      return created(image);
    } catch (error) {
      if (error instanceof ProductNotFoundForImageError) {
        return fail(404, "RESOURCE_NOT_FOUND", "Product not found.");
      }
      if (error instanceof ProductImageMediaReferenceInvalidError) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "Product image input is invalid.",
          {},
          [{ field: "mediaObjectId", message: error.message }]
        );
      }

      throw error;
    }
  }
});
