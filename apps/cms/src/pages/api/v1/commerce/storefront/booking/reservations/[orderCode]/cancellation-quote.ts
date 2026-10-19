import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../../lib/database/client";
import { composedBookingPort } from "../../../../../../../../lib/composition/booking-port";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../../../lib/security/env-thresholds";
import { fail, ok } from "../../../../../../../../modules/_shared/api-response";
import {
  cancelRefusalResponse,
  cancellationQuoteBody
} from "../../../../../../../../modules/commerce/application/booking-adapter-http";
import { computeCancellationQuote } from "../../../../../../../../modules/commerce/application/booking-cancellation";
import {
  fetchReservationLinkForOrderCode,
  type OwnReservationIdentity
} from "../../../../../../../../modules/commerce/application/booking-reservation-links";
import { requireCommerceFeatureForPublicRoute } from "../../../../../../../../modules/commerce/application/commerce-feature-gate";
import { requireCustomerSession } from "../../../../../../../../modules/commerce/application/customer-session-auth";
import { commercePreflightResponse } from "../../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../../modules/commerce/application/public-commerce-tenant";
import { normalizePhoneNumber } from "../../../../../../../../modules/commerce/domain/phone-normalisation";
import type { CancelRefusal } from "../../../../../../../../modules/commerce/domain/booking-cancellation";

/**
 * `GET /api/v1/commerce/storefront/booking/reservations/{orderCode}/cancellation-quote`
 * (Issue #381, ADR-0045 D6, contracts section 3.5) - the non-binding refund a
 * shopper would get for cancelling THEIR OWN reservation now: the policy version
 * that applies, the whole hours before arrival, the amount paid and the computed
 * refund, shown BEFORE confirming (UX 4.2). Writes nothing. Identified by a live
 * `customerBearer` or by the order's phone (`?phone=`); the ownership check is
 * part of the query, so an unknown code, another customer's code and another
 * tenant's code are one neutral `404` (controls C-05, C-32). A reservation
 * already decided or past cancelling is `409 INVALID_STATE`. Behind the
 * `booking` feature (off = the neutral `404`).
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

type Outcome =
  | { kind: "unauthenticated" }
  | { kind: "not_found" }
  | { kind: "refused"; refusal: CancelRefusal }
  | { kind: "quote"; body: unknown };

export const GET: APIRoute = async ({
  params,
  url,
  request,
  clientAddress
}) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:booking:cancel-quote:${clientIp}`,
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
  const hasAuthorizationHeader = request.headers.get("authorization") !== null;
  let phone: string | null = null;
  if (!hasAuthorizationHeader) {
    const rawPhone = url.searchParams.get("phone");
    const normalized = rawPhone ? normalizePhoneNumber(rawPhone) : null;
    if (!orderCode || !normalized?.valid) {
      return fail(404, "NOT_FOUND", "Not found.", {}, undefined, {
        vary: "Origin"
      });
    }
    phone = normalized.value;
  }

  const sql = getDatabaseClient();
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
      if (hasAuthorizationHeader) {
        const auth = await requireCustomerSession(request, tx, tenant.tenantId);
        if (!auth.ok) return { kind: "unauthenticated" };
        identity = { kind: "customer", customerId: auth.account.customerId };
      } else {
        identity = { kind: "phone", phone: phone! };
      }

      const link = await fetchReservationLinkForOrderCode(
        tx,
        tenant.tenantId,
        orderCode!,
        identity
      );
      if (!link) return { kind: "not_found" };
      const quoted = await computeCancellationQuote(
        tx,
        tenant.tenantId,
        link,
        await composedBookingPort(),
        { now: new Date(), staff: false }
      );
      if (!quoted.ok) return { kind: "refused", refusal: quoted.refusal };
      return { kind: "quote", body: cancellationQuoteBody(quoted.value.quote) };
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
  if (result.kind === "refused") {
    // An unknown and a foreign reservation never reach this point (they are the
    // neutral 404 above); what is left is the shopper's own reservation's state.
    return cancelRefusalResponse(result.refusal, corsHeaders);
  }
  return ok(result.body, {}, corsHeaders);
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:booking:cancel-quote",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    ["content-type", "authorization"]
  );
