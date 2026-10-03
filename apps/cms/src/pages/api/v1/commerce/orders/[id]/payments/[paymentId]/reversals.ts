/**
 * `POST /api/v1/commerce/orders/{id}/payments/{paymentId}/reversals` — record
 * a compensating reversal of (part of) a payment (Issue #285, epic #281,
 * ADR-0025). Gated on `commerce.payments.revoke` — the platform's existing
 * HIGH-RISK action verb (`commerce-permissions.ts`'s
 * `COMMERCE_PAYMENT_PERMISSIONS` header explains the choice); requires
 * `Idempotency-Key`.
 *
 * The ledger is append-only: a mistake or a refund is a NEW `reversal` row
 * pointing at the payment it compensates, never an edit of that payment. The
 * sum of a payment's reversals can never exceed the payment (checked under the
 * order-row lock, so concurrent reversals serialise), and a reversal never
 * moves the order's lifecycle backwards — it lowers the settlement and the
 * derived `paymentStatus` (`paid -> partially_paid`, or `refunded` once
 * everything went back). This route records the book-keeping fact only; it
 * calls no provider and moves no money — returning the money (a bank transfer,
 * a provider refund) is the operator's act, performed outside this request.
 *
 * Both ids are resolved tenant- AND order-scoped: another tenant's order, an
 * unknown payment, and a payment of a DIFFERENT order are all the same `404`.
 */
import {
  created,
  fail,
  jsonResponse
} from "../../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../../modules/_shared/tenant-route";
import { IdempotencyRaceLostError } from "../../../../../../../../modules/_shared/idempotency";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../../lib/security/request-body-limit";
import { IdempotencyPayloadMismatchError } from "../../../../../../../../modules/commerce/application/order-directory";
import {
  AllocationSourceKeyConflictError,
  ReversalExceedsPaymentError
} from "../../../../../../../../modules/commerce/application/payment-allocation-directory";
import { recordOwnerReversal } from "../../../../../../../../modules/commerce/application/payment-recording";
import {
  validateRecordReversalInput,
  type RecordReversalInput
} from "../../../../../../../../modules/commerce/domain/payment-allocation";
import { COMMERCE_PAYMENTS_ACTIVITY_CODE } from "../../../../../../../../modules/commerce/domain/commerce-permissions";

const REVOKE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PAYMENTS_ACTIVITY_CODE,
  action: "revoke"
} as const;

export const POST = defineTenantRoute<RecordReversalInput>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<RecordReversalInput | Response> => {
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      return fail(
        400,
        "IDEMPOTENCY_REQUIRED",
        "Idempotency-Key header is required."
      );
    }

    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const result = validateRecordReversalInput(
      bodyRead.value ?? {},
      idempotencyKey
    );
    if (!result.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Request body failed validation.",
        {},
        result.errors
      );
    }
    return result.value;
  },
  authorize: REVOKE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const orderId = params.id;
    const paymentId = params.paymentId;
    if (!orderId || !paymentId) {
      return fail(400, "VALIDATION_ERROR", "id and paymentId are required.");
    }

    try {
      const outcome = await recordOwnerReversal(
        tx,
        tenantId,
        auth.context.tenantUserId,
        orderId,
        paymentId,
        prepared,
        locals.correlationId
      );
      if (outcome.kind === "not_found") {
        return fail(404, "RESOURCE_NOT_FOUND", "Payment not found.");
      }
      if (outcome.kind === "not_reversible") {
        return fail(
          409,
          "PAYMENT_NOT_REVERSIBLE",
          outcome.reason === "fully_reversed"
            ? "This payment has already been reversed in full."
            : "Only a succeeded payment can be reversed.",
          {},
          { reason: outcome.reason }
        );
      }
      return created(outcome.body);
    } catch (error) {
      if (error instanceof IdempotencyRaceLostError) {
        if (error.replay) {
          return jsonResponse(error.replay.responseBody, {
            status: error.replay.responseStatus
          });
        }
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
      if (
        error instanceof IdempotencyPayloadMismatchError ||
        error instanceof AllocationSourceKeyConflictError
      ) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
      if (error instanceof ReversalExceedsPaymentError) {
        return fail(
          409,
          "REVERSAL_EXCEEDS_PAYMENT",
          "The reversal exceeds what remains reversible on the payment.",
          {},
          { reversible: error.reversible }
        );
      }
      throw error;
    }
  }
});
