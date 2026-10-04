/**
 * `GET|PUT /api/v1/commerce/barcodes` - the barcode catalogue and assignment
 * (Issue #292, ADR-0032). `GET` (`commerce.barcodes.read`) pages the products
 * (without variants) and variants of the tenant with their barcode, filterable
 * by `q` and `barcode=with|without`. `PUT` (`commerce.barcodes.update`) sets
 * or clears the barcode of one product or variant; a code held by another live
 * row of the tenant is a `409 BARCODE_DUPLICATE`. Both are gated on the
 * tenant's `barcode` feature. `PUT` is naturally idempotent (it SETS state), so
 * it carries no `Idempotency-Key`.
 */
import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  assignBarcode,
  DuplicateBarcodeError,
  listBarcodeCatalog,
  type BarcodeCatalogFilters
} from "../../../../../modules/commerce/application/barcode-directory";
import {
  BARCODE_READ_GUARD,
  BARCODE_UPDATE_GUARD,
  requireBarcodeFeature
} from "../../../../../modules/commerce/application/barcode-http";
import { readValidatedBody } from "../../../../../modules/commerce/application/register-http";
import {
  validateAssignBarcodeInput,
  type AssignBarcodeInput
} from "../../../../../modules/commerce/domain/barcode";

export const GET = defineTenantRoute<BarcodeCatalogFilters>({
  workClass: "interactive",
  prepare: ({ url }): BarcodeCatalogFilters | Response => {
    const q = url.searchParams.get("q") ?? undefined;
    if (q !== undefined && q.length > 100) {
      return fail(400, "VALIDATION_ERROR", "q must be at most 100 characters.");
    }
    const barcode = url.searchParams.get("barcode");
    if (barcode !== null && barcode !== "with" && barcode !== "without") {
      return fail(400, "VALIDATION_ERROR", "barcode must be with or without.");
    }
    const pageParam = url.searchParams.get("page");
    let page = 0;
    if (pageParam !== null) {
      if (!/^\d{1,5}$/.test(pageParam)) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "page must be a non-negative integer."
        );
      }
      page = Number.parseInt(pageParam, 10);
    }
    return { q, barcode: barcode ?? undefined, page };
  },
  authorize: BARCODE_READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireBarcodeFeature(tx, tenantId);
    if (gate) return gate;
    return ok(await listBarcodeCatalog(tx, tenantId, prepared));
  }
});

export const PUT = defineTenantRoute<AssignBarcodeInput>({
  workClass: "interactive",
  prepare: ({ request }) =>
    readValidatedBody(request, validateAssignBarcodeInput),
  authorize: BARCODE_UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const gate = await requireBarcodeFeature(tx, tenantId);
    if (gate) return gate;
    try {
      const outcome = await assignBarcode(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared.target,
        prepared.code,
        locals.correlationId
      );
      if (outcome.kind === "not_found") {
        return fail(404, "RESOURCE_NOT_FOUND", "Product or variant not found.");
      }
      return ok(outcome.row);
    } catch (error) {
      if (error instanceof DuplicateBarcodeError) {
        return fail(409, "BARCODE_DUPLICATE", error.message);
      }
      throw error;
    }
  }
});
