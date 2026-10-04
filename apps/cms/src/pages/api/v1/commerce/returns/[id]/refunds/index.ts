/**
 * `POST /api/v1/commerce/returns/{id}/refunds` - plan and create the refund
 * legs for the part of a return that has none yet (a return recorded without a
 * refund) (Issue #287, ADR-0033). Same body as the `refund` object of the
 * return itself; every leg that can settle now is settled in this transaction,
 * a gateway leg is left `pending` for `.../refunds/{refundId}/execute`.
 * Requires `Idempotency-Key`, `commerce.refunds.create` and
 * `commerce.payments.revoke`, and the `returns` feature.
 */
import { fail } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireIdempotencyKey
} from "../../../../../../../modules/commerce/application/register-http";
import { createRefundsForReturn } from "../../../../../../../modules/commerce/application/return-directory";
import {
  createRefundsResponse,
  requirePaymentsRevoke,
  requireReturnsFeature
} from "../../../../../../../modules/commerce/application/return-http";
import { COMMERCE_REFUNDS_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";
import {
  validateCreateReturnInput,
  type CreateReturnRefundInput
} from "../../../../../../../modules/commerce/domain/returns";
import { isUuid } from "../../../../../../../modules/commerce/domain/stored-value";

type Prepared = { idempotencyKey: string; refund: CreateReturnRefundInput };

export const POST = defineTenantRoute<Prepared>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    // The refund object has the exact shape (and validator) of the one inside
    // a return; wrap it so the shared validator checks it.
    const parsed = await readValidatedBody(request, (body) => {
      const record =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {};
      return validateCreateReturnInput(
        {
          lines: [
            {
              orderItemId: "00000000-0000-4000-8000-000000000000",
              quantity: 1,
              reason: "other",
              disposition: "damaged"
            }
          ],
          refund: record.refund ?? record
        },
        key.key
      );
    });
    if (parsed instanceof Response) return parsed;
    if (!parsed.refund) {
      return fail(400, "VALIDATION_ERROR", "refund is required.");
    }
    return { idempotencyKey: key.key, refund: parsed.refund };
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
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Return not found.");
    }
    const revoke = await requirePaymentsRevoke(tx, tenantId, tokenHash, now);
    if (revoke) return revoke;
    try {
      return createRefundsResponse(
        await createRefundsForReturn(
          tx,
          tenantId,
          auth.context.tenantUserId,
          params.id,
          prepared.idempotencyKey,
          prepared.refund,
          now,
          locals.correlationId
        )
      );
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
