/**
 * `POST /api/v1/commerce/register-sessions/{id}/close` — close (cash-up) a
 * session by counting the drawer per tender (Issue #284, ADR-0028). Gated on
 * `commerce.register_cash_ups.create`; requires `Idempotency-Key`; idempotent
 * and concurrency-safe (the close is exclusive against every sale, movement
 * and stamped payment leg of the session - a replay returns the stored body).
 *
 * The expected amount per tender is DERIVED (opening float + the session's
 * stamped payment legs + drawer movements); the body carries only what was
 * COUNTED. The gross variance (sum of absolute per-tender variances) is
 * compared with the tenant's approval threshold: within it the session is
 * `closed`; above it, a caller who also holds
 * `commerce.register_cash_ups.approve` (checked here, through the same
 * chokepoint, only when needed) closes it in one step, and one who does not
 * leaves it `closing` (`outcome: pending_approval`) until an approver decides
 * (`.../close-decision`). A reason is mandatory whenever any tender is off.
 * Only the current cashier may close.
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { authorizeInTransaction } from "../../../../../../modules/identity-access/application/access-guard";
import { closeRegisterSession } from "../../../../../../modules/commerce/application/register-cash-up";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireIdempotencyKey,
  requireRegisterFeature
} from "../../../../../../modules/commerce/application/register-http";
import {
  isUuid,
  validateCloseSessionInput,
  type CloseSessionInput
} from "../../../../../../modules/commerce/domain/register";
import { COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE,
  action: "create"
} as const;

const APPROVE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE,
  action: "approve"
} as const;

export const POST = defineTenantRoute<CloseSessionInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateCloseSessionInput(body, key.key)
    );
  },
  authorize: CREATE_GUARD,
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
    try {
      const outcome = await closeRegisterSession(
        tx,
        tenantId,
        auth.context.tenantUserId,
        params.id,
        prepared,
        async () =>
          (
            await authorizeInTransaction(
              tx,
              tenantId,
              tokenHash,
              now,
              APPROVE_GUARD
            )
          ).allowed,
        locals.correlationId
      );
      switch (outcome.kind) {
        case "not_found":
          return fail(404, "RESOURCE_NOT_FOUND", "Register session not found.");
        case "session_not_open":
          return fail(
            409,
            "REGISTER_SESSION_NOT_OPEN",
            "The session is not open and cannot be closed.",
            {},
            { status: outcome.status }
          );
        case "not_session_cashier":
          return fail(
            409,
            "NOT_SESSION_CASHIER",
            "Only the session's current cashier may close it."
          );
        case "missing_count":
          return fail(
            400,
            "VALIDATION_ERROR",
            "A counted amount is required for every tender with activity.",
            {},
            outcome.tenderTypes.map((tenderType) => ({
              field: `counted.${tenderType}`,
              message: `counted.${tenderType} is required.`
            }))
          );
        case "variance_reason_required":
          return fail(
            400,
            "VALIDATION_ERROR",
            "A variance reason is required when the count differs from the expected amount.",
            {},
            [
              {
                field: "varianceReason",
                message:
                  "varianceReason is required when the count differs from the expected amount."
              }
            ]
          );
        default:
          // `closed`, `pending_approval` and `replayed` all answer 200 with
          // the stored/derived body.
          return ok(outcome.body);
      }
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
