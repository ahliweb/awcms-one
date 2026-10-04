/**
 * `POST /api/v1/commerce/register-sessions/{id}/close-decision` — approve or
 * reject a cash-up whose variance exceeded the approval threshold (Issue #284,
 * ADR-0028). Gated on `commerce.register_cash_ups.approve` (a high-risk verb:
 * a tenant may author SoD rules against it); requires `Idempotency-Key`.
 * `approve` closes the session; `reject` (a note is required) returns it to
 * `open` for a recount, the rejected request kept as history. Only a
 * `closing` session has anything to decide (`409 REGISTER_CLOSE_NOT_PENDING`).
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { decideRegisterClose } from "../../../../../../modules/commerce/application/register-cash-up";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireIdempotencyKey,
  requireRegisterFeature
} from "../../../../../../modules/commerce/application/register-http";
import {
  isUuid,
  validateCloseDecisionInput,
  type CloseDecisionInput
} from "../../../../../../modules/commerce/domain/register";
import { COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const APPROVE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE,
  action: "approve"
} as const;

export const POST = defineTenantRoute<CloseDecisionInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateCloseDecisionInput(body, key.key)
    );
  },
  authorize: APPROVE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const gate = await requireRegisterFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Register session not found.");
    }
    try {
      const outcome = await decideRegisterClose(
        tx,
        tenantId,
        auth.context.tenantUserId,
        params.id,
        prepared,
        locals.correlationId
      );
      switch (outcome.kind) {
        case "not_found":
          return fail(404, "RESOURCE_NOT_FOUND", "Register session not found.");
        case "not_pending":
          return fail(
            409,
            "REGISTER_CLOSE_NOT_PENDING",
            "The session has no close awaiting a decision.",
            {},
            { status: outcome.status }
          );
        case "self_approval_forbidden":
          return fail(
            409,
            "SOD_MAKER_IS_CHECKER",
            "The user who counted the drawer cannot approve their own variance."
          );
        default:
          return ok(outcome.body);
      }
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
