/**
 * `GET /api/v1/commerce/documents/{id}` — one stored document with its
 * immutable snapshot and content hash (Issue #286, ADR-0029). Gated on
 * `commerce.documents.read` and the `documents` feature. An unknown id and
 * another tenant's id are the same `404`.
 */
import { ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { fetchDocument } from "../../../../../../modules/commerce/application/document-directory";
import {
  notFoundResponse,
  requireDocumentsFeature,
  requireUuidParam
} from "../../../../../../modules/commerce/application/documents-http";
import { COMMERCE_DOCUMENTS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_DOCUMENTS_ACTIVITY_CODE,
  action: "read"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireDocumentsFeature(tx, tenantId);
    if (gate) return gate;
    const bad = requireUuidParam(params.id, "Document");
    if (bad) return bad;
    const document = await fetchDocument(tx, tenantId, params.id!);
    return document ? ok(document) : notFoundResponse("Document");
  }
});
