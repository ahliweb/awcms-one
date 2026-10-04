/**
 * `GET|POST /api/v1/commerce/documents` — numbered, immutable receipt and
 * invoice documents (Issue #286, ADR-0029). `GET` (`commerce.documents.read`)
 * is the keyset list, newest first, filterable by `docType` and `orderId`.
 * `POST` (`commerce.documents.create`, requires `Idempotency-Key`) ISSUES a
 * document for a finalized order: an immutable snapshot with the next gapless
 * `RCP-` / `INV-<year>-<counter>` number, whose money is verified equal to the
 * order's. One receipt and one invoice per order - issuing again answers `200`
 * with the existing document (`alreadyIssued: true`). An invoice needs an order
 * that took effect (`409 ORDER_NOT_FINAL` for a cancelled or expired one); a
 * receipt additionally needs it fully paid (`409 ORDER_NOT_PAID`). Both are
 * gated on the tenant's `documents` feature.
 */
import { created, fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../modules/_shared/keyset-pagination";
import { mediaLibraryPortAdapter } from "../../../../../modules/media-library/application/media-library-port-adapter";
import {
  issueDocument,
  listDocuments,
  type DocumentListFilters
} from "../../../../../modules/commerce/application/document-directory";
import {
  idempotencyErrorResponse,
  notFoundResponse,
  readValidatedBody,
  requireDocumentsFeature,
  requireIdempotencyKey
} from "../../../../../modules/commerce/application/documents-http";
import {
  isUuid,
  ISSUED_DOCUMENT_TYPES,
  validateIssueDocumentInput,
  type IssueDocumentInput,
  type IssuedDocumentType
} from "../../../../../modules/commerce/domain/documents";
import { COMMERCE_DOCUMENTS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_DOCUMENTS_ACTIVITY_CODE,
  action: "read"
} as const;

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_DOCUMENTS_ACTIVITY_CODE,
  action: "create"
} as const;

type PreparedList = {
  cursor: KeysetCursor | null;
  filters: DocumentListFilters;
};

export const GET = defineTenantRoute<PreparedList>({
  workClass: "interactive",
  prepare: ({ url }): PreparedList | Response => {
    const cursorParam = url.searchParams.get("cursor");
    let cursor: KeysetCursor | null = null;
    if (cursorParam) {
      const decoded = decodeKeysetCursor(cursorParam);
      if (!decoded)
        return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
      cursor = decoded;
    }
    const filters: DocumentListFilters = {};
    const docType = url.searchParams.get("docType");
    if (docType) {
      if (!(ISSUED_DOCUMENT_TYPES as readonly string[]).includes(docType)) {
        return fail(
          400,
          "VALIDATION_ERROR",
          `docType must be one of: ${ISSUED_DOCUMENT_TYPES.join(", ")}.`
        );
      }
      filters.docType = docType as IssuedDocumentType;
    }
    const orderId = url.searchParams.get("orderId");
    if (orderId) {
      if (!isUuid(orderId)) {
        return fail(400, "VALIDATION_ERROR", "orderId must be a UUID.");
      }
      filters.orderId = orderId;
    }
    return { cursor, filters };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireDocumentsFeature(tx, tenantId);
    if (gate) return gate;
    return ok(
      await listDocuments(tx, tenantId, prepared.cursor, prepared.filters)
    );
  }
});

export const POST = defineTenantRoute<IssueDocumentInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateIssueDocumentInput(body, key.key)
    );
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, now, locals }) => {
    const gate = await requireDocumentsFeature(tx, tenantId);
    if (gate) return gate;
    try {
      const outcome = await issueDocument(
        tx,
        tenantId,
        auth.context.tenantUserId,
        mediaLibraryPortAdapter,
        prepared,
        now,
        locals.correlationId
      );
      switch (outcome.kind) {
        case "order_not_found":
          return notFoundResponse("Order");
        case "not_eligible":
          return fail(
            409,
            outcome.reason,
            outcome.reason === "ORDER_NOT_PAID"
              ? "A receipt needs a fully paid order."
              : "A cancelled or expired order cannot be documented."
          );
        case "replayed":
          return created(outcome.document);
        default:
          return outcome.alreadyIssued
            ? ok({ ...outcome.document, alreadyIssued: true })
            : created(outcome.document);
      }
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
