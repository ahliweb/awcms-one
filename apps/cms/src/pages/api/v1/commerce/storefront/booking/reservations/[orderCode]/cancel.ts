import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../../lib/database/client";
import { composedBookingPort } from "../../../../../../../../lib/composition/booking-port";
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
  cancelRefusalResponse,
  guestPhoneKey,
  shopperDecisionBody
} from "../../../../../../../../modules/commerce/application/booking-adapter-http";
import {
  cancelBookingReservation,
  type CancelResult
} from "../../../../../../../../modules/commerce/application/booking-cancellation";
import {
  fetchReservationLinkForOrderCode,
  type OwnReservationIdentity
} from "../../../../../../../../modules/commerce/application/booking-reservation-links";
import { requireCommerceFeatureForPublicRoute } from "../../../../../../../../modules/commerce/application/commerce-feature-gate";
import { requireCustomerSession } from "../../../../../../../../modules/commerce/application/customer-session-auth";
import { commercePreflightResponse } from "../../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../../modules/commerce/application/public-commerce-tenant";
import type { BookingRequestActor } from "../../../../../../../../modules/commerce/domain/booking-hold-to-order";
import { validateCustomerCancelRequest } from "../../../../../../../../modules/commerce/domain/booking-cancellation";
import { normalizePhoneNumber } from "../../../../../../../../modules/commerce/domain/phone-normalisation";
import { IdempotencyRaceLostError } from "../../../../../../../../modules/_shared/idempotency";

