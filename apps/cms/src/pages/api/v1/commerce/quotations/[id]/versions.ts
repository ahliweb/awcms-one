/**
 * `POST /api/v1/commerce/quotations/{id}/versions` — add a revised version to
 * a quotation (Issue #286, ADR-0029). Gated on `commerce.quotations.create`
 * and the `documents` feature; requires `Idempotency-Key`. The new lines are
 * re-priced and frozen as version N+1 with their own validity; earlier versions
 * are never edited, and the quotation returns to `draft` (a revised offer must
 * be sent and accepted again). Allowed from `draft`, `sent` and `expired`;
 * otherwise `409 QUOTATION_NOT_REVISABLE`.
 */
import { created, fail } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { mediaLibraryPortAdapter } from "../../../../../../modules/media-library/application/media-library-port-adapter";
import {
  QuotationCartError,
  reviseQuotation
} from "../../../../../../modules/commerce/application/quotation-directory";
import {
  idempotencyErrorResponse,
  notFoundResponse,
  readValidatedBody,
  requireDocumentsFeature,
  requireIdempotencyKey,
  requireUuidParam
} from "../../../../../../modules/commerce/application/documents-http";
import {
  validateReviseQuotationInput,
  type ReviseQuotationInput
} from "../../../../../../modules/commerce/domain/documents";
import { COMMERCE_QUOTATIONS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_QUOTATIONS_ACTIVITY_CODE,
  action: "create"
} as const;

export const POST = defineTenantRoute<ReviseQuotationInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateReviseQuotationInput(body, key.key)
    );
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, now, locals }) => {
    const gate = await requireDocumentsFeature(tx, tenantId);
    if (gate) return gate;
    const bad = requireUuidParam(params.id, "Quotation");
    if (bad) return bad;
    try {
      const outcome = await reviseQuotation(
        tx,
        tenantId,
        auth.context.tenantUserId,
        mediaLibraryPortAdapter,
        params.id!,
        prepared,
        now,
        locals.correlationId
      );
      switch (outcome.kind) {
        case "not_found":
          return notFoundResponse("Quotation");
        case "not_revisable":
          return fail(
            409,
            "QUOTATION_NOT_REVISABLE",
            "Only a draft, sent or expired quotation can be revised.",
            {},
            { status: outcome.status }
          );
        default:
          return created(outcome.quotation);
      }
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      if (error instanceof QuotationCartError) {
        return fail(
          409,
          "CART_CHANGED",
          "One or more lines cannot be priced right now; re-check the lines.",
          {},
          { quote: error.quote }
        );
      }
      throw error;
    }
  }
});
