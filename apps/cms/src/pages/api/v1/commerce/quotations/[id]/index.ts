/**
 * `GET /api/v1/commerce/quotations/{id}` — one quotation with every version
 * (lines, totals, validity, pricing context, content hash) - Issue #286,
 * ADR-0029. Gated on `commerce.quotations.read` and the `documents` feature.
 * An unknown id and another tenant's id are the same `404`.
 */
import { ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { fetchQuotation } from "../../../../../../modules/commerce/application/quotation-directory";
import {
  notFoundResponse,
  requireDocumentsFeature,
  requireUuidParam
} from "../../../../../../modules/commerce/application/documents-http";
import { COMMERCE_QUOTATIONS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_QUOTATIONS_ACTIVITY_CODE,
  action: "read"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params, now }) => {
    const gate = await requireDocumentsFeature(tx, tenantId);
    if (gate) return gate;
    const bad = requireUuidParam(params.id, "Quotation");
    if (bad) return bad;
    const quotation = await fetchQuotation(tx, tenantId, params.id!, now);
    return quotation ? ok(quotation) : notFoundResponse("Quotation");
  }
});
