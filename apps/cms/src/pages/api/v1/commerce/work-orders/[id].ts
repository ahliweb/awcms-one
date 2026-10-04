/**
 * `GET|PATCH /api/v1/commerce/work-orders/{id}` — one work order with its
 * append-only status history, and its operational updates (Issue #286,
 * ADR-0029 D6). `GET` is gated on `commerce.work_orders.read`; `PATCH` on
 * `commerce.work_orders.update` and requires `Idempotency-Key`. A body may move
 * the status (`status`, optional `note`; only legal edges - `409
 * WORK_ORDER_TRANSITION_ILLEGAL`), reassign (`assigneeTenantUserId`), reschedule
 * (`dueAt`) and/or reprioritise. A completed or cancelled work order accepts
 * nothing (`409 WORK_ORDER_CLOSED`). An unknown id and another tenant's id are
 * the same `404`.
 */
import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  fetchWorkOrder,
  updateWorkOrder
} from "../../../../../modules/commerce/application/work-order-directory";
import {
  idempotencyErrorResponse,
  notFoundResponse,
  readValidatedBody,
  requireDocumentsFeature,
  requireIdempotencyKey,
  requireUuidParam
} from "../../../../../modules/commerce/application/documents-http";
import {
  validateWorkOrderUpdateInput,
  type WorkOrderTransitionInput
} from "../../../../../modules/commerce/domain/documents";
import { COMMERCE_WORK_ORDERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_WORK_ORDERS_ACTIVITY_CODE,
  action: "read"
} as const;

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_WORK_ORDERS_ACTIVITY_CODE,
  action: "update"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireDocumentsFeature(tx, tenantId);
    if (gate) return gate;
    const bad = requireUuidParam(params.id, "Work order");
    if (bad) return bad;
    const workOrder = await fetchWorkOrder(tx, tenantId, params.id!);
    return workOrder ? ok(workOrder) : notFoundResponse("Work order");
  }
});

export const PATCH = defineTenantRoute<WorkOrderTransitionInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateWorkOrderUpdateInput(body, key.key)
    );
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, now, locals }) => {
    const gate = await requireDocumentsFeature(tx, tenantId);
    if (gate) return gate;
    const bad = requireUuidParam(params.id, "Work order");
    if (bad) return bad;
    try {
      const outcome = await updateWorkOrder(
        tx,
        tenantId,
        auth.context.tenantUserId,
        params.id!,
        prepared,
        now,
        locals.correlationId
      );
      switch (outcome.kind) {
        case "not_found":
          return notFoundResponse("Work order");
        case "closed":
          return fail(
            409,
            "WORK_ORDER_CLOSED",
            "A completed or cancelled work order cannot change.",
            {},
            { status: outcome.status }
          );
        case "illegal_transition":
          return fail(
            409,
            "WORK_ORDER_TRANSITION_ILLEGAL",
            "That status change is not allowed from the work order's current status.",
            {},
            { from: outcome.from, to: outcome.to }
          );
        default:
          return ok(outcome.workOrder);
      }
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
