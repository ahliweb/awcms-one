/**
 * `GET|POST /api/v1/commerce/orders/{id}/payments` — the order's
 * payment-allocation ledger and the owner-side "record an additional tender"
 * mutation (Issue #285, epic #281, ADR-0025).
 *
 * `GET` (`commerce.payments.read`) returns the derived settlement plus every
 * ledger row, oldest first. `POST` (`commerce.payments.create`, requires
 * `Idempotency-Key`) records one `succeeded` tender against the order under
 * the order-row lock: it can never over-settle (a concurrent final payment
 * waits and then fails its own overpayment check — `409 OVERPAYMENT`), and the
 * leg that brings settlement to the order's release threshold moves the order
 * to `paid` through the one order-status machine. Staff may record `cash`,
 * `manual_qris`, `manual_bank_transfer` and — with the tenant's `storedValue`
 * feature on (Issue #288) — `gift_card` / `store_credit`, which carry the
 * plaintext `storedValueCode` (resolved to an account, never stored) and
 * redeem it in the same transaction; a `gateway` leg is created only by
 * the hosted-checkout flow. For `cash`, `amount` is what the customer HANDED
 * OVER — the applied amount and the change are derived server-side.
 *
 * Tenant isolation: the order id comes from the path and is resolved inside
 * the RLS-scoped transaction with an explicit tenant filter — an unknown
 * order and another tenant's order are the same `404` (no BOLA oracle).
 */
import {
  created,
  fail,
  jsonResponse,
  ok
} from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { IdempotencyRaceLostError } from "../../../../../../../modules/_shared/idempotency";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import { IdempotencyPayloadMismatchError } from "../../../../../../../modules/commerce/application/order-directory";
import {
  AllocationSourceKeyConflictError,
  fetchOrderPaymentSummary
} from "../../../../../../../modules/commerce/application/payment-allocation-directory";
import { RegisterSessionClosingError } from "../../../../../../../modules/commerce/application/register-session-stamp";
import { recordOwnerPayment } from "../../../../../../../modules/commerce/application/payment-recording";
import {
  OverpaymentError,
  validateRecordPaymentInput,
  type RecordPaymentInput
} from "../../../../../../../modules/commerce/domain/payment-allocation";
import { COMMERCE_PAYMENTS_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";
import { FeatureDisabledError } from "../../../../../../../modules/commerce/domain/commerce-features";
import { storedValueTenderErrorResponse } from "../../../../../../../modules/commerce/application/stored-value-http";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PAYMENTS_ACTIVITY_CODE,
  action: "read"
} as const;

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PAYMENTS_ACTIVITY_CODE,
  action: "create"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const orderId = params.id;
    if (!orderId) return fail(400, "VALIDATION_ERROR", "id is required.");

    const summary = await fetchOrderPaymentSummary(tx, tenantId, orderId);
    if (!summary) return fail(404, "RESOURCE_NOT_FOUND", "Order not found.");

    return ok({
      orderId: summary.orderId,
      orderCode: summary.orderCode,
      orderStatus: summary.orderStatus,
      settlement: summary.settlement,
      payments: summary.allocations
    });
  }
});

export const POST = defineTenantRoute<RecordPaymentInput>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<RecordPaymentInput | Response> => {
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

    const result = validateRecordPaymentInput(
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
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const orderId = params.id;
    if (!orderId) return fail(400, "VALIDATION_ERROR", "id is required.");

    try {
      const outcome = await recordOwnerPayment(
        tx,
        tenantId,
        auth.context.tenantUserId,
        orderId,
        prepared,
        locals.correlationId
      );
      if (outcome.kind === "order_not_found") {
        return fail(404, "RESOURCE_NOT_FOUND", "Order not found.");
      }
      if (outcome.kind === "order_not_payable") {
        return fail(
          409,
          "ORDER_NOT_PAYABLE",
          "A cancelled or expired order cannot receive a payment."
        );
      }
      // `created` and `replayed` return the SAME 201 body (a replay is a
      // client retry, not a second payment), like every other idempotent
      // create in this module.
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
      if (error instanceof RegisterSessionClosingError) {
        return fail(409, "REGISTER_SESSION_CLOSING", error.message);
      }
      if (error instanceof OverpaymentError) {
        return fail(
          409,
          "OVERPAYMENT",
          "The amount exceeds what is still owed on the order.",
          {},
          { outstanding: error.outstanding, attempted: error.attempted }
        );
      }
      if (error instanceof FeatureDisabledError) {
        return fail(
          409,
          "FEATURE_DISABLED",
          `The "${error.feature}" feature is disabled for this tenant.`
        );
      }
      const storedValue = storedValueTenderErrorResponse(error);
      if (storedValue) return storedValue;
      throw error;
    }
  }
});
