/**
 * `POST /api/v1/commerce/stored-value/accounts/{id}/status` — disable or
 * re-enable an account (Issue #288, ADR-0029). A disabled account refuses every
 * redemption and refund but keeps its balance (still a liability); it is the
 * remedy for a lost or stolen card. `expired` is terminal and is never set by
 * hand. Gated on `commerce.stored_value.update` and the `storedValue` feature;
 * requires `Idempotency-Key`; disabling requires a `reason`. Recorded as a
 * zero-amount `disable` / `enable` ledger entry so the history shows when and
 * by whom.
 */
import { fail } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { changeStoredValueAccountStatus } from "../../../../../../../modules/commerce/application/stored-value-directory";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireIdempotencyKey
} from "../../../../../../../modules/commerce/application/register-http";
import {
  accountMutationResponse,
  requireStoredValueFeature
} from "../../../../../../../modules/commerce/application/stored-value-http";
import { COMMERCE_STORED_VALUE_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";
import {
  isUuid,
  validateChangeStatusInput,
  type ChangeStatusInput
} from "../../../../../../../modules/commerce/domain/stored-value";

export const POST = defineTenantRoute<ChangeStatusInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateChangeStatusInput(body, key.key)
    );
  },
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_STORED_VALUE_ACTIVITY_CODE,
    action: "update"
  },
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const gate = await requireStoredValueFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Account not found.");
    }
    try {
      return accountMutationResponse(
        await changeStoredValueAccountStatus(
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
