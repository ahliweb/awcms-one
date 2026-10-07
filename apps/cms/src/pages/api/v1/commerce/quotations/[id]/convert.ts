/**
 * `POST /api/v1/commerce/quotations/{id}/convert` — turn an ACCEPTED quotation
 * into a commerce order (Issue #286, ADR-0029 D5). Gated on
 * `commerce.quotation_conversions.create`, the `documents` and `pos` features,
 * and — because the order is created with a balance due, exactly like a
 * credit sale — the second key `commerce.pos_due.create` (checked in the
 * handler through the same chokepoint the POS route uses). Requires
 * `Idempotency-Key`.
 *
 * The order is written by the ordinary POS order path, at TODAY's price and
 * stock. If its total differs from the accepted version's the whole request
 * rolls back and answers `409 QUOTATION_PRICE_CHANGED` with both totals, unless
 * the body carries `acceptPriceChange: true`. Converting an already converted
 * quotation (any key, any caller) answers `200` with the existing order and
 * `alreadyConverted: true`; a quotation that is not `accepted` is `409
 * QUOTATION_NOT_ACCEPTED`. Payment is taken afterwards through the payment
 * ledger (`POST /orders/{id}/payments`).
 */
import {
  created,
  fail,
  ok
} from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { mediaLibraryPortAdapter } from "../../../../../../modules/media-library/application/media-library-port-adapter";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../../modules/commerce/application/commerce-feature-gate";
import { authorizeInTransaction } from "../../../../../../modules/identity-access/application/access-guard";
import {
  convertQuotation,
  QuotationCartError
} from "../../../../../../modules/commerce/application/quotation-directory";
import {
  PosCartChangedError,
  PosDueRequiresCustomerError,
  PosRegisterSessionError
} from "../../../../../../modules/commerce/application/pos-directory";
import {
  idempotencyErrorResponse,
  notFoundResponse,
  readValidatedBody,
  requireDocumentsFeature,
  requireIdempotencyKey,
  requireUuidParam
} from "../../../../../../modules/commerce/application/documents-http";
import {
  validateConvertQuotationInput,
  type ConvertQuotationInput
} from "../../../../../../modules/commerce/domain/documents";
import { FeatureDisabledError } from "../../../../../../modules/commerce/domain/commerce-features";
import {
  COMMERCE_POS_DUE_ACTIVITY_CODE,
  COMMERCE_QUOTATION_CONVERSIONS_ACTIVITY_CODE
} from "../../../../../../modules/commerce/domain/commerce-permissions";
import { inventoryErrorResponse } from "../../../../../../modules/commerce/application/commerce-inventory-http";

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_QUOTATION_CONVERSIONS_ACTIVITY_CODE,
  action: "create"
} as const;

const DUE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_POS_DUE_ACTIVITY_CODE,
  action: "create"
} as const;

export const POST = defineTenantRoute<ConvertQuotationInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateConvertQuotationInput(body, key.key)
    );
  },
  authorize: CREATE_GUARD,
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
    const posGate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "pos"
    );
    if (posGate) return posGate;
    const bad = requireUuidParam(params.id, "Quotation");
    if (bad) return bad;
    const dueAuth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      DUE_GUARD
    );
    if (!dueAuth.allowed) return dueAuth.denied;

    try {
      const outcome = await convertQuotation(
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
        case "not_accepted":
          return fail(
            409,
            "QUOTATION_NOT_ACCEPTED",
            "Only an accepted quotation can be converted into an order.",
            {},
            { status: outcome.status }
          );
        case "invalid_phone":
          return fail(
            409,
            "QUOTATION_CUSTOMER_INVALID",
            "The quotation's customer cannot be used to create an order."
          );
        case "price_changed":
          return fail(
            409,
            "QUOTATION_PRICE_CHANGED",
            "The current price differs from the quoted price; resend with acceptPriceChange to accept it.",
            {},
            {
              quotedTotal: outcome.quotedTotal,
              currentTotal: outcome.currentTotal
            }
          );
        case "converted":
          return created(outcome.result);
        default:
          // `replayed`: a retry or an already-converted quotation - the same
          // order, never a second one.
          return ok(outcome.result);
      }
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      if (
        error instanceof PosCartChangedError ||
        error instanceof QuotationCartError
      ) {
        return fail(
          409,
          "CART_CHANGED",
          "One or more lines changed price/stock; re-check the quotation.",
          {},
          { quote: error.quote }
        );
      }
      if (error instanceof PosDueRequiresCustomerError) {
        return fail(
          409,
          "QUOTATION_CUSTOMER_INVALID",
          "The quotation's customer cannot be used to create an order."
        );
      }
      if (error instanceof FeatureDisabledError) {
        return fail(
          409,
          "FEATURE_DISABLED",
          `The "${error.feature}" feature is disabled for this tenant.`
        );
      }
      if (error instanceof PosRegisterSessionError) {
        switch (error.code) {
          case "REGISTER_REQUIRED":
            return fail(
              400,
              "VALIDATION_ERROR",
              "registerId is required while the register feature is on.",
              {},
              [
                {
                  field: "registerId",
                  message:
                    "registerId is required while the register feature is on."
                }
              ]
            );
          case "REGISTER_NOT_FOUND":
            return fail(404, "RESOURCE_NOT_FOUND", "Register not found.");
          case "REGISTER_SESSION_REQUIRED":
            return fail(
              409,
              "REGISTER_SESSION_REQUIRED",
              "The register has no open session; open one before converting."
            );
          case "REGISTER_SESSION_CLOSING":
            return fail(
              409,
              "REGISTER_SESSION_CLOSING",
              "The register's session is being closed and accepts no sales."
            );
          default:
            return fail(
              409,
              "NOT_SESSION_CASHIER",
              "The register's session belongs to another cashier."
            );
        }
      }
      const inventoryFailure = inventoryErrorResponse(error);
      if (inventoryFailure) return inventoryFailure;
      throw error;
    }
  }
});
