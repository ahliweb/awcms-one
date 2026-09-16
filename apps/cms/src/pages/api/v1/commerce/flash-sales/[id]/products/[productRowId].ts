import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import {
  deleteFlashSaleProduct,
  updateFlashSaleProduct
} from "../../../../../../../modules/commerce/application/flash-sale-directory";
import {
  validateUpdateFlashSaleProductInput,
  type UpdateFlashSaleProductInput
} from "../../../../../../../modules/commerce/domain/flash-sale-validation";
import { COMMERCE_FLASH_SALES_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";

/** Named `productRowId` (not `productId`) — this is `awcms_commerce_flash_sale_products.id`, the JOIN row's own id, never `awcms_commerce_products.id`. */
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_FLASH_SALES_ACTIVITY_CODE,
  action: "update"
} as const;

export const PATCH = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({
    request
  }): Promise<UpdateFlashSaleProductInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateUpdateFlashSaleProductInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Flash sale product update input is invalid.",
        {},
        validation.errors
      );
    }

    return validation.value;
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const flashSaleId = params.id;
    const productRowId = params.productRowId;
    if (!flashSaleId || !productRowId) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Flash sale id and product row id are required."
      );
    }

    const product = await updateFlashSaleProduct(
      tx,
      tenantId,
      auth.context.tenantUserId,
      flashSaleId,
      productRowId,
      prepared,
      locals.correlationId
    );
    if (!product)
      return fail(404, "RESOURCE_NOT_FOUND", "Flash sale product not found.");

    return ok(product);
  }
});

export const DELETE = defineTenantRoute({
  workClass: "interactive",
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, locals }) => {
    const flashSaleId = params.id;
    const productRowId = params.productRowId;
    if (!flashSaleId || !productRowId) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Flash sale id and product row id are required."
      );
    }

    const deleted = await deleteFlashSaleProduct(
      tx,
      tenantId,
      auth.context.tenantUserId,
      flashSaleId,
      productRowId,
      locals.correlationId
    );
    if (!deleted)
      return fail(404, "RESOURCE_NOT_FOUND", "Flash sale product not found.");

    return ok({ id: productRowId, status: "deleted" });
  }
});
