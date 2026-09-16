import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../lib/security/env-thresholds";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import {
  fail,
  jsonResponse
} from "../../../../../../modules/_shared/api-response";
import { createReview } from "../../../../../../modules/commerce/application/review-directory";
import { commercePreflightResponse } from "../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../modules/commerce/application/public-commerce-tenant";
import { normalizePhoneNumber } from "../../../../../../modules/commerce/domain/phone-normalisation";
import { validateCreateReviewInput } from "../../../../../../modules/commerce/domain/public-request-validation";

/**
 * `POST /api/v1/commerce/storefront/reviews` (Issue #29) — anonymous.
 * Requires a `completed` order containing the product, one per
 * `(customer, product, order)`; lands `pending` for moderation
 * (`application/review-directory.ts`).
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

const REASON_TO_CODE = {
  order_not_completed: "REVIEW_NOT_ALLOWED",
  product_not_in_order: "REVIEW_NOT_ALLOWED",
  already_reviewed: "REVIEW_NOT_ALLOWED"
} as const;

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:reviews:create:${clientIp}`,
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

  const bodyRead = await readJsonBody(request);
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

  const validation = validateCreateReviewInput(bodyRead.value);
  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Invalid review request.",
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

  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant) =>
      createReview(
        tx,
        tenant.tenantId,
        validation.value.orderCode,
        phoneResult.value,
        validation.value.productId,
        validation.value.rating,
        validation.value.body
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

  if (result.kind === "not_allowed") {
    return fail(
      409,
      REASON_TO_CODE[result.reason],
      "This order is not eligible for a review.",
      {},
      undefined,
      corsHeaders
    );
  }

  return jsonResponse(
    { success: true, data: { id: result.id, status: "pending" }, meta: {} },
    { status: 201, headers: corsHeaders }
  );
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:reviews:create",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 }
  );
