/**
 * `POST /api/v1/commerce/register-sessions/{id}/movements` — record a cash
 * drawer movement (cash in, cash out, safe drop, expense, transfer,
 * correction) against an OPEN session (Issue #284, ADR-0028). Gated on
 * `commerce.register_sessions.update`; requires `Idempotency-Key`. Movements
 * are append-only and cash only; the acting user must be the session's
 * current cashier (`409 NOT_SESSION_CASHIER`), and a session that is not open
 * accepts none (`409 REGISTER_SESSION_NOT_OPEN`). An `expense` movement's
 * `reference` here is free text. Since Issue #294 (ADR-0031) a tenant whose
 * `expenses` feature is ON records expenses through the expenses domain, whose
 * posting appends the typed `expense` movement itself - so a raw `expense`
 * movement is refused there (`409 EXPENSE_REQUIRES_EXPENSE_RECORD`): it would
 * bypass the approval threshold. With the feature OFF (the default) nothing
 * changes.
 */
import { created, fail } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireIdempotencyKey,
  requireRegisterFeature
} from "../../../../../../modules/commerce/application/register-http";
import { fetchCommerceFeatures } from "../../../../../../modules/commerce/application/commerce-feature-gate";
import { recordRegisterMovement } from "../../../../../../modules/commerce/application/register-session-directory";
import {
  isUuid,
  validateRecordMovementInput,
  type RecordMovementInput
} from "../../../../../../modules/commerce/domain/register";
import { COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE,
  action: "update"
} as const;

export const POST = defineTenantRoute<RecordMovementInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateRecordMovementInput(body, key.key)
    );
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const gate = await requireRegisterFeature(tx, tenantId);
    if (gate) return gate;
    // Issue #294 (ADR-0031 D6): once the tenant uses the expenses domain, an
    // `expense` drawer movement is produced ONLY by posting an expense - a raw
    // one here would bypass the approval threshold and segregation of duties.
    if (
      prepared.movementType === "expense" &&
      (await fetchCommerceFeatures(tx, tenantId)).expenses
    ) {
      return fail(
        409,
        "EXPENSE_REQUIRES_EXPENSE_RECORD",
        "This tenant records expenses through the expenses feature; post an expense instead of a raw expense movement."
      );
    }
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Register session not found.");
    }
    try {
      const outcome = await recordRegisterMovement(
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
        case "session_not_open":
          return fail(
            409,
            "REGISTER_SESSION_NOT_OPEN",
            "The session is not open and accepts no movements.",
            {},
            { status: outcome.status }
          );
        case "not_session_cashier":
          return fail(
            409,
            "NOT_SESSION_CASHIER",
            "Only the session's current cashier may record a movement."
          );
        default:
          return created(outcome.movement);
      }
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
