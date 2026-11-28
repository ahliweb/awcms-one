/**
 * `POST /api/v1/commerce/customer-subject-requests/{id}/decide` (Issue #529,
 * ADR-0055 D3) - the SECOND person approves or rejects a pending erasure.
 * Body `{ "decision": "approve" | "reject" }`.
 *
 * Needs `commerce.customer_subject_requests.approve` (high-risk), a FRESH
 * step-up (`403 STEP_UP_REQUIRED`, nothing written) and an `Idempotency-Key`.
 * The approver is never the requester (`403 SEPARATION_OF_DUTIES`): checked here
 * and again by the claiming `UPDATE` and the table's CHECK. Approving runs the
 * erasure in this transaction and returns the retained summary.
 *
 * - `200 { request }` - `completed` or `rejected`.
 * - `404` - no such request. `409 INVALID_STATE` - not pending (already decided).
 * - `409 ERASURE_REFUSED` - the shopper's state changed since the request (a new
 *   order, say); recorded as `refused`, nothing erased.
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import { adminDecideErasure } from "../../../../../../modules/commerce/application/customer-subject-flow";
import {
  erasureRefusedResponse,
  requireSubjectIdempotencyKey
} from "../../../../../../modules/commerce/application/customer-subject-http";
import { COMMERCE_CUSTOMER_SUBJECT_REQUESTS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/customer-subject-permissions";
import { isUuid } from "../../../../../../modules/commerce/domain/register";
import { requireStepUp } from "../../../../../../modules/identity-access/application/mfa-session-assurance";

const APPROVE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CUSTOMER_SUBJECT_REQUESTS_ACTIVITY_CODE,
  action: "approve"
} as const;

type Prepared = { decision: "approve" | "reject" };

export const POST = defineTenantRoute<Prepared>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireSubjectIdempotencyKey(request);
    if ("response" in key) return key.response;

    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
    const body = (bodyRead.value ?? {}) as Record<string, unknown>;
    if (body.decision !== "approve" && body.decision !== "reject") {
      return fail(400, "VALIDATION_ERROR", "Invalid request.", {}, [
        {
          field: "decision",
          message: 'decision must be "approve" or "reject".'
        }
      ]);
    }
    return { decision: body.decision };
  },
  authorize: APPROVE_GUARD,
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
    const requestId = params.id;
    if (!isUuid(requestId)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Request not found.");
    }

    const stepUp = await requireStepUp(tx, tenantId, tokenHash, now);
    if (!stepUp.ok) return stepUp.denied;

    const outcome = await adminDecideErasure(
      tx,
      tenantId,
      auth.context.tenantUserId,
      requestId,
      prepared.decision,
      { correlationId: locals.correlationId }
    );

    switch (outcome.kind) {
      case "not_found":
        return fail(404, "RESOURCE_NOT_FOUND", "Request not found.");
      case "not_pending":
        return fail(
          409,
          "INVALID_STATE",
          `Only a pending erasure can be decided (this request is ${outcome.status}).`
        );
      case "same_person":
        return fail(
          403,
          "SEPARATION_OF_DUTIES",
          "The person who requested an erasure cannot approve it."
        );
      case "lost_race":
        return fail(
          409,
          "INVALID_STATE",
          "This request was decided by someone else."
        );
      case "refused":
        return erasureRefusedResponse(outcome.codes);
      case "rejected":
      case "erased":
        return ok({ request: outcome.request });
    }
  }
});
