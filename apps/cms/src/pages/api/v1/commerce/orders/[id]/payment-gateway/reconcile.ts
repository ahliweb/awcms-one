import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { getDatabaseClient } from "../../../../../../../lib/database/client";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../../modules/_shared/idempotency";
import { reconcileOneOrderPaymentSession } from "../../../../../../../modules/commerce/application/payment-reconcile";
import {
  resolvePaymentGatewayProvider,
  resolvePaymentGatewayProviderKey
} from "../../../../../../../modules/commerce/infrastructure/payment-gateway-provider-resolver";
import { COMMERCE_ORDERS_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";

const IDEMPOTENCY_SCOPE = "commerce_order_payment_gateway_reconcile";

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_ORDERS_ACTIVITY_CODE,
  action: "update"
} as const;

type Prepared = { idempotencyKey: string };

/**
 * `POST /api/v1/commerce/orders/{id}/payment-gateway/reconcile` (Issue #113)
 * — the admin order detail screen's "Cek status" action. A SCOPED,
 * single-order reconcile — never the full `commerce:payments:reconcile`
 * batch job — gated on `commerce.orders.update` and requiring
 * `Idempotency-Key` (a high-risk-adjacent mutation: it can move an order to
 * `paid`).
 *
 * `reconcileOneOrderPaymentSession` calls `provider.fetchStatus` with NO
 * transaction open (it opens its OWN short `withTenantOrThrow`
 * transactions) — this route therefore does the same "auth chokepoint tx,
 * then a second independent client for the provider round trip" split
 * `application/payment-gateway-directory.ts`'s own header documents for
 * `createGatewaySession`, rather than making the provider call from inside
 * `defineTenantRoute`'s own open transaction.
 */
export const POST = defineTenantRoute<Prepared>({
  workClass: "interactive",
  prepare: ({ request }): Prepared | Response => {
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) {
      return fail(
        400,
        "IDEMPOTENCY_REQUIRED",
        "Idempotency-Key header is required."
      );
    }
    return { idempotencyKey };
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, params, prepared, locals }) => {
    const orderId = params.id;
    if (!orderId) return fail(400, "VALIDATION_ERROR", "id is required.");

    const requestHash = computeRequestHash({ orderId, action: "reconcile" });

    const existing = await findIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      prepared.idempotencyKey
    );
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
      return jsonResponse(existing.responseBody, {
        status: existing.responseStatus
      });
    }

    const providerKey = resolvePaymentGatewayProviderKey();
    const provider = resolvePaymentGatewayProvider();
    if (!providerKey || !provider) {
      return fail(
        503,
        "GATEWAY_UNAVAILABLE",
        "No payment-gateway provider is configured for this deployment."
      );
    }

    const orderRows = (await tx`
      SELECT id FROM awcms_commerce_orders
      WHERE tenant_id = ${tenantId} AND id = ${orderId} AND deleted_at IS NULL
    `) as { id: string }[];
    if (!orderRows[0])
      return fail(404, "RESOURCE_NOT_FOUND", "Order not found.");

    const sql = getDatabaseClient();
    const result = await reconcileOneOrderPaymentSession(
      sql,
      tenantId,
      orderId,
      provider,
      providerKey,
      locals.correlationId
    );

    if (result.outcome === "no_session") {
      return fail(
        409,
        "NO_PAYMENT_SESSION",
        "This order has no payment-gateway session to check."
      );
    }

    const successResponse = ok({ status: result.status ?? "pending" });
    const successBody = await successResponse.clone().json();
    await saveIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      prepared.idempotencyKey,
      requestHash,
      200,
      successBody
    );
    return successResponse;
  }
});