/**
 * `POST /api/v1/commerce/storefront/booking/reservations/{orderCode}/cancel`
 * (Issue #381, ADR-0045 D4/D9, contracts section 3.5; threat controls C-05,
 * C-10, C-32) - the shopper confirms a quoted cancellation of THEIR OWN
 * reservation. Anonymous, cross-origin, with an OPTIONAL `customerBearer`
 * (ADR-0016 D3): a present-but-dead bearer is `401 UNAUTHENTICATED`; without a
 * bearer the order's `phone` in the body proves ownership.
 *
 * The body is `{ acknowledgedRefund, phone? }` and nothing else: a body naming
 * `final_refund`, `amount`, an `override` or any other money field is a `400`
 * from the strict schema (a guest can never set a figure). The refund is the one
 * the SERVER computes; `acknowledgedRefund` is only compared with it - a
 * difference is `409 QUOTE_CHANGED` carrying the new figure, with nothing
 * cancelled. The answer is the status and the final refund amount only (no
 * policy internals, no reason, no actor). `Idempotency-Key` is required and
 * namespaced by who asks, so a stranger can neither claim nor replay it; the
 * same key and request replays (`200`), another request is `409
 * IDEMPOTENCY_CONFLICT`. The refund legs are planned under the tenant's
 * service-account user; this route never settles money. Rate-limited per IP
 * and per phone, on its own counters but with the order-create limits
 * (`COMMERCE_ORDER_CREATE_RATE_LIMIT_*`). Behind the `booking` feature: off, the neutral `404`.
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
const PREFLIGHT_ALLOWED_HEADERS = [
  "content-type",
  "authorization",
  "idempotency-key"
] as const;

type Outcome =
  | { kind: "unauthenticated" }
  | { kind: "blocked" }
  | { kind: "not_found" }
  | { kind: "result"; result: CancelResult };

export const POST: APIRoute = async ({
  params,
  request,
  clientAddress,
  locals
}) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const ipLimit = await checkSharedRateLimit(
    `commerce:booking:cancel:ip:${clientIp}`,
    {
      maxAttempts: RATE_LIMIT_MAX_PER_IP,
      windowMs: RATE_LIMIT_WINDOW_SEC * 1000
    }
  );
  if (!ipLimit.allowed) {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many cancellation requests from this source. Try again later.",
      {},
      undefined,
      { "retry-after": String(ipLimit.retryAfterSec), vary: "Origin" }
    );
  }

  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (idempotencyKey.length === 0 || idempotencyKey.length > 255) {
    return fail(
      400,
      idempotencyKey.length === 0 ? "IDEMPOTENCY_REQUIRED" : "VALIDATION_ERROR",
      "Idempotency-Key header is required (1 to 255 characters).",
      {},
      undefined,
      { vary: "Origin" }
    );
  }

  const bodyRead = await readJsonBody(request);
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const validation = validateCustomerCancelRequest(bodyRead.value);
  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Invalid cancellation request.",
      {},
      validation.errors,
      { vary: "Origin" }
    );
  }
  const body = validation.value;

  const orderCode = params.orderCode;
  const hasAuthorizationHeader = request.headers.get("authorization") !== null;
  let guestPhone: string | null = null;
  if (!hasAuthorizationHeader) {
    const normalized = body.phone ? normalizePhoneNumber(body.phone) : null;
    if (!orderCode || !normalized?.valid) {
      return fail(404, "NOT_FOUND", "Not found.", {}, undefined, {
        vary: "Origin"
      });
    }
    guestPhone = normalized.value;
    const phoneLimit = await checkSharedRateLimit(
      `commerce:booking:cancel:phone:${guestPhone}`,
      {
        maxAttempts: RATE_LIMIT_MAX_PER_PHONE,
        windowMs: RATE_LIMIT_WINDOW_SEC * 1000
      }
    );
    if (!phoneLimit.allowed) {
      return fail(
        429,
        "RATE_LIMITED",
        "Too many cancellation requests for this phone number. Try again later.",
        {},
        undefined,
        { "retry-after": String(phoneLimit.retryAfterSec), vary: "Origin" }
      );
    }
  }

  const sql = getDatabaseClient();
  try {
    const { result, corsHeaders } = await withPublicCommerceTenant(
      sql,
      request,
      async (tx, tenant): Promise<Outcome> => {
        const gate = await requireCommerceFeatureForPublicRoute(
          tx,
          tenant.tenantId,
          "booking",
          () => fail(404, "NOT_FOUND", "Not found.")
        );
        if (gate) return { kind: "not_found" };

        let identity: OwnReservationIdentity;
        let actor: BookingRequestActor;
        if (hasAuthorizationHeader) {
          const auth = await requireCustomerSession(
            request,
            tx,
            tenant.tenantId
          );
          if (!auth.ok) return { kind: "unauthenticated" };
          if (auth.account.status === "blocked") return { kind: "blocked" };
          identity = { kind: "customer", customerId: auth.account.customerId };
          actor = { kind: "customer", customerId: auth.account.customerId };
        } else {
          identity = { kind: "phone", phone: guestPhone! };
          actor = { kind: "guest", phoneKey: guestPhoneKey(guestPhone!) };
        }

        // Ownership is part of the query: the customer id / phone is the
        // server-resolved identity, never a field of the body.
        const link = await fetchReservationLinkForOrderCode(
          tx,
          tenant.tenantId,
          orderCode!,
          identity
        );
        if (!link) return { kind: "not_found" };

        return {
          kind: "result",
          result: await cancelBookingReservation(
            tx,
            {
              tenantId: tenant.tenantId,
              actor,
              correlationId: locals.correlationId ?? crypto.randomUUID(),
              port: await composedBookingPort()
            },
            {
              link,
              idempotencyKey,
              reasonCode: "customer_request",
              acknowledgedRefund: body.acknowledgedRefund,
              override: null
            }
          )
        };
      }
    );

    if (!result || result.kind === "not_found") {
      return fail(404, "NOT_FOUND", "Not found.", {}, undefined, corsHeaders);
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
    if (result.kind === "blocked") {
      return fail(
        403,
        "ACCOUNT_BLOCKED",
        "This account is blocked.",
        {},
        undefined,
        corsHeaders
      );
    }
    if (result.result.kind === "refused") {
      return cancelRefusalResponse(result.result.refusal, corsHeaders);
    }
    return jsonResponse(
      {
        success: true,
        data: shopperDecisionBody(result.result.decision),
        meta: {}
      },
      { status: 200, headers: corsHeaders }
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
        "Idempotency-Key was already used with a different request."
      );
    }
    throw error;
  }
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:booking:cancel",
    {
      maxAttempts: RATE_LIMIT_MAX_PER_IP,
      windowMs: RATE_LIMIT_WINDOW_SEC * 1000
    },
    [...PREFLIGHT_ALLOWED_HEADERS]
  );
