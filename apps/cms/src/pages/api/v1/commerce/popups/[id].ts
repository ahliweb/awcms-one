import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  deletePopup,
  fetchPopupById,
  PopupAlreadyActiveError,
  updatePopup
} from "../../../../../modules/commerce/application/popup-directory";
import {
  validateUpdatePopupInput,
  type UpdatePopupInput
} from "../../../../../modules/commerce/domain/popup-validation";
import { COMMERCE_POPUPS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_POPUPS_ACTIVITY_CODE,
  action: "read"
} as const;
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_POPUPS_ACTIVITY_CODE,
  action: "update"
} as const;
const DELETE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_POPUPS_ACTIVITY_CODE,
  action: "delete"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const popupId = params.id;
    if (!popupId) return fail(400, "VALIDATION_ERROR", "Popup id is required.");

    const popup = await fetchPopupById(tx, tenantId, popupId);
    if (!popup) return fail(404, "RESOURCE_NOT_FOUND", "Popup not found.");

    return ok(popup);
  }
});

export const PATCH = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<UpdatePopupInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateUpdatePopupInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Popup update input is invalid.",
        {},
        validation.errors
      );
    }

    return validation.value;
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const popupId = params.id;
    if (!popupId) return fail(400, "VALIDATION_ERROR", "Popup id is required.");

    try {
      const popup = await updatePopup(
        tx,
        tenantId,
        auth.context.tenantUserId,
        popupId,
        prepared,
        locals.correlationId
      );
      if (!popup) return fail(404, "RESOURCE_NOT_FOUND", "Popup not found.");
      return ok(popup);
    } catch (error) {
      if (error instanceof PopupAlreadyActiveError) {
        return fail(409, "POPUP_ALREADY_ACTIVE", error.message);
      }
      throw error;
    }
  }
});

export const DELETE = defineTenantRoute({
  workClass: "interactive",
  authorize: DELETE_GUARD,
  handler: async ({ tx, tenantId, auth, params, locals }) => {
    const popupId = params.id;
    if (!popupId) return fail(400, "VALIDATION_ERROR", "Popup id is required.");

    const deleted = await deletePopup(
      tx,
      tenantId,
      auth.context.tenantUserId,
      popupId,
      locals.correlationId
    );
    if (!deleted) return fail(404, "RESOURCE_NOT_FOUND", "Popup not found.");

    return ok({ id: popupId, status: "deleted" });
  }
});
