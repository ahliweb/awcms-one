/**
 * `POST /api/v1/commerce/customers/{id}/subject-erasure` (Issue #529,
 * ADR-0055 D2/D3) - an administrator REQUESTS the erasure of a shopper's
 * personal data. It erases NOTHING: it runs the precondition check and records
 * a request that a second person approves (`.../customer-subject-requests/{id}/decide`).
 *
 * Needs `commerce.customer_subject_requests.delete` (high-risk), a FRESH step-up
 * (`403 STEP_UP_REQUIRED` otherwise, nothing written) and an `Idempotency-Key`.
 * Body `{ "reason"?: string }` (at most 500 characters).
 *
 * - `202 { request }` - recorded as `pending_approval`.
 * - `409 ERASURE_REFUSED` - an open order, booking, stored-value balance, refund
 *   or affiliate payout (or the customer is already erased); the refusal is
 *   recorded as a `refused` request.
 * - A repeated key answers the same request (`replayed: true`); a key used by
 *   another request is `409 IDEMPOTENCY_CONFLICT`.
 */
import {
  fail,
  jsonResponse
} from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import { adminRequestErasure } from "../../../../../../modules/commerce/application/customer-subject-flow";
import {
  erasureRefusedResponse,
  requireSubjectIdempotencyKey
} from "../../../../../../modules/commerce/application/customer-subject-http";
import { COMMERCE_CUSTOMER_SUBJECT_REQUESTS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/customer-subject-permissions";
import { normaliseSubjectReason } from "../../../../../../modules/commerce/domain/customer-subject-policy";
import { isUuid } from "../../../../../../modules/commerce/domain/register";
import { requireStepUp } from "../../../../../../modules/identity-access/application/mfa-session-assurance";

const DELETE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CUSTOMER_SUBJECT_REQUESTS_ACTIVITY_CODE,
  action: "delete"
} as const;

type Prepared = { idempotencyKey: string; reason: string | null };

export const POST = defineTenantRoute<Prepared>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireSubjectIdempotencyKey(request);
    if ("response" in key) return key.response;

    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
    const body = (bodyRead.value ?? {}) as Record<string, unknown>;
    const reason = normaliseSubjectReason(body.reason);
    if (!reason.ok) {
      return fail(400, "VALIDATION_ERROR", "Invalid request.", {}, [
        { field: "reason", message: reason.message }
      ]);
    }
    return { idempotencyKey: key.key, reason: reason.value };
  },
  authorize: DELETE_GUARD,
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
    const customerId = params.id;
    if (!isUuid(customerId)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Customer not found.");
    }

    const stepUp = await requireStepUp(tx, tenantId, tokenHash, now);
    if (!stepUp.ok) return stepUp.denied;

    const outcome = await adminRequestErasure(
      tx,
      tenantId,
      auth.context.tenantUserId,
      customerId,
      prepared.reason,
      prepared.idempotencyKey,
      { correlationId: locals.correlationId }
    );

    switch (outcome.kind) {
      case "not_found":
        return fail(404, "RESOURCE_NOT_FOUND", "Customer not found.");
      case "key_conflict":
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      case "refused":
        return erasureRefusedResponse(outcome.codes);
      case "replayed":
      case "pending":
        return jsonResponse(
          {
            success: true,
            data: {
              replayed: outcome.kind === "replayed",
              request: outcome.request
            },
            meta: {}
          },
          { status: 202 }
        );
    }
  }
});
