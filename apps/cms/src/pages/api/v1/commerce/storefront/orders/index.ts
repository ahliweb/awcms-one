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
import { IdempotencyRaceLostError } from "../../../../../../modules/_shared/idempotency";
import {
  createOrderFromCart,
  IdempotencyPayloadMismatchError
} from "../../../../../../modules/commerce/application/order-directory";
import { mediaLibraryPortAdapter } from "../../../../../../modules/media-library/application/media-library-port-adapter";
import { commercePreflightResponse } from "../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../modules/commerce/application/public-commerce-tenant";
import { requireCustomerSession } from "../../../../../../modules/commerce/application/customer-session-auth";
import { validateCreateOrderInput } from "../../../../../../modules/commerce/domain/order-request-validation";
import { normalizePhoneNumber } from "../../../../../../modules/commerce/domain/phone-normalisation";

/**
 * `POST /api/v1/commerce/storefront/orders` (Issue #29) — anonymous,
 * cross-origin. Rate-limited on TWO independent axes (contract's own
 * defaults: 20/IP/hour, 5/phone/hour) — a per-IP ceiling alone cannot
 * protect the PERSON an order is placed against, since they contribute no
 * IP to the request at all (the same reasoning newsletter's per-address
 * confirmation cooldown documents).
 *
 * Idempotent by the client-supplied `idempotencyKey` (the cart's own UUID) —
 * see `application/order-directory.ts`'s header for why this reuses the
 * shared `awcms_idempotency_keys` store rather than a bespoke column.
 */
const RATE_LIMIT_WINDOW_SEC = parsePositiveIntSetting(
  process.env.COMMERCE_ORDER_CREATE_RATE_LIMIT_WINDOW_SEC,
  3600,
  "COMMERCE_ORDER_CREATE_RATE_LIMIT_WINDOW_SEC"
);
const RATE_LIMIT_MAX_PER_IP = parsePositiveIntSetting(
  process.env.COMMERCE_ORDER_CREATE_RATE_LIMIT_MAX_PER_IP,
  20,
  "COMMERCE_ORDER_CREATE_RATE_LIMIT_MAX_PER_IP"
);
const RATE_LIMIT_MAX_PER_PHONE = parsePositiveIntSetting(
  process.env.COMMERCE_ORDER_CREATE_RATE_LIMIT_MAX_PER_PHONE,
  5,
  "COMMERCE_ORDER_CREATE_RATE_LIMIT_MAX_PER_PHONE"
);

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const ipLimit = await checkSharedRateLimit(
    `commerce:orders:create:ip:${clientIp}`,
    {
      maxAttempts: RATE_LIMIT_MAX_PER_IP,
      windowMs: RATE_LIMIT_WINDOW_SEC * 1000
    }
  );
  if (!ipLimit.allowed) {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many orders from this source. Try again later.",
      {},
      undefined,
      {
        "retry-after": String(ipLimit.retryAfterSec),
        vary: "Origin"
      }
    );
  }

  const bodyRead = await readJsonBody(request);
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

  const validation = validateCreateOrderInput(bodyRead.value);
  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Invalid order request.",
      {},
      validation.errors,
      {
        vary: "Origin"
      }
    );
  }

  const phoneResult = normalizePhoneNumber(validation.value.customer.phone);
  if (!phoneResult.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Invalid order request.",
      {},
      [
        {
          field: "customer.phone",
          message: "customer.phone is not a valid Indonesian phone number."
        }
      ],
      { vary: "Origin" }
    );
  }

  const phoneLimit = await checkSharedRateLimit(
    `commerce:orders:create:phone:${phoneResult.value}`,
    {
      maxAttempts: RATE_LIMIT_MAX_PER_PHONE,
      windowMs: RATE_LIMIT_WINDOW_SEC * 1000
    }
  );
  if (!phoneLimit.allowed) {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many orders for this phone number. Try again later.",
      {},
      undefined,
      {
        "retry-after": String(phoneLimit.retryAfterSec),
        vary: "Origin"
      }
    );
  }

  // Issue #91 — an OPTIONAL bearer. Present but invalid/expired ->
  // `401 UNAUTHENTICATED` explicitly (the storefront re-reads its own
  // session right before submit and expects to be told plainly that it
  // needs to sign the shopper out); absent entirely -> unchanged guest path;
  // present and valid -> the order's customer is the account's OWN customer
  // row (`createOrderFromCart`'s `accountCustomerId`), never a
  // `findOrCreateCustomerByPhone` lookup on whatever phone was typed at
  // checkout.
  const hasAuthorizationHeader = request.headers.get("authorization") !== null;

  const sql = getDatabaseClient();

  try {
    const { result, corsHeaders } = await withPublicCommerceTenant(
      sql,
      request,
      async (tx, tenant) => {
        let accountCustomerId: string | undefined;

        if (hasAuthorizationHeader) {
          const authOutcome = await requireCustomerSession(
            request,
            tx,
            tenant.tenantId
          );
          if (!authOutcome.ok) {
            return { kind: "unauthenticated" } as const;
          }
          accountCustomerId = authOutcome.account.customerId;
        }

        // `validation.value.affiliateCode` (Issue #91) is shape-validated
        // only and deliberately NOT passed to `createOrderFromCart` — #92
        // is what wires affiliate attribution to a commission record.
        return createOrderFromCart(
          tx,
          tenant.tenantId,
          mediaLibraryPortAdapter,
          validation.value,
          undefined,
          undefined,
          accountCustomerId
        );
      }
    );

    if (!result) {
      return fail(404, "NOT_FOUND", "Not found.", {}, undefined, {
        vary: "Origin"
      });
    }

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

    if (result.kind === "invalid_phone") {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Invalid order request.",
        {},
        [
          {
            field: "customer.phone",
            message: "customer.phone is not a valid Indonesian phone number."
          }
        ],
        corsHeaders
      );
    }

    if (result.kind === "cart_changed") {
      return fail(
        409,
        "CART_CHANGED",
        "The cart changed since it was last quoted.",
        {},
        { quote: result.quote },
        corsHeaders
      );
    }

    if (result.kind === "replayed") {
      return jsonResponse(
        { success: true, data: result.order, meta: {} },
        { status: 200, headers: corsHeaders }
      );
    }

    return jsonResponse(
      { success: true, data: result.order, meta: {} },
      { status: 201, headers: corsHeaders }
    );
  } catch (error) {
    if (error instanceof IdempotencyRaceLostError) {
      if (error.replay) {
        return jsonResponse(error.replay.responseBody, {
          status: error.replay.responseStatus
        });
      }
      return fail(
        409,
        "IDEMPOTENCY_CONFLICT",
        "idempotencyKey was already used with a different request."
      );
    }
    if (error instanceof IdempotencyPayloadMismatchError) {
      return fail(409, "IDEMPOTENCY_CONFLICT", error.message);
    }
    throw error;
  }
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:orders:create",
    {
      maxAttempts: RATE_LIMIT_MAX_PER_IP,
      windowMs: RATE_LIMIT_WINDOW_SEC * 1000
    },
    // Issue #91 — `authorization` joins `content-type` since this route now
    // accepts an OPTIONAL bearer.
    ["content-type", "authorization"]
  );
