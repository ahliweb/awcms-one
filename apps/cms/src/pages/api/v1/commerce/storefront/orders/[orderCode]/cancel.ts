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
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { OrderNotCancellableError } from "../../../../../../../modules/commerce/application/order-directory";
import { commerceIdempotentPreflightHeaders } from "../../../../../../../modules/commerce/domain/commerce-cors";
import { cancelOrderIdempotent } from "../../../../../../../modules/commerce/application/storefront-idempotent-mutations";
import {
  readStorefrontIdempotencyKey,
  storefrontIdempotencyConflictResponse
} from "../../../../../../../modules/commerce/application/storefront-idempotency-http";
import { mediaLibraryPortAdapter } from "../../../../../../../modules/media-library/application/media-library-port-adapter";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";
import { normalizePhoneNumber } from "../../../../../../../modules/commerce/domain/phone-normalisation";
import { validateCancelOrderInput } from "../../../../../../../modules/commerce/domain/public-request-validation";
import { BookingOrderUseAdapterError } from "../../../../../../../modules/commerce/application/booking-order-guards";
import { inventoryErrorResponse } from "../../../../../../../modules/commerce/application/commerce-inventory-http";

/**
 * `POST /api/v1/commerce/storefront/orders/{orderCode}/cancel` (Issue #29) —
 * anonymous, only while `pending_payment` (`domain/order-status.ts`).
 *
 * Idempotency (Issue #513, unit C). The operation is NATURALLY idempotent: an
 * order that is already `cancelled` answers `200` with the order as it is (no
 * second transition, event or audit row), with or without a key; the order row
 * is locked while it is cancelled, so two concurrent cancels run one
 * transition. Every other state the customer may not cancel from keeps `409
 * ORDER_NOT_CANCELLABLE`. An OPTIONAL `Idempotency-Key` adds the contract the
 * other routes share: the same key + same `(orderCode, phone, reason)` replays
 * (`data.replayed: true`, the order as it is now); the same key for another
 * order, phone or reason is `409 IDEMPOTENCY_CONFLICT` and never answers the
 * stored outcome. The record is a marker only.
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
    `commerce:orders:cancel:${clientIp}`,
    {
      maxAttempts: RATE_LIMIT_MAX,
      windowMs: RATE_LIMIT_WINDOW_SEC * 1000
    }
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

  const validation = validateCancelOrderInput(bodyRead.value);
  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Invalid cancel request.",
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
        cancelOrderIdempotent(
          tx,
          tenant.tenantId,
          mediaLibraryPortAdapter,
          orderCode,
          phoneResult.value,
          validation.value.reason,
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

    return ok(
      result.replayed ? { ...result.order, replayed: true } : result.order,
      {},
      corsHeaders
    );
  } catch (error) {
    if (error instanceof BookingOrderUseAdapterError) {
      return fail(
        409,
        "BOOKING_ORDER_USE_ADAPTER",
        error.message,
        {},
        undefined,
        {
          vary: "Origin"
        }
      );
    }
    if (error instanceof OrderNotCancellableError) {
      return fail(409, "ORDER_NOT_CANCELLABLE", error.message, {}, undefined, {
        vary: "Origin"
      });
    }
    const inventoryFailure = inventoryErrorResponse(error, { vary: "Origin" });
    if (inventoryFailure) return inventoryFailure;
    throw error;
  }
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:orders:cancel",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    commerceIdempotentPreflightHeaders(["content-type"])
  );
