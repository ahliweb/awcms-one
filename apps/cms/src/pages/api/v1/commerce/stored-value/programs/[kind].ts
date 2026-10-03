/**
 * `PUT /api/v1/commerce/stored-value/programs/{kind}` — create or update one
 * kind's program (`gift_card` | `store_credit`): enabled, default expiry in
 * days, whether a payment made with it may be refunded back to the account,
 * and an optional balance ceiling (Issue #288, ADR-0029). Gated on
 * `commerce.stored_value_programs.update` and the `storedValue` feature. An
 * idempotent PUT by nature (the same body leaves the same row), so it takes no
 * `Idempotency-Key`; every change is audited. `enabled` governs ISSUING and
 * LOADING only — value already outstanding stays redeemable when a program is
 * switched off, because it is owed.
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { upsertStoredValueProgram } from "../../../../../../modules/commerce/application/stored-value-directory";
import { readValidatedBody } from "../../../../../../modules/commerce/application/register-http";
import { requireStoredValueFeature } from "../../../../../../modules/commerce/application/stored-value-http";
import { COMMERCE_STORED_VALUE_PROGRAMS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";
import {
  isStoredValueKind,
  validateUpsertProgramInput,
  type UpsertProgramInput
} from "../../../../../../modules/commerce/domain/stored-value";

export const PUT = defineTenantRoute<UpsertProgramInput>({
  workClass: "interactive",
  prepare: ({ request }) =>
    readValidatedBody(request, validateUpsertProgramInput),
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_STORED_VALUE_PROGRAMS_ACTIVITY_CODE,
    action: "update"
  },
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const gate = await requireStoredValueFeature(tx, tenantId);
    if (gate) return gate;
    if (!isStoredValueKind(params.kind)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Program not found.");
    }
    return ok(
      await upsertStoredValueProgram(
        tx,
        tenantId,
        auth.context.tenantUserId,
        params.kind,
        prepared,
        locals.correlationId
      )
    );
  }
});
