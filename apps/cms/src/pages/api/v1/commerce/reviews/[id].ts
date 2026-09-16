import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  deleteReview,
  moderateReview
} from "../../../../../modules/commerce/application/review-directory";
import { COMMERCE_REVIEWS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REVIEWS_ACTIVITY_CODE,
  action: "update"
} as const;
const DELETE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REVIEWS_ACTIVITY_CODE,
  action: "delete"
} as const;

/** `PATCH /api/v1/commerce/reviews/{id}` — moderate: publish or reject a pending review (Issue #29). */
export const PATCH = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({
    request
  }): Promise<{ status: "published" | "rejected" } | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const record =
      bodyRead.value && typeof bodyRead.value === "object"
        ? (bodyRead.value as Record<string, unknown>)
        : {};

    if (record.status !== "published" && record.status !== "rejected") {
      return fail(
        400,
        "VALIDATION_ERROR",
        'status must be "published" or "rejected".'
      );
    }
    return { status: record.status };
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared }) => {
    const reviewId = params.id;
    if (!reviewId) return fail(400, "VALIDATION_ERROR", "id is required.");

    const updated = await moderateReview(
      tx,
      tenantId,
      auth.context.tenantUserId,
      reviewId,
      prepared.status
    );
    if (!updated)
      return fail(404, "RESOURCE_NOT_FOUND", "Pending review not found.");
    return ok(updated);
  }
});

/** `DELETE /api/v1/commerce/reviews/{id}` — soft delete (Issue #29). */
export const DELETE = defineTenantRoute({
  workClass: "interactive",
  authorize: DELETE_GUARD,
  handler: async ({ tx, tenantId, auth, params }) => {
    const reviewId = params.id;
    if (!reviewId) return fail(400, "VALIDATION_ERROR", "id is required.");

    const deleted = await deleteReview(
      tx,
      tenantId,
      auth.context.tenantUserId,
      reviewId
    );
    if (!deleted) return fail(404, "RESOURCE_NOT_FOUND", "Review not found.");
    return ok({ deleted: true });
  }
});
