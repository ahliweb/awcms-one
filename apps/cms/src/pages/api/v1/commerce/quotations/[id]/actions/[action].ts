/**
 * `POST /api/v1/commerce/quotations/{id}/actions/{action}` — move a quotation
 * through its lifecycle: `send` (draft -> sent), `accept` (sent -> accepted,
 * pinning the current version), `reject` (sent -> rejected), `cancel`
 * (draft | sent | accepted -> cancelled) - Issue #286, ADR-0029. Gated on
 * `commerce.quotations.update` and the `documents` feature; requires
 * `Idempotency-Key`. Accepting an offer whose validity has passed is `409
 * QUOTATION_EXPIRED` (and the expiry is persisted); any other illegal move is
 * `409 QUOTATION_STATUS_CONFLICT`. An unknown action is a `404`.
 */
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { applyQuotationAction } from "../../../../../../../modules/commerce/application/quotation-directory";
import {
  idempotencyErrorResponse,
  notFoundResponse,
  readValidatedBody,
  requireDocumentsFeature,
  requireIdempotencyKey,
  requireUuidParam
} from "../../../../../../../modules/commerce/application/documents-http";
import {
  QUOTATION_ACTIONS,
  validateQuotationActionInput,
  type QuotationAction,
  type QuotationActionInput
} from "../../../../../../../modules/commerce/domain/documents";
import { COMMERCE_QUOTATIONS_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_QUOTATIONS_ACTIVITY_CODE,
  action: "update"
} as const;

export const POST = defineTenantRoute<QuotationActionInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateQuotationActionInput(body, key.key)
    );
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, now, locals }) => {
    const gate = await requireDocumentsFeature(tx, tenantId);
    if (gate) return gate;
    const bad = requireUuidParam(params.id, "Quotation");
    if (bad) return bad;
    if (
      !(QUOTATION_ACTIONS as readonly string[]).includes(params.action ?? "")
    ) {
      return notFoundResponse("Action");
    }
    try {
      const outcome = await applyQuotationAction(
        tx,
        tenantId,
        auth.context.tenantUserId,
        params.id!,
        params.action as QuotationAction,
        prepared,
        now,
        locals.correlationId
      );
      switch (outcome.kind) {
        case "not_found":
          return notFoundResponse("Quotation");
        case "expired":
          return fail(
            409,
            "QUOTATION_EXPIRED",
            "The quotation's validity period has passed; revise it to offer again."
          );
        case "illegal":
          return fail(
            409,
            "QUOTATION_STATUS_CONFLICT",
            "That action is not allowed in the quotation's current status.",
            {},
            { status: outcome.status }
          );
        default:
          return ok(outcome.quotation);
      }
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
