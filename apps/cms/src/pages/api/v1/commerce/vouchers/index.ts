import { created, fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../modules/_shared/keyset-pagination";
import {
  createVoucher,
  DuplicateVoucherCodeError,
  listVouchers
} from "../../../../../modules/commerce/application/voucher-directory";
import {
  validateCreateVoucherInput,
  type CreateVoucherInput
} from "../../../../../modules/commerce/domain/voucher-validation";
import { COMMERCE_VOUCHERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_VOUCHERS_ACTIVITY_CODE,
  action: "read"
} as const;
const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_VOUCHERS_ACTIVITY_CODE,
  action: "create"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  prepare: ({ url }): { cursor: KeysetCursor | null } | Response => {
    const cursorParam = url.searchParams.get("cursor");
    if (!cursorParam) return { cursor: null };

    const decoded = decodeKeysetCursor(cursorParam);
    if (!decoded) return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
    return { cursor: decoded };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) =>
    ok(await listVouchers(tx, tenantId, prepared.cursor))
});

export const POST = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<CreateVoucherInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateCreateVoucherInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Voucher creation input is invalid.",
        {},
        validation.errors
      );
    }

    return validation.value;
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    try {
      const voucher = await createVoucher(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared,
        locals.correlationId
      );
      return created(voucher);
    } catch (error) {
      if (error instanceof DuplicateVoucherCodeError) {
        return fail(409, "VOUCHER_CODE_ALREADY_EXISTS", error.message);
      }
      throw error;
    }
  }
});
