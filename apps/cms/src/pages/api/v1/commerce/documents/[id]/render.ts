/**
 * `GET /api/v1/commerce/documents/{id}/render?format=json|text|html&locale=id|en`
 * — the print / export / digital-delivery render contract (Issue #286,
 * ADR-0029 D7). Gated on `commerce.documents.read` and the `documents`
 * feature. The render is a pure function of the STORED snapshot: reprinting
 * never mutates the document, and the snapshot's SHA-256 is re-verified first
 * (`409 DOCUMENT_INTEGRITY_FAILURE` instead of printing a snapshot that no
 * longer matches its hash). `json` is the snapshot envelope; `text` is a
 * 42-column plain-text receipt (printer / message body); `html` is a
 * self-contained print-ready page served under a locked-down CSP (no script,
 * no external resource) with `Content-Disposition: inline`. Every render is
 * audited. Delivery itself (e-mail / WhatsApp / push) is a separate port that
 * consumes this contract; it is deferred (ADR-0029).
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { renderStoredDocument } from "../../../../../../modules/commerce/application/document-directory";
import {
  notFoundResponse,
  requireDocumentsFeature,
  requireUuidParam
} from "../../../../../../modules/commerce/application/documents-http";
import {
  DOCUMENT_RENDER_FORMATS,
  DOCUMENT_RENDER_LOCALES,
  type DocumentRenderFormat,
  type DocumentRenderLocale
} from "../../../../../../modules/commerce/domain/documents";
import { COMMERCE_DOCUMENTS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_DOCUMENTS_ACTIVITY_CODE,
  action: "read"
} as const;

type PreparedRender = {
  format: DocumentRenderFormat;
  locale: DocumentRenderLocale;
};

const COMMON_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff"
} as const;

export const GET = defineTenantRoute<PreparedRender>({
  workClass: "interactive",
  prepare: ({ url }): PreparedRender | Response => {
    const format = url.searchParams.get("format") ?? "json";
    if (!(DOCUMENT_RENDER_FORMATS as readonly string[]).includes(format)) {
      return fail(
        400,
        "VALIDATION_ERROR",
        `format must be one of: ${DOCUMENT_RENDER_FORMATS.join(", ")}.`
      );
    }
    const locale = url.searchParams.get("locale") ?? "id";
    if (!(DOCUMENT_RENDER_LOCALES as readonly string[]).includes(locale)) {
      return fail(
        400,
        "VALIDATION_ERROR",
        `locale must be one of: ${DOCUMENT_RENDER_LOCALES.join(", ")}.`
      );
    }
    return {
      format: format as DocumentRenderFormat,
      locale: locale as DocumentRenderLocale
    };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const gate = await requireDocumentsFeature(tx, tenantId);
    if (gate) return gate;
    const bad = requireUuidParam(params.id, "Document");
    if (bad) return bad;
    const outcome = await renderStoredDocument(
      tx,
      tenantId,
      auth.context.tenantUserId,
      params.id!,
      prepared.format,
      prepared.locale,
      locals.correlationId
    );
    switch (outcome.kind) {
      case "not_found":
        return notFoundResponse("Document");
      case "integrity_failure":
        return fail(
          409,
          "DOCUMENT_INTEGRITY_FAILURE",
          "The stored document no longer matches its content hash and cannot be rendered."
        );
      default:
        if (outcome.format === "json") return ok(outcome.document);
        return new Response(outcome.body, {
          status: 200,
          headers: {
            ...COMMON_HEADERS,
            "content-type":
              outcome.format === "html"
                ? "text/html; charset=utf-8"
                : "text/plain; charset=utf-8",
            "content-disposition": "inline",
            // The HTML page is inline-styled and script-free by construction;
            // the CSP makes that a property the browser enforces too.
            ...(outcome.format === "html"
              ? {
                  "content-security-policy":
                    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
                }
              : {})
          }
        });
    }
  }
});
