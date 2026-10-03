/**
 * `GET /api/v1/commerce/barcodes/lookup?code=` - resolve a scanned barcode to
 * the ONE product or variant it names in the caller's tenant (Issue #292,
 * ADR-0032). Gated on `commerce.barcodes.read` and the tenant's `barcode`
 * feature. An unknown, soft-deleted and other-tenant code answer the same
 * neutral `404` (no oracle); a malformed code is a `400` before any query.
 * A barcode is an identifier, not a credential: the caller is authorised first.
 */
import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { lookupBarcode } from "../../../../../modules/commerce/application/barcode-directory";
import {
  BARCODE_READ_GUARD,
  requireBarcodeFeature
} from "../../../../../modules/commerce/application/barcode-http";
import {
  barcodeInvalidMessage,
  BARCODE_MAX_LENGTH
} from "../../../../../modules/commerce/domain/barcode";

const LOOKUP_CODE = /^[\x21-\x7E]+$/;

export const GET = defineTenantRoute<string>({
  workClass: "interactive",
  prepare: ({ url }): string | Response => {
    const code = (url.searchParams.get("code") ?? "").trim();
    if (code.length === 0) {
      return fail(400, "VALIDATION_ERROR", "code is required.");
    }
    if (code.length > BARCODE_MAX_LENGTH || !LOOKUP_CODE.test(code)) {
      return fail(
        400,
        "VALIDATION_ERROR",
        barcodeInvalidMessage(
          code.length > BARCODE_MAX_LENGTH ? "too_long" : "bad_characters"
        )
      );
    }
    return code;
  },
  authorize: BARCODE_READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireBarcodeFeature(tx, tenantId);
    if (gate) return gate;
    const found = await lookupBarcode(tx, tenantId, prepared);
    return found
      ? ok(found)
      : fail(404, "RESOURCE_NOT_FOUND", "Barcode not found.");
  }
});
