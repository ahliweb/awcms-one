import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import {
  IllegalOrderStatusTransitionError,
  updateOrderStatusByAdmin
} from "../../../../../../modules/commerce/application/order-directory";
import { COMMERCE_ORDERS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";
import {
  ORDER_STATUSES,
  type OrderStatus
} from "../../../../../../modules/commerce/domain/order-status";

/** `PATCH /api/v1/commerce/orders/{id}/status` — admin status transition, enforced through `domain/order-status.ts`'s legal-transition table (Issue #29). */
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_ORDERS_ACTIVITY_CODE,
  action: "update"
} as const;

type PreparedStatus = { status: OrderStatus; note: string | null };

export const PATCH = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<PreparedStatus | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const record =
      bodyRead.value && typeof bodyRead.value === "object"
        ? (bodyRead.value as Record<string, unknown>)
        : {};

    if (
      typeof record.status !== "string" ||
      !(ORDER_STATUSES as readonly string[]).includes(record.status)
    ) {
      return fail(
        400,
        "VALIDATION_ERROR",
        `status must be one of: ${ORDER_STATUSES.join(", ")}.`
      );
    }

    const note =
      typeof record.note === "string" ? record.note.trim().slice(0, 500) : null;
    return { status: record.status as OrderStatus, note: note || null };
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared }) => {
    const orderId = params.id;
    if (!orderId) return fail(400, "VALIDATION_ERROR", "id is required.");

    try {
      const updated = await updateOrderStatusByAdmin(
        tx,
        tenantId,
        auth.context.tenantUserId,
        orderId,
        prepared.status,
        prepared.note
      );
      if (!updated) return fail(404, "RESOURCE_NOT_FOUND", "Order not found.");
      return ok({ status: prepared.status });
    } catch (error) {
      if (error instanceof IllegalOrderStatusTransitionError) {
        return fail(
          409,
          "ILLEGAL_STATUS_TRANSITION",
          error.message,
          {},
          error.errors
        );
      }
      throw error;
    }
  }
});
