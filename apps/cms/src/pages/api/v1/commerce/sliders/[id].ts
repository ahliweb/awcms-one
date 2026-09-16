import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import { mediaLibraryPortAdapter } from "../../../../../modules/media-library/application/media-library-port-adapter";
import {
  deleteSlider,
  fetchSliderById,
  SliderMediaReferenceInvalidError,
  updateSlider
} from "../../../../../modules/commerce/application/slider-directory";
import {
  validateUpdateSliderInput,
  type UpdateSliderInput
} from "../../../../../modules/commerce/domain/slider-validation";
import { COMMERCE_SLIDERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SLIDERS_ACTIVITY_CODE,
  action: "read"
} as const;
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SLIDERS_ACTIVITY_CODE,
  action: "update"
} as const;
const DELETE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SLIDERS_ACTIVITY_CODE,
  action: "delete"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const sliderId = params.id;
    if (!sliderId)
      return fail(400, "VALIDATION_ERROR", "Slider id is required.");

    const slider = await fetchSliderById(tx, tenantId, sliderId);
    if (!slider) return fail(404, "RESOURCE_NOT_FOUND", "Slider not found.");

    return ok(slider);
  }
});

export const PATCH = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<UpdateSliderInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateUpdateSliderInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Slider update input is invalid.",
        {},
        validation.errors
      );
    }

    return validation.value;
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const sliderId = params.id;
    if (!sliderId)
      return fail(400, "VALIDATION_ERROR", "Slider id is required.");

    try {
      const slider = await updateSlider(
        tx,
        tenantId,
        auth.context.tenantUserId,
        sliderId,
        prepared,
        mediaLibraryPortAdapter,
        locals.correlationId
      );
      if (!slider) return fail(404, "RESOURCE_NOT_FOUND", "Slider not found.");
      return ok(slider);
    } catch (error) {
      if (error instanceof SliderMediaReferenceInvalidError) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "Slider update input is invalid.",
          {},
          [{ field: "mediaObjectId", message: error.message }]
        );
      }
      throw error;
    }
  }
});

export const DELETE = defineTenantRoute({
  workClass: "interactive",
  authorize: DELETE_GUARD,
  handler: async ({ tx, tenantId, auth, params, locals }) => {
    const sliderId = params.id;
    if (!sliderId)
      return fail(400, "VALIDATION_ERROR", "Slider id is required.");

    const deleted = await deleteSlider(
      tx,
      tenantId,
      auth.context.tenantUserId,
      sliderId,
      locals.correlationId
    );
    if (!deleted) return fail(404, "RESOURCE_NOT_FOUND", "Slider not found.");

    return ok({ id: sliderId, status: "deleted" });
  }
});
