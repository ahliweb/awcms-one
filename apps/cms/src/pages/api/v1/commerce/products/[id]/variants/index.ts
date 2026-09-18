import {
  created,
  fail
} from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import {
  createProductVariant,
  DuplicateVariantSkuError,
  ProductNotFoundForVariantError
} from "../../../../../../../modules/commerce/application/product-variant-directory";
import {
  validateCreateProductVariantInput,
  type CreateProductVariantInput
} from "../../../../../../../modules/commerce/domain/product-variant-validation";
import { COMMERCE_PRODUCTS_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
  action: "update"
} as const;

/** `POST /api/v1/commerce/products/{id}/variants` (Issue #23) — add a variant. `sku`, when set, is checked against BOTH products and variants (`sql/905`'s header). */
export const POST = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({
    request
  }): Promise<CreateProductVariantInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateCreateProductVariantInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Product variant input is invalid.",
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
      const variant = await createProductVariant(
        tx,
        tenantId,
        auth.context.tenantUserId,
        productId,
        prepared,
        locals.correlationId
      );
      return created(variant);
    } catch (error) {
      if (error instanceof ProductNotFoundForVariantError) {
        return fail(404, "RESOURCE_NOT_FOUND", "Product not found.");
      }
      if (error instanceof DuplicateVariantSkuError) {
        return fail(409, "VARIANT_SKU_ALREADY_EXISTS", error.message);
      }

      throw error;
    }
  }
});
