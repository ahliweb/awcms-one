/**
 * `GET|POST /api/v1/commerce/orders/{id}/returns` - the returns of one order
 * and the "record a return or exchange" mutation (Issue #287, ADR-0033).
 *
 * `GET` (`commerce.returns.read`) lists the order's returns with their lines,
 * refund legs and compensations. `POST` (`commerce.returns.create`, requires
 * `Idempotency-Key`) records goods accepted back: quantities are bounded by
 * what remains eligible (under the order-row lock, with a database trigger as
 * the second guard), the stock effect goes through the inventory port, and -
 * when the body asks for a refund - the refund legs are planned against what
 * each original payment can still give back and every leg that can settle now
 * is settled in the same transaction. A refund also needs
 * `commerce.refunds.create` and `commerce.payments.revoke`, checked through the
 * same chokepoint. Gated on the `returns` feature (default OFF).
 *
 * Tenant isolation: the order id comes from the path and is resolved inside
 * the RLS-scoped transaction with an explicit tenant filter - an unknown order
 * and another tenant's order are the same `404` (no BOLA oracle).
 */
import { ok, fail } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { authorizeInTransaction } from "../../../../../../../modules/identity-access/application/access-guard";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireIdempotencyKey
} from "../../../../../../../modules/commerce/application/register-http";
import { createReturn } from "../../../../../../../modules/commerce/application/return-directory";
import {
  createReturnResponse,
  requirePaymentsRevoke,
  requireReturnsFeature
} from "../../../../../../../modules/commerce/application/return-http";
import { listReturnsForOrder } from "../../../../../../../modules/commerce/application/return-records";
import {
  COMMERCE_REFUNDS_ACTIVITY_CODE,
  COMMERCE_RETURNS_ACTIVITY_CODE
} from "../../../../../../../modules/commerce/domain/commerce-permissions";
import {
  validateCreateReturnInput,
  type CreateReturnInput
} from "../../../../../../../modules/commerce/domain/returns";
import { inventoryErrorResponse } from "../../../../../../../modules/commerce/application/commerce-inventory-http";

const REFUND_CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REFUNDS_ACTIVITY_CODE,
  action: "create"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_RETURNS_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireReturnsFeature(tx, tenantId);
    if (gate) return gate;
    if (!params.id) return fail(400, "VALIDATION_ERROR", "id is required.");
    const orders = (await tx`
      SELECT 1 AS present FROM awcms_commerce_orders
      WHERE tenant_id = ${tenantId} AND id = ${params.id} AND deleted_at IS NULL
    `) as unknown[];
    if (orders.length === 0) {
      return fail(404, "RESOURCE_NOT_FOUND", "Order not found.");
    }
    return ok({ returns: await listReturnsForOrder(tx, tenantId, params.id) });
  }
});

export const POST = defineTenantRoute<CreateReturnInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateCreateReturnInput(body, key.key)
    );
  },
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_RETURNS_ACTIVITY_CODE,
    action: "create"
  },
  handler: async ({
    tx,
    tenantId,
    auth,
    params,
    prepared,
    locals,
    tokenHash,
    now
  }) => {
    const gate = await requireReturnsFeature(tx, tenantId);
    if (gate) return gate;
    if (!params.id) return fail(400, "VALIDATION_ERROR", "id is required.");

    if (prepared.refund) {
      const refundAuth = await authorizeInTransaction(
        tx,
        tenantId,
        tokenHash,
        now,
        REFUND_CREATE_GUARD
      );
      if (!refundAuth.allowed) return refundAuth.denied;
      const revoke = await requirePaymentsRevoke(tx, tenantId, tokenHash, now);
      if (revoke) return revoke;
    }

    try {
      return createReturnResponse(
        await createReturn(
          tx,
          tenantId,
          auth.context.tenantUserId,
          params.id,
          prepared,
          now,
          locals.correlationId
        )
      );
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      const inventoryFailure = inventoryErrorResponse(error);
      if (inventoryFailure) return inventoryFailure;
      throw error;
    }
  }
});
