import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../../lib/security/env-thresholds";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import {
  fail,
  jsonResponse
} from "../../../../../../../modules/_shared/api-response";
import { OrderNotPayableError } from "../../../../../../../modules/commerce/application/order-directory";
import { commerceIdempotentPreflightHeaders } from "../../../../../../../modules/commerce/domain/commerce-cors";
import { createPaymentConfirmationIdempotent } from "../../../../../../../modules/commerce/application/storefront-idempotent-mutations";
import {
  readStorefrontIdempotencyKey,
  storefrontIdempotencyConflictResponse
} from "../../../../../../../modules/commerce/application/storefront-idempotency-http";
import { mediaLibraryPortAdapter } from "../../../../../../../modules/media-library/application/media-library-port-adapter";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";
import { normalizePhoneNumber } from "../../../../../../../modules/commerce/domain/phone-normalisation";
import { validatePaymentConfirmationInput } from "../../../../../../../modules/commerce/domain/public-request-validation";

/**
 * `POST /api/v1/commerce/storefront/orders/{orderCode}/payment-confirmations`
 * (Issue #29) — anonymous. Accepted WITHOUT a proof image in this
 * increment — `order-directory.ts`'s header explains why the upload-session
 * path answers `503 MEDIA_UNAVAILABLE` unconditionally; `proofMediaObjectId`
 * is validated as an optional string here purely for forward-compatibility
 * with a future increment that wires the upload path up, and is currently
 * never resolvable to a real object.
 *
 * Takes an OPTIONAL `Idempotency-Key` (Issue #513, unit C): every submit
 * inserts a confirmation row, so a repeat used to record the same payment
 * twice. The same key + same `(orderCode, phone, confirmation)` replays the
 * original `201` with the order as it is now (`data.replayed: true`, no second
 * row); the same key for another order, phone or confirmation is `409
 * IDEMPOTENCY_CONFLICT` and never answers the stored outcome. The record is a
 * marker only (no order data is copied into the idempotency table).
 */
const RATE_LIMIT_MAX = parsePositiveIntSetting(
  process.env.COMMERCE_STOREFRONT_RATE_LIMIT_MAX,
  60,
  "COMMERCE_STOREFRONT_RATE_LIMIT_MAX"
);
const RATE_LIMIT_WINDOW_SEC = parsePositiveIntSetting(
  process.env.COMMERCE_STOREFRONT_RATE_LIMIT_WINDOW_SEC,
  60,
  "COMMERCE_STOREFRONT_RATE_LIMIT_WINDOW_SEC"
);

export const POST: APIRoute = async ({
  params,
  request,
  clientAddress,
  locals
}) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:orders:payment-confirm:${clientIp}`,
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 }
  );
  if (!rateLimit.allowed) {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many requests. Try again later.",
      {},
      undefined,
      {
        "retry-after": String(rateLimit.retryAfterSec),
        vary: "Origin"
      }
    );
  }

  const idempotency = readStorefrontIdempotencyKey(request);
  if ("response" in idempotency) return idempotency.response;

  const orderCode = params.orderCode;
  if (!orderCode) {
    return fail(404, "NOT_FOUND", "Not found.", {}, undefined, {
      vary: "Origin"
    });
  }

  const bodyRead = await readJsonBody(request);
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

  const validation = validatePaymentConfirmationInput(bodyRead.value);
  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Invalid payment confirmation.",
      {},
      validation.errors,
      {
        vary: "Origin"
      }
    );
  }

  const phoneResult = normalizePhoneNumber(validation.value.phone);
  if (!phoneResult.valid) {
    return fail(404, "NOT_FOUND", "Not found.", {}, undefined, {
      vary: "Origin"
    });
  }

  const sql = getDatabaseClient();

  try {
    const { result, corsHeaders } = await withPublicCommerceTenant(
      sql,
      request,
      async (tx, tenant) =>
        createPaymentConfirmationIdempotent(
          tx,
          tenant.tenantId,
          mediaLibraryPortAdapter,
          orderCode,
          phoneResult.value,
          validation.value,
          { key: idempotency.key, correlationId: locals.correlationId }
        )
    );

    if (!result || result.kind === "not_found") {
      return fail(
        404,
        "NOT_FOUND",
        "Not found.",
        {},
        undefined,
        corsHeaders ?? { vary: "Origin" }
      );
    }

    if (result.kind === "idempotency_conflict") {
      return storefrontIdempotencyConflictResponse(corsHeaders);
    }

    return jsonResponse(
      {
        success: true,
        data: result.replayed
          ? { ...result.order!, replayed: true }
          : result.order,
        meta: {}
      },
      { status: 201, headers: corsHeaders }
    );
  } catch (error) {
    if (error instanceof OrderNotPayableError) {
      return fail(409, "ORDER_NOT_PAYABLE", error.message, {}, undefined, {
        vary: "Origin"
      });
    }
    throw error;
  }
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:orders:payment-confirm",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    commerceIdempotentPreflightHeaders(["content-type"])
  );
