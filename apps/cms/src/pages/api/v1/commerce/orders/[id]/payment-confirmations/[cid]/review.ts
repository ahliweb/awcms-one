import { fail, ok } from "../../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../../lib/security/request-body-limit";
import { reviewPaymentConfirmation } from "../../../../../../../../modules/commerce/application/order-directory";
import { COMMERCE_ORDERS_ACTIVITY_CODE } from "../../../../../../../../modules/commerce/domain/commerce-permissions";

/** `PATCH /api/v1/commerce/orders/{id}/payment-confirmations/{cid}/review` — admin accept/reject (Issue #29). */
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_ORDERS_ACTIVITY_CODE,
  action: "update"
} as const;

type PreparedReview = { decision: "accepted" | "rejected" };

export const PATCH = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<PreparedReview | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const record =
      bodyRead.value && typeof bodyRead.value === "object"
        ? (bodyRead.value as Record<string, unknown>)
        : {};

    if (record.decision !== "accepted" && record.decision !== "rejected") {
      return fail(
        400,
        "VALIDATION_ERROR",
        'decision must be "accepted" or "rejected".'
      );
    }
    return { decision: record.decision };
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared }) => {
    const orderId = params.id;
    const confirmationId = params.cid;
    if (!orderId || !confirmationId) {
      return fail(400, "VALIDATION_ERROR", "id and cid are required.");
    }

    const updated = await reviewPaymentConfirmation(
      tx,
      tenantId,
      auth.context.tenantUserId,
      orderId,
      confirmationId,
      prepared.decision
    );

    if (!updated)
      return fail(404, "RESOURCE_NOT_FOUND", "Payment confirmation not found.");
    return ok({ decision: prepared.decision });
  }
});
