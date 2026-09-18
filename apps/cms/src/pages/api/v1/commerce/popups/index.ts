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
  createPopup,
  listPopups,
  PopupAlreadyActiveError
} from "../../../../../modules/commerce/application/popup-directory";
import {
  validateCreatePopupInput,
  type CreatePopupInput
} from "../../../../../modules/commerce/domain/popup-validation";
import { COMMERCE_POPUPS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_POPUPS_ACTIVITY_CODE,
  action: "read"
} as const;
const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_POPUPS_ACTIVITY_CODE,
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
    ok(await listPopups(tx, tenantId, prepared.cursor))
});

/** `isActive: true` on create fails `409 POPUP_ALREADY_ACTIVE` when another live popup already is — `sql/909`'s partial unique index. */
export const POST = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<CreatePopupInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateCreatePopupInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Popup creation input is invalid.",
        {},
        validation.errors
      );
    }

    return validation.value;
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    try {
      const popup = await createPopup(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared,
        locals.correlationId
      );
      return created(popup);
    } catch (error) {
      if (error instanceof PopupAlreadyActiveError) {
        return fail(409, "POPUP_ALREADY_ACTIVE", error.message);
      }
      throw error;
    }
  }
});
