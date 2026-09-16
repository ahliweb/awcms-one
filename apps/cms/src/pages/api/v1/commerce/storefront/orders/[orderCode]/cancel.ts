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
import {
  cancelOrderByCustomer,
  OrderNotCancellableError
} from "../../../../../../../modules/commerce/application/order-directory";
import { mediaLibraryPortAdapter } from "../../../../../../../modules/media-library/application/media-library-port-adapter";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";
import { normalizePhoneNumber } from "../../../../../../../modules/commerce/domain/phone-normalisation";
import { validateCancelOrderInput } from "../../../../../../../modules/commerce/domain/public-request-validation";

/** `POST /api/v1/commerce/storefront/orders/{orderCode}/cancel` (Issue #29) — anonymous, only while `pending_payment` (`domain/order-status.ts`). */
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
        cancelOrderByCustomer(
          tx,
          tenant.tenantId,
          mediaLibraryPortAdapter,
          orderCode,
          phoneResult.value,
          validation.value.reason
        )
    );

    if (!result) {
      return fail(404, "NOT_FOUND", "Not found.", {}, undefined, corsHeaders);
    }

    return ok(result, {}, corsHeaders);
  } catch (error) {
    if (error instanceof OrderNotCancellableError) {
      return fail(409, "ORDER_NOT_CANCELLABLE", error.message, {}, undefined, {
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
    "commerce:orders:cancel",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 }
  );
