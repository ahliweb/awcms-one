/**
 * `POST /api/v1/commerce/held-sales/{id}/discard` — throw a parked cart away
 * (Issue #286, ADR-0029). Same guard, ownership rule, idempotency and error
 * mapping as `resume`; the cart is wiped and not returned.
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { discardHeldSale } from "../../../../../../modules/commerce/application/held-sale-directory";
import {
  heldSaleSupervisorCheck,
  idempotencyErrorResponse,
  notFoundResponse,
  readValidatedBody,
  requireDocumentsFeature,
  requireIdempotencyKey,
  requireUuidParam
} from "../../../../../../modules/commerce/application/documents-http";
import {
  validateHeldSaleDecisionInput,
  type HeldSaleDecisionInput
} from "../../../../../../modules/commerce/domain/documents";
import { COMMERCE_HELD_SALES_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_HELD_SALES_ACTIVITY_CODE,
  action: "update"
} as const;

export const POST = defineTenantRoute<HeldSaleDecisionInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateHeldSaleDecisionInput(body, key.key)
    );
  },
  authorize: UPDATE_GUARD,
  handler: async ({
    tx,
    tenantId,
    auth,
    params,
    prepared,
    tokenHash,
    now,
    locals
  }) => {
    const gate = await requireDocumentsFeature(tx, tenantId);
    if (gate) return gate;
    const bad = requireUuidParam(params.id, "Held sale");
    if (bad) return bad;
    try {
      const outcome = await discardHeldSale(
        tx,
        tenantId,
        auth.context.tenantUserId,
        heldSaleSupervisorCheck({ tx, tenantId, tokenHash, now }),
        params.id!,
        prepared,
        now,
        locals.correlationId
      );
      switch (outcome.kind) {
        case "not_found":
          return notFoundResponse("Held sale");
        case "expired":
          return fail(409, "HELD_SALE_EXPIRED", "The held sale has expired.");
        case "not_held":
          return fail(
            409,
            "HELD_SALE_NOT_HELD",
            "The held sale was already resumed or discarded.",
            {},
            { status: outcome.status }
          );
        default:
          return ok(outcome.heldSale);
      }
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
