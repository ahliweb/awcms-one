import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../lib/database/client";
import { composedBookingPort } from "../../../../../../../lib/composition/booking-port";
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
  createdReservationBody,
  holdRefusalResponse
} from "../../../../../../../modules/commerce/application/booking-adapter-http";
import {
  createBookingReservation,
  type HoldToOrderResult
} from "../../../../../../../modules/commerce/application/booking-hold-to-order";
import { requireCommerceFeatureForPublicRoute } from "../../../../../../../modules/commerce/application/commerce-feature-gate";
import { requireCustomerSession } from "../../../../../../../modules/commerce/application/customer-session-auth";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";
import {
  validateBookingReservationRequest,
  type BookingRequestActor
} from "../../../../../../../modules/commerce/domain/booking-hold-to-order";
import { normalizePhoneNumber } from "../../../../../../../modules/commerce/domain/phone-normalisation";
import { mediaLibraryPortAdapter } from "../../../../../../../modules/media-library/application/media-library-port-adapter";
import { IdempotencyRaceLostError } from "../../../../../../../modules/_shared/idempotency";

/**
 * `POST /api/v1/commerce/storefront/booking/reservations` (Issue #380, ADR-0045
 * G2/G5/G15; contracts section 3.2) - hold a slot or stay and create the order
 * from it in one idempotent call. Anonymous, cross-origin, with an OPTIONAL
 * `customerBearer` (ADR-0016 D3): a present-but-dead bearer is
 * `401 UNAUTHENTICATED` (the storefront clears its stored session), a live one
 * makes the order the account's own and the `guest` block is ignored, no bearer
 * is a guest checkout and needs `guest.name` and `guest.phone`.
 *
 * Anonymous guest checkout is allowed server-side (G15); a tenant that wants
 * accounts only enforces that in its storefront. The `Idempotency-Key` header is
 * required and is namespaced by who is asking (the account, or the guest's
 * phone) before it becomes the reservation link's `client_key`, so a stranger
 * can neither claim nor replay it; the same key and request replays the original
 * (`200`, `replayed: true`), the same key with another request is `409
 * IDEMPOTENCY_CONFLICT`.
 *
 * The body never names a price, amount, deposit or customer (`400`): the price is
 * the linked product's, the deposit its policy's, the customer the session's or
 * the guest's phone. Rate-limited per IP and per phone like the ordinary order
 * route. Behind the `booking` feature: off, the route is the neutral `404`.
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
  | { kind: "feature_off" }
  | { kind: "result"; result: HoldToOrderResult };

const notFound = (headers: Record<string, string>) =>
  fail(404, "NOT_FOUND", "Not found.", {}, undefined, headers);

export const POST: APIRoute = async ({ request, clientAddress, locals }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const ipLimit = await checkSharedRateLimit(
    `commerce:booking:create:ip:${clientIp}`,
    {
      maxAttempts: RATE_LIMIT_MAX_PER_IP,
      windowMs: RATE_LIMIT_WINDOW_SEC * 1000
    }
  );
  if (!ipLimit.allowed) {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many booking requests from this source. Try again later.",
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
  const validation = validateBookingReservationRequest(bodyRead.value);
  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Invalid booking request.",
      {},
      validation.errors,
      { vary: "Origin" }
    );
  }
  const body = validation.value;

  // An ANONYMOUS request names itself by the guest's phone; a signed-in one by
  // its account (checked below). The phone is rate-limited on its own axis: a
  // per-IP ceiling alone cannot protect the person a booking is placed for.
  const hasAuthorizationHeader = request.headers.get("authorization") !== null;
  let guestPhone: string | null = null;
  if (!hasAuthorizationHeader) {
    if (!body.guest) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Invalid booking request.",
        {},
        [{ field: "guest", message: "guest is required without a session." }],
        { vary: "Origin" }
      );
    }
    const phone = normalizePhoneNumber(body.guest.phone);
    if (!phone.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Invalid booking request.",
        {},
        [
          {
            field: "guest.phone",
            message: "guest.phone is not a valid Indonesian phone number."
          }
        ],
        { vary: "Origin" }
      );
    }
    guestPhone = phone.value;
    const phoneLimit = await checkSharedRateLimit(
      `commerce:booking:create:phone:${guestPhone}`,
      {
        maxAttempts: RATE_LIMIT_MAX_PER_PHONE,
        windowMs: RATE_LIMIT_WINDOW_SEC * 1000
      }
    );
    if (!phoneLimit.allowed) {
      return fail(
        429,
        "RATE_LIMITED",
        "Too many booking requests for this phone number. Try again later.",
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
          () => notFound({})
        );
        if (gate) return { kind: "feature_off" };

        let actor: BookingRequestActor;
        let accountCustomerId: string | undefined;
        if (hasAuthorizationHeader) {
          const auth = await requireCustomerSession(
            request,
            tx,
            tenant.tenantId
          );
          if (!auth.ok) return { kind: "unauthenticated" };
          if (auth.account.status === "blocked") return { kind: "blocked" };
          accountCustomerId = auth.account.customerId;
          actor = { kind: "customer", customerId: accountCustomerId };
        } else {
          actor = { kind: "guest", phoneKey: guestPhoneKey(guestPhone!) };
        }

        return {
          kind: "result",
          result: await createBookingReservation(
            tx,
            {
              tenantId: tenant.tenantId,
              actor,
              accountCustomerId,
              correlationId: locals.correlationId ?? crypto.randomUUID(),
              port: await composedBookingPort(),
              mediaPort: mediaLibraryPortAdapter
            },
            body,
            idempotencyKey
          )
        };
      }
    );

    if (!result || result.kind === "feature_off") {
      return notFound(corsHeaders);
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
      return holdRefusalResponse(result.result.refusal, corsHeaders);
    }
    const replayed = result.result.kind === "replayed";
    return jsonResponse(
      {
        success: true,
        data: createdReservationBody(result.result.view, replayed),
        meta: {}
      },
      { status: replayed ? 200 : 201, headers: corsHeaders }
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

/** The anonymous namespace tag: a digest of the normalised phone (the raw number is not written into a key). */
function guestPhoneKey(phone: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(phone)
    .digest("hex")
    .slice(0, 32);
}

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:booking:create",
    {
      maxAttempts: RATE_LIMIT_MAX_PER_IP,
      windowMs: RATE_LIMIT_WINDOW_SEC * 1000
    },
    [...PREFLIGHT_ALLOWED_HEADERS]
  );
