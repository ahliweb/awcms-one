/**
 * `GET|POST /api/v1/commerce/quotations` — quotations (Issue #286, epic #281
 * and #280, ADR-0029). `GET` (`commerce.quotations.read`) is the keyset list,
 * newest first, filterable by `status` (a `sent` quotation past its validity
 * reads and filters as `expired`). `POST` (`commerce.quotations.create`,
 * requires `Idempotency-Key`) creates a quotation: the lines are priced by the
 * ordinary quote engine for the named customer's tier and frozen into version 1
 * with a validity period; no stock is reserved. Both are gated on the tenant's
 * `documents` feature.
 */
import { created, fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../modules/_shared/keyset-pagination";
import { mediaLibraryPortAdapter } from "../../../../../modules/media-library/application/media-library-port-adapter";
import {
  createQuotation,
  listQuotations,
  QuotationCartError,
  type QuotationListFilters
} from "../../../../../modules/commerce/application/quotation-directory";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireDocumentsFeature,
  requireIdempotencyKey
} from "../../../../../modules/commerce/application/documents-http";
import {
  QUOTATION_STATUSES,
  validateCreateQuotationInput,
  type CreateQuotationInput,
  type QuotationStatus
} from "../../../../../modules/commerce/domain/documents";
import { COMMERCE_QUOTATIONS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_QUOTATIONS_ACTIVITY_CODE,
  action: "read"
} as const;

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_QUOTATIONS_ACTIVITY_CODE,
  action: "create"
} as const;

type PreparedList = {
  cursor: KeysetCursor | null;
  filters: QuotationListFilters;
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
    const filters: QuotationListFilters = {};
    const status = url.searchParams.get("status");
    if (status) {
      if (!(QUOTATION_STATUSES as readonly string[]).includes(status)) {
        return fail(
          400,
          "VALIDATION_ERROR",
          `status must be one of: ${QUOTATION_STATUSES.join(", ")}.`
        );
      }
      filters.status = status as QuotationStatus;
    }
    return { cursor, filters };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared, now }) => {
    const gate = await requireDocumentsFeature(tx, tenantId);
    if (gate) return gate;
    return ok(
      await listQuotations(tx, tenantId, prepared.cursor, prepared.filters, now)
    );
  }
});

export const POST = defineTenantRoute<CreateQuotationInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateCreateQuotationInput(body, key.key)
    );
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, now, locals }) => {
    const gate = await requireDocumentsFeature(tx, tenantId);
    if (gate) return gate;
    try {
      const outcome = await createQuotation(
        tx,
        tenantId,
        auth.context.tenantUserId,
        mediaLibraryPortAdapter,
        prepared,
        now,
        locals.correlationId
      );
      if (outcome.kind === "invalid_phone") {
        return fail(
          400,
          "VALIDATION_ERROR",
          "customer.phone is not a valid Indonesian phone number.",
          {},
          [
            {
              field: "customer.phone",
              message: "customer.phone is not a valid Indonesian phone number."
            }
          ]
        );
      }
      return created(outcome.quotation);
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
