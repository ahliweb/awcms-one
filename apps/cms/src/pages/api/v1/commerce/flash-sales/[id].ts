import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  deleteFlashSale,
  DuplicateFlashSaleSlugError,
  fetchFlashSaleById,
  updateFlashSale
} from "../../../../../modules/commerce/application/flash-sale-directory";
import {
  validateUpdateFlashSaleInput,
  type UpdateFlashSaleInput
} from "../../../../../modules/commerce/domain/flash-sale-validation";
import { COMMERCE_FLASH_SALES_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_FLASH_SALES_ACTIVITY_CODE,
  action: "read"
} as const;
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_FLASH_SALES_ACTIVITY_CODE,
  action: "update"
} as const;
const DELETE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_FLASH_SALES_ACTIVITY_CODE,
  action: "delete"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const flashSaleId = params.id;
    if (!flashSaleId)
      return fail(400, "VALIDATION_ERROR", "Flash sale id is required.");

    const flashSale = await fetchFlashSaleById(tx, tenantId, flashSaleId);
    if (!flashSale)
      return fail(404, "RESOURCE_NOT_FOUND", "Flash sale not found.");

    return ok(flashSale);
  }
});

/** `status` here only ever accepts `draft`/`scheduled` — see `domain/flash-sale-status.ts`'s header for why `active`/`ended` are computed, never a caller's choice. */
export const PATCH = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<UpdateFlashSaleInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateUpdateFlashSaleInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Flash sale update input is invalid.",
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
      const flashSale = await updateFlashSale(
        tx,
        tenantId,
        auth.context.tenantUserId,
        flashSaleId,
        prepared,
        locals.correlationId
      );
      if (!flashSale)
        return fail(404, "RESOURCE_NOT_FOUND", "Flash sale not found.");
      return ok(flashSale);
    } catch (error) {
      if (error instanceof DuplicateFlashSaleSlugError) {
        return fail(409, "FLASH_SALE_SLUG_ALREADY_EXISTS", error.message);
      }
      throw error;
    }
  }
});

export const DELETE = defineTenantRoute({
  workClass: "interactive",
  authorize: DELETE_GUARD,
  handler: async ({ tx, tenantId, auth, params, locals }) => {
    const flashSaleId = params.id;
    if (!flashSaleId)
      return fail(400, "VALIDATION_ERROR", "Flash sale id is required.");

    const deleted = await deleteFlashSale(
      tx,
      tenantId,
      auth.context.tenantUserId,
      flashSaleId,
      locals.correlationId
    );
    if (!deleted)
      return fail(404, "RESOURCE_NOT_FOUND", "Flash sale not found.");

    return ok({ id: flashSaleId, status: "deleted" });
  }
});
