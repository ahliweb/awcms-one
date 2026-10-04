import {
  created,
  fail,
  jsonResponse
} from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { IdempotencyRaceLostError } from "../../../../../../../modules/_shared/idempotency";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../../../modules/commerce/application/commerce-feature-gate";
import {
  LoyaltyIdempotencyConflictError,
  redeemPoints
} from "../../../../../../../modules/commerce/application/loyalty-ledger";
import { parseCustomerIdParam } from "../../../../../../../modules/commerce/application/loyalty-route-support";
import { COMMERCE_LOYALTY_REDEMPTIONS_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";
import {
  validateIdempotencyKeyHeader,
  validateRedeemInput,
  type RedeemInput
} from "../../../../../../../modules/commerce/domain/loyalty-validation";

/**
 * `POST /api/v1/commerce/loyalty/accounts/{customerId}/redeem` (Issue #289) —
 * spends a customer's points, from the counter or on their behalf. Requires an
 * `Idempotency-Key`; runs under the account row lock so concurrent
 * redemptions cannot overdraw (`409 INSUFFICIENT_POINTS` for the one that
 * would). This PR records the points debit only — turning points into a
 * discount at checkout needs #285's tender model (ADR-0026 Deferred).
 */
const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_LOYALTY_REDEMPTIONS_ACTIVITY_CODE,
  action: "create"
} as const;

type Prepared = RedeemInput & { idempotencyKey: string };

export const POST = defineTenantRoute<Prepared>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<Prepared | Response> => {
    const key = validateIdempotencyKeyHeader(
      request.headers.get("idempotency-key")
    );
    if (!key.valid) {
      return fail(
        400,
        "IDEMPOTENCY_REQUIRED",
        "A valid Idempotency-Key header is required.",
        {},
        key.errors
      );
    }

    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateRedeemInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Redemption input is invalid.",
        {},
        validation.errors
      );
    }
    return { ...validation.value, idempotencyKey: key.value };
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, now, locals }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "loyalty"
    );
    if (gate) return gate;

    const customerId = parseCustomerIdParam(params.customerId);
    if (customerId instanceof Response) return customerId;

    try {
      const outcome = await redeemPoints(
        tx,
        tenantId,
        auth.context.tenantUserId,
        {
          customerId,
          points: prepared.points,
          reason: prepared.reason,
          idempotencyKey: prepared.idempotencyKey
        },
        now,
        locals.correlationId
      );

      if (outcome.kind === "customer_not_found") {
        return fail(404, "RESOURCE_NOT_FOUND", "Customer not found.");
      }
      if (outcome.kind === "insufficient") {
        return fail(
          409,
          "INSUFFICIENT_POINTS",
          "The customer does not have enough points.",
          {},
          { balance: outcome.balance, requested: outcome.requested }
        );
      }
      // `redeemed` and `replayed` answer the same 201 body: a replay is a
      // client retry, not a second redemption.
      return created({ entry: outcome.entry, balance: outcome.balance });
    } catch (error) {
      if (error instanceof LoyaltyIdempotencyConflictError) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
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
      throw error;
    }
  }
});
