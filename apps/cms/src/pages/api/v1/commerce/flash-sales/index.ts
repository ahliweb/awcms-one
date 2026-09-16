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
  createFlashSale,
  DuplicateFlashSaleSlugError,
  listFlashSales
} from "../../../../../modules/commerce/application/flash-sale-directory";
import {
  validateCreateFlashSaleInput,
  type CreateFlashSaleInput
} from "../../../../../modules/commerce/domain/flash-sale-validation";
import { COMMERCE_FLASH_SALES_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_FLASH_SALES_ACTIVITY_CODE,
  action: "read"
} as const;
const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_FLASH_SALES_ACTIVITY_CODE,
  action: "create"
} as const;

/** `GET /api/v1/commerce/flash-sales` — the owner's OWN list, every status, keyset-paginated newest first (Issue #26). */
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
  handler: async ({ tx, tenantId, prepared }) => {
    const page = await listFlashSales(tx, tenantId, prepared.cursor);
    return ok(page);
  }
});

/** `POST /api/v1/commerce/flash-sales` — create a flash sale. `status` defaults to `draft` when omitted. */
export const POST = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<CreateFlashSaleInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateCreateFlashSaleInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Flash sale creation input is invalid.",
        {},
        validation.errors
      );
    }

    return validation.value;
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    try {
      const flashSale = await createFlashSale(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared,
        locals.correlationId
      );
      return created(flashSale);
    } catch (error) {
      if (error instanceof DuplicateFlashSaleSlugError) {
        return fail(409, "FLASH_SALE_SLUG_ALREADY_EXISTS", error.message);
      }
      throw error;
    }
  }
});
