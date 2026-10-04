/**
 * `POST /api/v1/commerce/returns/{id}/refunds/{refundId}/execute` - settle
 * one refund leg that is still open: a gateway leg is sent to the payment
 * provider, any other still-open leg is settled in the ledger (Issue #287,
 * ADR-0033 D6). Requires `Idempotency-Key`, `commerce.refunds.create` and
 * `commerce.payments.revoke`, and the `returns` feature.
 *
 * The provider call runs with NO transaction open: `executeRefund` opens its
 * own two short transactions on the pool client around it (claim -> provider
 * -> record), and the provider is given the refund row's id as its idempotency
 * key on every attempt, so a retry can never refund twice. This route's own
 * transaction is only the authorisation chokepoint and the idempotency record
 * - the `payment-gateway/reconcile` route's precedent. A transport failure is
 * recorded as a retryable `failed` leg, never as refunded; a leg the provider
 * cannot refund is settled with `.../offline`.
 */
import { fail } from "../../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../../modules/_shared/tenant-route";
import { getDatabaseClient } from "../../../../../../../../lib/database/client";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../../../modules/_shared/idempotency";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireIdempotencyKey
} from "../../../../../../../../modules/commerce/application/register-http";
import { IdempotencyPayloadMismatchError } from "../../../../../../../../modules/commerce/application/order-directory";
import { executeRefund } from "../../../../../../../../modules/commerce/application/refund-execution";
import {
  executeRefundResponse,
  requirePaymentsRevoke,
  requireReturnsFeature
} from "../../../../../../../../modules/commerce/application/return-http";
import { resolvePaymentGatewayProvider } from "../../../../../../../../modules/commerce/infrastructure/payment-gateway-provider-resolver";
import { COMMERCE_REFUNDS_ACTIVITY_CODE } from "../../../../../../../../modules/commerce/domain/commerce-permissions";
import {
  validateExecuteRefundInput,
  type ExecuteRefundInput
} from "../../../../../../../../modules/commerce/domain/returns";
import { isUuid } from "../../../../../../../../modules/commerce/domain/stored-value";

const SCOPE = "commerce.refunds.execute";

export const POST = defineTenantRoute<ExecuteRefundInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateExecuteRefundInput(body, key.key)
    );
  },
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REFUNDS_ACTIVITY_CODE,
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
    if (!isUuid(params.id) || !isUuid(params.refundId)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Refund not found.");
    }
    const revoke = await requirePaymentsRevoke(tx, tenantId, tokenHash, now);
    if (revoke) return revoke;

    const requestHash = computeRequestHash({
      action: SCOPE,
      actorTenantUserId: auth.context.tenantUserId,
      returnId: params.id,
      refundId: params.refundId,
      registerSessionId: prepared.registerSessionId
    });
    try {
      const existing = await findIdempotencyRecord(
        tx,
        tenantId,
        SCOPE,
        prepared.idempotencyKey
      );
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new IdempotencyPayloadMismatchError();
        }
        return new Response(JSON.stringify(existing.responseBody), {
          status: existing.responseStatus,
          headers: { "content-type": "application/json" }
        });
      }

      const outcome = await executeRefund(
        getDatabaseClient(),
        tenantId,
        {
          returnId: params.id,
          refundId: params.refundId,
          actorTenantUserId: auth.context.tenantUserId,
          registerSessionId: prepared.registerSessionId,
          correlationId: locals.correlationId
        },
        { provider: resolvePaymentGatewayProvider() }
      );
      const response = executeRefundResponse(outcome);
      // Only a settled or accepted-pending answer is replayed under the key; a
      // failure or an unavailable adapter must be retryable with the SAME key.
      if (response.ok) {
        await saveIdempotencyRecord(
          tx,
          tenantId,
          SCOPE,
          prepared.idempotencyKey,
          requestHash,
          response.status,
          await response.clone().json()
        );
      }
      return response;
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
