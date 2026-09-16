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
import {
  createPaymentConfirmation,
  OrderNotPayableError
} from "../../../../../../../modules/commerce/application/order-directory";
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

export const POST: APIRoute = async ({ params, request, clientAddress }) => {
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
        createPaymentConfirmation(
          tx,
          tenant.tenantId,
          mediaLibraryPortAdapter,
          orderCode,
          phoneResult.value,
          validation.value
        )
    );

    if (!result) {
      return fail(404, "NOT_FOUND", "Not found.", {}, undefined, corsHeaders);
    }

    return jsonResponse(
      { success: true, data: result, meta: {} },
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
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 }
  );
