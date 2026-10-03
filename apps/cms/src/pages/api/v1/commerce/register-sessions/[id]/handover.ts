/**
 * `POST /api/v1/commerce/register-sessions/{id}/handover` — hand the drawer to
 * another cashier (Issue #284, ADR-0028). Gated on
 * `commerce.register_sessions.update`; requires `Idempotency-Key`. Allowed for
 * the session's CURRENT cashier, or for a supervisor holding
 * `commerce.register_cash_ups.approve` (checked here, through the same
 * chokepoint, only when the caller is not the current cashier). The target
 * must be an active tenant user (`409 UNKNOWN_CASHIER` otherwise); the history
 * lives in the audit trail (`register_session.handover`).
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { authorizeInTransaction } from "../../../../../../modules/identity-access/application/access-guard";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireIdempotencyKey,
  requireRegisterFeature
} from "../../../../../../modules/commerce/application/register-http";
import { handOverRegisterSession } from "../../../../../../modules/commerce/application/register-session-directory";
import {
  isUuid,
  validateHandoverInput,
  type HandoverInput
} from "../../../../../../modules/commerce/domain/register";
import {
  COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE,
  COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE
} from "../../../../../../modules/commerce/domain/commerce-permissions";

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE,
  action: "update"
} as const;

/** A supervisor may hand over a drawer that is not theirs. */
const SUPERVISOR_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE,
  action: "approve"
} as const;

export const POST = defineTenantRoute<HandoverInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateHandoverInput(body, key.key)
    );
  },
  authorize: UPDATE_GUARD,
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
    const gate = await requireRegisterFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Register session not found.");
    }
    const actor = auth.context.tenantUserId;
    try {
      let outcome = await handOverRegisterSession(
        tx,
        tenantId,
        actor,
        false,
        params.id,
        prepared,
        locals.correlationId
      );
      if (outcome.kind === "forbidden") {
        // Not the current cashier: a supervisor may still do it. The refused
        // attempt wrote nothing, so retrying under the stronger authority is
        // safe inside this same transaction.
        const supervisor = await authorizeInTransaction(
          tx,
          tenantId,
          tokenHash,
          now,
          SUPERVISOR_GUARD
        );
        if (supervisor.allowed) {
          outcome = await handOverRegisterSession(
            tx,
            tenantId,
            actor,
            true,
            params.id,
            prepared,
            locals.correlationId
          );
        }
      }
      switch (outcome.kind) {
        case "not_found":
          return fail(404, "RESOURCE_NOT_FOUND", "Register session not found.");
        case "forbidden":
          return fail(
            403,
            "ACCESS_DENIED",
            "Only the current cashier or a supervisor may hand the drawer over."
          );
        case "session_not_open":
          return fail(
            409,
            "REGISTER_SESSION_NOT_OPEN",
            "The session is not open and cannot be handed over.",
            {},
            { status: outcome.status }
          );
        case "same_cashier":
          return fail(
            409,
            "SAME_CASHIER",
            "That user is already the session's cashier."
          );
        case "unknown_cashier":
          return fail(
            409,
            "UNKNOWN_CASHIER",
            "The new cashier is not an active user of this tenant."
          );
        default:
          return ok(outcome.session);
      }
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
