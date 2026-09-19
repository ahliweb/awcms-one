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
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { buildCartQuote } from "../../../../../../modules/commerce/application/cart-quote-service";
import { mediaLibraryPortAdapter } from "../../../../../../modules/media-library/application/media-library-port-adapter";
import { commercePreflightResponse } from "../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../modules/commerce/application/public-commerce-tenant";
import { validateCartQuoteRequest } from "../../../../../../modules/commerce/domain/public-request-validation";

/**
 * `POST /api/v1/commerce/storefront/cart/quote` (Issue #29) — anonymous,
 * cross-origin (contract: `commerce-storefront-endpoints.md`). Read-only:
 * never decrements stock, never redeems a voucher, never writes anything —
 * `application/order-directory.ts`'s `createOrderFromCart` re-quotes inside
 * its own write transaction rather than trusting a price this endpoint
 * returned moments earlier.
 *
 * Unresolvable tenant / disabled module / invalid body all answer the SAME
 * shape the contract specifies for the first two (`404 NOT_FOUND`); a
 * malformed request body is the one case that is genuinely about the
 * REQUEST, not about any tenant, so it stays a `400`.
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

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:cart-quote:${clientIp}`,
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

  const validation = validateCartQuoteRequest(bodyRead.value);
  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Invalid cart quote request.",
      {},
      validation.errors,
      {
        vary: "Origin"
      }
    );
  }

  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant) =>
      buildCartQuote(
        tx,
        tenant.tenantId,
        mediaLibraryPortAdapter,
        validation.value,
        undefined,
        // Issue #107 — the only call site allowed to fetch LIVE courier
        // rates (a provider call): `getCourierRates` opens its own short
        // transactions off this raw pool client, never off `tx` above.
        sql
      )
  );

  if (!result) return NEUTRAL_NOT_FOUND();

  return ok(result, {}, corsHeaders);
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:cart-quote",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 }
  );
