import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  deleteTestimonial,
  fetchTestimonialById,
  updateTestimonial
} from "../../../../../modules/commerce/application/testimonial-directory";
import {
  validateUpdateTestimonialInput,
  type UpdateTestimonialInput
} from "../../../../../modules/commerce/domain/testimonial-validation";
import { COMMERCE_TESTIMONIALS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_TESTIMONIALS_ACTIVITY_CODE,
  action: "read"
} as const;
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_TESTIMONIALS_ACTIVITY_CODE,
  action: "update"
} as const;
const DELETE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_TESTIMONIALS_ACTIVITY_CODE,
  action: "delete"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const testimonialId = params.id;
    if (!testimonialId)
      return fail(400, "VALIDATION_ERROR", "Testimonial id is required.");

    const testimonial = await fetchTestimonialById(tx, tenantId, testimonialId);
    if (!testimonial)
      return fail(404, "RESOURCE_NOT_FOUND", "Testimonial not found.");

    return ok(testimonial);
  }
});

export const PATCH = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<UpdateTestimonialInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateUpdateTestimonialInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Testimonial update input is invalid.",
        {},
        validation.errors
      );
    }

    return validation.value;
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const testimonialId = params.id;
    if (!testimonialId)
      return fail(400, "VALIDATION_ERROR", "Testimonial id is required.");

    const testimonial = await updateTestimonial(
      tx,
      tenantId,
      auth.context.tenantUserId,
      testimonialId,
      prepared,
      locals.correlationId
    );
    if (!testimonial)
      return fail(404, "RESOURCE_NOT_FOUND", "Testimonial not found.");

    return ok(testimonial);
  }
});

export const DELETE = defineTenantRoute({
  workClass: "interactive",
  authorize: DELETE_GUARD,
  handler: async ({ tx, tenantId, auth, params, locals }) => {
    const testimonialId = params.id;
    if (!testimonialId)
      return fail(400, "VALIDATION_ERROR", "Testimonial id is required.");

    const deleted = await deleteTestimonial(
      tx,
      tenantId,
      auth.context.tenantUserId,
      testimonialId,
      locals.correlationId
    );
    if (!deleted)
      return fail(404, "RESOURCE_NOT_FOUND", "Testimonial not found.");

    return ok({ id: testimonialId, status: "deleted" });
  }
});
