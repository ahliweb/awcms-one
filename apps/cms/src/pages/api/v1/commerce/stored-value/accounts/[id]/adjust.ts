/**
 * `POST /api/v1/commerce/stored-value/accounts/{id}/adjust` — a reasoned manual
 * correction of a balance, up or down (Issue #288, ADR-0030). Gated on the
 * SEPARATE `commerce.stored_value_adjustments.create` permission (a role that
 * may sell a card is not thereby trusted to edit a balance by hand) and the
 * `storedValue` feature; requires `Idempotency-Key` and a mandatory `reason`.
 * The ledger is append-only: this is a NEW `adjust` entry, never an edit. A
 * downward adjustment can never take the balance below zero (`409
 * STORED_VALUE_INSUFFICIENT`); an expired account takes no entry at all.
 */
import { fail } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { adjustStoredValueAccount } from "../../../../../../../modules/commerce/application/stored-value-directory";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireIdempotencyKey
} from "../../../../../../../modules/commerce/application/register-http";
import {
  accountMutationResponse,
  requireStoredValueFeature
} from "../../../../../../../modules/commerce/application/stored-value-http";
import { COMMERCE_STORED_VALUE_ADJUSTMENTS_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";
import {
  isUuid,
  validateAdjustAccountInput,
  type AdjustAccountInput
} from "../../../../../../../modules/commerce/domain/stored-value";

export const POST = defineTenantRoute<AdjustAccountInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateAdjustAccountInput(body, key.key)
    );
  },
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_STORED_VALUE_ADJUSTMENTS_ACTIVITY_CODE,
    action: "create"
  },
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const gate = await requireStoredValueFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Account not found.");
    }
    try {
      return accountMutationResponse(
        await adjustStoredValueAccount(
          tx,
          tenantId,
          auth.context.tenantUserId,
          params.id,
          prepared,
          locals.correlationId
        )
      );
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
