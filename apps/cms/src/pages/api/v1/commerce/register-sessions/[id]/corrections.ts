/**
 * `POST /api/v1/commerce/register-sessions/{id}/corrections` — post a
 * compensating correction to a CLOSED session (Issue #284, ADR-0028). Gated on
 * `commerce.register_corrections.approve` (a high-risk verb); requires
 * `Idempotency-Key`. A closed session is immutable: this does not edit the
 * close, it adds signed per-tender adjustments to the COUNTED amount (the
 * original close request and lines are preserved untouched), moves the session
 * `closed -> corrected`, and returns the report with the corrected figures. A
 * correction can never drive a counted amount negative, and only a closed (or
 * already corrected) session can be corrected.
 */
import { created, fail } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { recordRegisterCorrection } from "../../../../../../modules/commerce/application/register-cash-up";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireIdempotencyKey,
  requireRegisterFeature
} from "../../../../../../modules/commerce/application/register-http";
import {
  isUuid,
  validateRecordCorrectionInput,
  type RecordCorrectionInput
} from "../../../../../../modules/commerce/domain/register";
import { COMMERCE_REGISTER_CORRECTIONS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const APPROVE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REGISTER_CORRECTIONS_ACTIVITY_CODE,
  action: "approve"
} as const;

export const POST = defineTenantRoute<RecordCorrectionInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateRecordCorrectionInput(body, key.key)
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
      const outcome = await recordRegisterCorrection(
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
        case "session_not_closed":
          return fail(
            409,
            "REGISTER_SESSION_NOT_CLOSED",
            "Only a closed session can be corrected.",
            {},
            { status: outcome.status }
          );
        case "negative_count":
          return fail(
            400,
            "VALIDATION_ERROR",
            "The correction would make a counted amount negative.",
            {},
            [
              {
                field: "adjustments",
                message: `The correction would make the counted ${outcome.tenderType} amount negative.`
              }
            ]
          );
        default:
          return created(outcome.report);
      }
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
