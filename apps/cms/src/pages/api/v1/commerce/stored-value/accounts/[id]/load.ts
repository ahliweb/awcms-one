/**
 * `POST /api/v1/commerce/stored-value/accounts/{id}/load` — add value to an
 * existing account (a top-up) (Issue #288, ADR-0030). Gated on
 * `commerce.stored_value.create` and the `storedValue` feature; requires
 * `Idempotency-Key` (a replay returns the original entry and never loads
 * twice). Refused when the program is not enabled, the account is disabled or
 * expired, or the balance would pass the program's ceiling.
 */
import { fail } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { loadStoredValueAccount } from "../../../../../../../modules/commerce/application/stored-value-directory";
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
  validateLoadAccountInput,
  type LoadAccountInput
} from "../../../../../../../modules/commerce/domain/stored-value";

export const POST = defineTenantRoute<LoadAccountInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateLoadAccountInput(body, key.key)
    );
  },
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_STORED_VALUE_ACTIVITY_CODE,
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
        await loadStoredValueAccount(
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
