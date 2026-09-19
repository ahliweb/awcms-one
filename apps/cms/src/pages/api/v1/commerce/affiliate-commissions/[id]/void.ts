import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../modules/_shared/idempotency";
import {
  voidAffiliateCommission,
  InvalidCommissionTransitionError
} from "../../../../../../modules/commerce/application/affiliate-directory";
import { COMMERCE_AFFILIATE_COMMISSIONS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const IDEMPOTENCY_SCOPE = "commerce_affiliate_commission_void";

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_AFFILIATE_COMMISSIONS_ACTIVITY_CODE,
  action: "update"
} as const;

type Prepared = { idempotencyKey: string };

/** `POST /api/v1/commerce/affiliate-commissions/{id}/void` — `pending|approved -> void` (Issue #92). High-risk mutation: requires `Idempotency-Key`. */
export const POST = defineTenantRoute<Prepared>({
  workClass: "interactive",
  prepare: ({ request }): Prepared | Response => {
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) {
      return fail(
        400,
        "IDEMPOTENCY_REQUIRED",
        "Idempotency-Key header is required."
      );
    }
    return { idempotencyKey };
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const commissionId = params.id;
    if (!commissionId) {
      return fail(400, "VALIDATION_ERROR", "id is required.");
    }

    const requestHash = computeRequestHash({ commissionId, action: "void" });

    const existing = await findIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      prepared.idempotencyKey
    );
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
      return jsonResponse(existing.responseBody, {
        status: existing.responseStatus
      });
    }

    try {
      const updated = await voidAffiliateCommission(
        tx,
        tenantId,
        auth.context.tenantUserId,
        commissionId,
        locals.correlationId
      );
      if (!updated) {
        return fail(404, "RESOURCE_NOT_FOUND", "Commission not found.");
      }

      const successResponse = ok(updated);
      const successBody = await successResponse.clone().json();
      await saveIdempotencyRecord(
        tx,
        tenantId,
        IDEMPOTENCY_SCOPE,
        prepared.idempotencyKey,
        requestHash,
        200,
        successBody
      );
      return successResponse;
    } catch (error) {
      if (error instanceof InvalidCommissionTransitionError) {
        return fail(409, "COMMISSION_ALREADY_FINAL", error.message);
      }
      throw error;
    }
  }
});
