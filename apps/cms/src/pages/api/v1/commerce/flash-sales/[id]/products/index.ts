import {
  created,
  fail,
  ok
} from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import {
  createFlashSaleProduct,
  DuplicateFlashSaleProductError,
  FlashSaleProductReferenceInvalidError,
  listFlashSaleProducts
} from "../../../../../../../modules/commerce/application/flash-sale-directory";
import {
  validateCreateFlashSaleProductInput,
  type CreateFlashSaleProductInput
} from "../../../../../../../modules/commerce/domain/flash-sale-validation";
import { COMMERCE_FLASH_SALES_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_FLASH_SALES_ACTIVITY_CODE,
  action: "read"
} as const;
/** Sub-resource of editing the flash sale, gated on `update` — same "one verb, one PATCH" reasoning `commerce-permissions.ts`'s header gives for `products.update` gating image/variant CRUD. */
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_FLASH_SALES_ACTIVITY_CODE,
  action: "update"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const flashSaleId = params.id;
    if (!flashSaleId)
      return fail(400, "VALIDATION_ERROR", "Flash sale id is required.");

    return ok({
      items: await listFlashSaleProducts(tx, tenantId, flashSaleId)
    });
  }
});

export const POST = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({
    request
  }): Promise<CreateFlashSaleProductInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateCreateFlashSaleProductInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Flash sale product input is invalid.",
        {},
        validation.errors
      );
    }

    return validation.value;
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const flashSaleId = params.id;
    if (!flashSaleId)
      return fail(400, "VALIDATION_ERROR", "Flash sale id is required.");

    try {
      const product = await createFlashSaleProduct(
        tx,
        tenantId,
        auth.context.tenantUserId,
        flashSaleId,
        prepared,
        locals.correlationId
      );
      if (!product)
        return fail(404, "RESOURCE_NOT_FOUND", "Flash sale not found.");
      return created(product);
    } catch (error) {
      if (error instanceof FlashSaleProductReferenceInvalidError) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "Flash sale product input is invalid.",
          {},
          [{ field: "productId", message: error.message }]
        );
      }
      if (error instanceof DuplicateFlashSaleProductError) {
        return fail(409, "FLASH_SALE_PRODUCT_ALREADY_EXISTS", error.message);
      }
      throw error;
    }
  }
});
