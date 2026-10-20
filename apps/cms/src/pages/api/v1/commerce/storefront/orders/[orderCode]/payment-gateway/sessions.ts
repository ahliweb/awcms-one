import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../../../lib/security/env-thresholds";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../../lib/security/request-body-limit";
import {
  fail,
  jsonResponse
} from "../../../../../../../../modules/_shared/api-response";
import {
  isPlainJsonObject,
  parseGatewaySessionPurpose
} from "../../../../../../../../modules/commerce/domain/gateway-deposit";
import { createGatewaySession } from "../../../../../../../../modules/commerce/application/payment-gateway-directory";
import { commercePreflightResponse } from "../../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../../modules/commerce/application/public-commerce-tenant";
import {
  resolvePaymentGatewayProvider,
  resolvePaymentGatewayProviderKey
} from "../../../../../../../../modules/commerce/infrastructure/payment-gateway-provider-resolver";
import { fetchCommerceFeatures } from "../../../../../../../../modules/commerce/application/commerce-feature-gate";

/**
 * `POST /api/v1/commerce/storefront/orders/{orderCode}/payment-gateway/sessions`
 * (Issue #110, contract #106's D3) — anonymous, cross-origin. Auth is `phone`
 * in the body OR an `Authorization: Bearer <customer session token>`,
 * matching the rest of this anonymous surface (`POST .../orders`'s own
 * optional-bearer pattern, Issue #91). A mismatch — unknown order code,
 * wrong phone, or a live bearer session that owns a DIFFERENT order — all
 * answer the SAME neutral `404` the order-tracking route
 * (`GET .../orders/{orderCode}`) uses: a caller must never learn "this order
 * exists but is not yours" from a distinguishable response.
 *
 * ## Purpose (Issue #379, ADR-0041)
 *
 * The body may carry `purpose`: `full` (the default, and the only value an
 * order without a deposit ever admits - every existing caller is unchanged),
 * `deposit` (the down payment of a down-payment order) or `balance` (what
 * remains after it). The client asks for "pay the deposit" / "pay the balance"
 * and supplies NO amount: the server computes the expected amount under the
 * order-row lock and sends exactly that to the provider. A body naming an
 * amount at all is refused `400`.
 *
 * `createGatewaySession` itself opens its own two short transactions off the
 * raw pool client (`sql`, not this route's own `tx`) and calls the provider
 * with neither open — see that function's own header for the full
 * transaction discipline. This route's `withPublicCommerceTenant` call is
 * used ONLY for origin/tenant/module-enabled resolution and CORS, exactly
 * like `POST .../cart/quote` already does for its own provider-calling
 * path (`cart-quote-service.ts`'s header).
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

const NEUTRAL_NOT_FOUND = (corsHeaders: Record<string, string> = {}) =>
  fail(404, "NOT_FOUND", "Not found.", {}, undefined, {
    vary: "Origin",
    ...corsHeaders
  });

export const POST: APIRoute = async ({ request, params, clientAddress }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:payment-gateway:sessions:${clientIp}`,
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 }
  );
  if (!rateLimit.allowed) {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many requests. Try again later.",
      {},
      undefined,
      { "retry-after": String(rateLimit.retryAfterSec), vary: "Origin" }
    );
  }

  const orderCode = params.orderCode;
  if (!orderCode) return NEUTRAL_NOT_FOUND();

  const bodyRead = await readJsonBody(request);
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

  // A JSON body that parses but is not an object (`5`, `"x"`, `true`, `[]`)
  // is a validation error, never a 500 from the `in` checks below.
  if (bodyRead.value != null && !isPlainJsonObject(bodyRead.value)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "The request body must be a JSON object.",
      {},
      [{ field: "body", message: "The request body must be a JSON object." }],
      { vary: "Origin" }
    );
  }
  const body = (bodyRead.value ?? {}) as {
    phone?: unknown;
    purpose?: unknown;
  };

  // Issue #379 (ADR-0041 D1): the client never supplies money. A body naming an
  // amount is refused rather than silently ignored, so nothing can be mistaken
  // for a figure the server trusts.
  const bodyRecord = body as Record<string, unknown>;
  const suppliedMoneyField = ["amount", "expectedAmount", "grossAmount"].find(
    (field) => field in bodyRecord
  );
  if (suppliedMoneyField) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "The amount is computed by the server and cannot be supplied.",
      {},
      [
        {
          field: suppliedMoneyField,
          message: "The amount is computed by the server."
        }
      ],
      { vary: "Origin" }
    );
  }
  const purpose = parseGatewaySessionPurpose(body.purpose);
  if (purpose === null) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "purpose must be one of full, deposit, balance.",
      {},
      [
        {
          field: "purpose",
          message: "purpose must be one of full, deposit, balance."
        }
      ],
      { vary: "Origin" }
    );
  }
  const hasAuthorizationHeader = request.headers.get("authorization") !== null;
  const rawPhone = typeof body.phone === "string" ? body.phone : null;

  if (!hasAuthorizationHeader && !rawPhone) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "phone is required unless a valid Authorization bearer is presented.",
      {},
      [{ field: "phone", message: "phone is required." }],
      { vary: "Origin" }
    );
  }

  const provider = resolvePaymentGatewayProvider();
  const providerKey = resolvePaymentGatewayProviderKey();

  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant) => {
      // Issue #118 — a tenant that turned `features.gateway` off is
      // reported the SAME `503 GATEWAY_UNAVAILABLE` as "no provider
      // configured for this deployment": both are "the gateway is not
      // usable right now" from this caller's point of view, and the
      // contract (#106 D3) already reserves 503 for exactly that.
      const features = await fetchCommerceFeatures(tx, tenant.tenantId);
      if (!provider || !providerKey || !features.gateway) {
        return { kind: "gateway_unavailable" as const };
      }

      return createGatewaySession(
        sql,
        tenant.tenantId,
        orderCode,
        hasAuthorizationHeader
          ? { kind: "bearer", request }
          : { kind: "phone", phone: rawPhone! },
        provider,
        providerKey,
        purpose
      );
    }
  );

  if (!result) return NEUTRAL_NOT_FOUND(corsHeaders);

  if (result.kind === "not_found") return NEUTRAL_NOT_FOUND(corsHeaders);

  if (result.kind === "unauthenticated") {
    return fail(
      401,
      "UNAUTHENTICATED",
      "Missing, invalid, or expired session.",
      {},
      undefined,
      corsHeaders
    );
  }

  if (result.kind === "not_applicable") {
    return fail(
      409,
      "PAYMENT_NOT_APPLICABLE",
      "This order is not a payable gateway order.",
      {},
      undefined,
      corsHeaders
    );
  }

  if (result.kind === "partially_settled") {
    // Issue #285 (ADR-0025): part of the order is already paid; a hosted
    // checkout would charge the full total again, so none is offered.
    return fail(
      409,
      "ORDER_PARTIALLY_SETTLED",
      "Part of this order has already been paid; the balance cannot be paid through the online gateway.",
      {},
      { outstanding: result.outstanding },
      corsHeaders
    );
  }

  if (result.kind === "purpose_not_allowed") {
    // Issue #379 (ADR-0041 D1/D3): the order's state does not admit this
    // purpose (a deposit/balance on a whole-total order, a balance before the
    // deposit is in, ...). `allowed` lists what it does admit.
    return fail(
      409,
      "PURPOSE_NOT_ALLOWED",
      "This order does not admit that kind of payment session right now.",
      {},
      { allowed: result.allowed },
      corsHeaders
    );
  }

  if (result.kind === "session_in_progress") {
    // Issue #379 (ADR-0041 D5.1): one live session per order.
    return fail(
      409,
      "SESSION_IN_PROGRESS",
      "Another payment session for this order is still open; wait for it to be paid or to expire.",
      {},
      undefined,
      corsHeaders
    );
  }

  if (result.kind === "gateway_unavailable") {
    return fail(
      503,
      "GATEWAY_UNAVAILABLE",
      "The payment gateway is not available right now.",
      {},
      undefined,
      corsHeaders
    );
  }

  return jsonResponse(
    {
      success: true,
      data: {
        redirectUrl: result.session.redirectUrl,
        expiresAt: result.session.expiresAt,
        providerRef: result.session.providerRef,
        // Issue #379: only a deposit/balance session names its purpose and the
        // server-computed amount it collects; a whole-total session's response
        // is exactly what it always was.
        ...(result.session.purpose === "full"
          ? {}
          : {
              purpose: result.session.purpose,
              expectedAmount: result.session.expectedAmount
            })
      },
      meta: {}
    },
    { status: 201, headers: corsHeaders }
  );
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:payment-gateway:sessions",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    ["content-type", "authorization"]
  );
