import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  deleteVoucher,
  DuplicateVoucherCodeError,
  fetchVoucherById,
  updateVoucher
} from "../../../../../modules/commerce/application/voucher-directory";
import {
  validateUpdateVoucherInput,
  type UpdateVoucherInput
} from "../../../../../modules/commerce/domain/voucher-validation";
import { COMMERCE_VOUCHERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_VOUCHERS_ACTIVITY_CODE,
  action: "read"
} as const;
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_VOUCHERS_ACTIVITY_CODE,
  action: "update"
} as const;
const DELETE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_VOUCHERS_ACTIVITY_CODE,
  action: "delete"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const voucherId = params.id;
    if (!voucherId)
      return fail(400, "VALIDATION_ERROR", "Voucher id is required.");

    const voucher = await fetchVoucherById(tx, tenantId, voucherId);
    if (!voucher) return fail(404, "RESOURCE_NOT_FOUND", "Voucher not found.");

    return ok(voucher);
  }
});

export const PATCH = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<UpdateVoucherInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateUpdateVoucherInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Voucher update input is invalid.",
        {},
        validation.errors
      );
    }

    return validation.value;
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const voucherId = params.id;
    if (!voucherId)
      return fail(400, "VALIDATION_ERROR", "Voucher id is required.");

    try {
      const voucher = await updateVoucher(
        tx,
        tenantId,
        auth.context.tenantUserId,
        voucherId,
        prepared,
        locals.correlationId
      );
      if (!voucher)
        return fail(404, "RESOURCE_NOT_FOUND", "Voucher not found.");
      return ok(voucher);
    } catch (error) {
      if (error instanceof DuplicateVoucherCodeError) {
        return fail(409, "VOUCHER_CODE_ALREADY_EXISTS", error.message);
      }
      throw error;
    }
  }
});

export const DELETE = defineTenantRoute({
  workClass: "interactive",
  authorize: DELETE_GUARD,
  handler: async ({ tx, tenantId, auth, params, locals }) => {
    const voucherId = params.id;
    if (!voucherId)
      return fail(400, "VALIDATION_ERROR", "Voucher id is required.");

    const deleted = await deleteVoucher(
      tx,
      tenantId,
      auth.context.tenantUserId,
      voucherId,
      locals.correlationId
    );
    if (!deleted) return fail(404, "RESOURCE_NOT_FOUND", "Voucher not found.");

    return ok({ id: voucherId, status: "deleted" });
  }
});
