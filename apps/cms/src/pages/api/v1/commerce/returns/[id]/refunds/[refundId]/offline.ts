/**
 * `POST /api/v1/commerce/returns/{id}/refunds/{refundId}/offline` - settle a
 * refund leg as made OUTSIDE the system (Issue #287, ADR-0033 D6): the
 * provider refused it or no adapter can make it, and an authorised operator
 * attests the money has gone back. The stated `reason` is stored on the leg and
 * the settlement is audited. Requires `Idempotency-Key`, the high-risk
 * `commerce.refunds_offline.approve` (a separate permission a tenant can put
 * under separation-of-duties rules) AND `commerce.payments.revoke`, and the
 * `returns` feature.
 */
import { fail } from "../../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../../modules/_shared/tenant-route";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireIdempotencyKey
} from "../../../../../../../../modules/commerce/application/register-http";
import { settleRefundOffline } from "../../../../../../../../modules/commerce/application/refund-execution";
import {
  offlineRefundResponse,
  requirePaymentsRevoke,
  requireReturnsFeature
} from "../../../../../../../../modules/commerce/application/return-http";
import { COMMERCE_REFUNDS_OFFLINE_ACTIVITY_CODE } from "../../../../../../../../modules/commerce/domain/commerce-permissions";
import {
  validateOfflineRefundInput,
  type OfflineRefundInput
} from "../../../../../../../../modules/commerce/domain/returns";
import { isUuid } from "../../../../../../../../modules/commerce/domain/stored-value";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../../../modules/_shared/idempotency";
import { IdempotencyPayloadMismatchError } from "../../../../../../../../modules/commerce/application/order-directory";

const SCOPE = "commerce.refunds.offline";

export const POST = defineTenantRoute<OfflineRefundInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateOfflineRefundInput(body, key.key)
    );
  },
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REFUNDS_OFFLINE_ACTIVITY_CODE,
    action: "approve"
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
      reason: prepared.reason
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
      const response = offlineRefundResponse(
        await settleRefundOffline(tx, tenantId, {
          returnId: params.id,
          refundId: params.refundId,
          actorTenantUserId: auth.context.tenantUserId,
          reason: prepared.reason,
          now,
          correlationId: locals.correlationId
        })
      );
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
