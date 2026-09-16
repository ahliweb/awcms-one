import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../../lib/security/env-thresholds";
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { fetchOrderForTracking } from "../../../../../../../modules/commerce/application/order-directory";
import { mediaLibraryPortAdapter } from "../../../../../../../modules/media-library/application/media-library-port-adapter";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";
import { normalizePhoneNumber } from "../../../../../../../modules/commerce/domain/phone-normalisation";

/**
 * `GET /api/v1/commerce/storefront/orders/{orderCode}?phone=` (Issue #29) —
 * anonymous. `orderCode` + `phone` is the CREDENTIAL: an unknown code, a
 * wrong phone, and another tenant's order all answer the exact same neutral
 * `404` (contract's own words) — the pair is checked INSIDE the query
 * `fetchOrderForTracking` runs (`order-directory.ts`), not merely here.
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

const NEUTRAL_NOT_FOUND = () =>
  fail(404, "NOT_FOUND", "Not found.", {}, undefined, { vary: "Origin" });

export const GET: APIRoute = async ({
  params,
  url,
  request,
  clientAddress
}) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:orders:track:${clientIp}`,
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
  const rawPhone = url.searchParams.get("phone");

  if (!orderCode || !rawPhone) return NEUTRAL_NOT_FOUND();

  const phoneResult = normalizePhoneNumber(rawPhone);
  if (!phoneResult.valid) return NEUTRAL_NOT_FOUND();

  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant) =>
      fetchOrderForTracking(
        tx,
        tenant.tenantId,
        mediaLibraryPortAdapter,
        orderCode,
        phoneResult.value
      )
  );

  if (!result) {
    return fail(404, "NOT_FOUND", "Not found.", {}, undefined, corsHeaders);
  }

  return ok(result, {}, corsHeaders);
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:orders:track",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 }
  );
