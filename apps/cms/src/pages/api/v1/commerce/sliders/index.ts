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
import { mediaLibraryPortAdapter } from "../../../../../modules/media-library/application/media-library-port-adapter";
import {
  createSlider,
  listSliders,
  SliderMediaReferenceInvalidError
} from "../../../../../modules/commerce/application/slider-directory";
import {
  validateCreateSliderInput,
  type CreateSliderInput
} from "../../../../../modules/commerce/domain/slider-validation";
import { COMMERCE_SLIDERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SLIDERS_ACTIVITY_CODE,
  action: "read"
} as const;
const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SLIDERS_ACTIVITY_CODE,
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
    ok(await listSliders(tx, tenantId, prepared.cursor))
});

export const POST = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<CreateSliderInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateCreateSliderInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Slider creation input is invalid.",
        {},
        validation.errors
      );
    }

    return validation.value;
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    try {
      const slider = await createSlider(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared,
        mediaLibraryPortAdapter,
        locals.correlationId
      );
      return created(slider);
    } catch (error) {
      if (error instanceof SliderMediaReferenceInvalidError) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "Slider creation input is invalid.",
          {},
          [{ field: "mediaObjectId", message: error.message }]
        );
      }
      throw error;
    }
  }
});
