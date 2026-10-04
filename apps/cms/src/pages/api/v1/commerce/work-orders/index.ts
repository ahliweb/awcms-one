/**
 * `GET|POST /api/v1/commerce/work-orders` — work / service orders (Issue #286,
 * ADR-0029 D6). `GET` (`commerce.work_orders.read`) is the keyset list, newest
 * first, filterable by `status` and `assignee`. `POST`
 * (`commerce.work_orders.create`, requires `Idempotency-Key`) creates one,
 * optionally from an ACCEPTED quotation (the accepted version becomes its
 * provenance) and/or linked to an existing order; it takes the next gapless
 * `WO-<year>-<counter>` number. A work order holds no money. Both are gated on
 * the tenant's `documents` feature.
 */
import { created, fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../modules/_shared/keyset-pagination";
import {
  createWorkOrder,
  listWorkOrders,
  type WorkOrderListFilters
} from "../../../../../modules/commerce/application/work-order-directory";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireDocumentsFeature,
  requireIdempotencyKey
} from "../../../../../modules/commerce/application/documents-http";
import {
  isUuid,
  validateCreateWorkOrderInput,
  WORK_ORDER_STATUSES,
  type CreateWorkOrderInput,
  type WorkOrderStatus
} from "../../../../../modules/commerce/domain/documents";
import { COMMERCE_WORK_ORDERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_WORK_ORDERS_ACTIVITY_CODE,
  action: "read"
} as const;

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_WORK_ORDERS_ACTIVITY_CODE,
  action: "create"
} as const;

type PreparedList = {
  cursor: KeysetCursor | null;
  filters: WorkOrderListFilters;
};

export const GET = defineTenantRoute<PreparedList>({
  workClass: "interactive",
  prepare: ({ url }): PreparedList | Response => {
    const cursorParam = url.searchParams.get("cursor");
    let cursor: KeysetCursor | null = null;
    if (cursorParam) {
      const decoded = decodeKeysetCursor(cursorParam);
      if (!decoded)
        return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
      cursor = decoded;
    }
    const filters: WorkOrderListFilters = {};
    const status = url.searchParams.get("status");
    if (status) {
      if (!(WORK_ORDER_STATUSES as readonly string[]).includes(status)) {
        return fail(
          400,
          "VALIDATION_ERROR",
          `status must be one of: ${WORK_ORDER_STATUSES.join(", ")}.`
        );
      }
      filters.status = status as WorkOrderStatus;
    }
    const assignee = url.searchParams.get("assignee");
    if (assignee) {
      if (!isUuid(assignee)) {
        return fail(400, "VALIDATION_ERROR", "assignee must be a UUID.");
      }
      filters.assigneeTenantUserId = assignee;
    }
    return { cursor, filters };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireDocumentsFeature(tx, tenantId);
    if (gate) return gate;
    return ok(
      await listWorkOrders(tx, tenantId, prepared.cursor, prepared.filters)
    );
  }
});

export const POST = defineTenantRoute<CreateWorkOrderInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateCreateWorkOrderInput(body, key.key)
    );
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, now, locals }) => {
    const gate = await requireDocumentsFeature(tx, tenantId);
    if (gate) return gate;
    try {
      const outcome = await createWorkOrder(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared,
        now,
        locals.correlationId
      );
      switch (outcome.kind) {
        case "reference_not_found":
          // One answer for an unknown and another tenant's id.
          return fail(
            400,
            "VALIDATION_ERROR",
            `${outcome.field} does not refer to an existing record.`,
            {},
            [
              {
                field: outcome.field,
                message: `${outcome.field} does not refer to an existing record.`
              }
            ]
          );
        case "quotation_not_accepted":
          return fail(
            409,
            "QUOTATION_NOT_ACCEPTED",
            "A work order can only be created from an accepted quotation.",
            {},
            { status: outcome.status }
          );
        default:
          return created(outcome.workOrder);
      }
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
