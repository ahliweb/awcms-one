import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../../lib/security/env-thresholds";
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import {
  reservationRefundSummary,
  reservationViewBody
} from "../../../../../../../modules/commerce/application/booking-adapter-http";
import { fetchDecisionForLink } from "../../../../../../../modules/commerce/application/booking-cancellation";
import { buildReservationView } from "../../../../../../../modules/commerce/application/booking-hold-to-order";
import {
  fetchReservationLinkForOrderCode,
  type OwnReservationIdentity
} from "../../../../../../../modules/commerce/application/booking-reservation-links";
import { requireCommerceFeatureForPublicRoute } from "../../../../../../../modules/commerce/application/commerce-feature-gate";
import { requireCustomerSession } from "../../../../../../../modules/commerce/application/customer-session-auth";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";
import { normalizePhoneNumber } from "../../../../../../../modules/commerce/domain/phone-normalisation";

/**
 * `GET /api/v1/commerce/storefront/booking/reservations/{orderCode}` (Issue
 * #380, contracts section 3.4) - a shopper's OWN reservation: Booking's status
 * and dates and the ledger-derived settlement ("deposit paid Rp X, balance due
 * Rp Y"). Identified by a live `customerBearer` (the account's own customer) or
 * by the order's phone (`?phone=`); the ownership check is part of the query, so
 * an unknown code, another customer's code and another tenant's code are one
 * neutral `404` (controls C-05, C-32). The staff attention flag is never in this
 * body. A presented-but-dead bearer is `401 UNAUTHENTICATED`. Behind the
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
  | { kind: "found"; body: unknown };

export const GET: APIRoute = async ({
  params,
  url,
  request,
  clientAddress
}) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:booking:read:${clientIp}`,
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
  const rawPhone = url.searchParams.get("phone");
  let phone: string | null = null;
  if (!hasAuthorizationHeader) {
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
      const view = await buildReservationView(tx, tenant.tenantId, link);
      if (!view) return { kind: "not_found" };
      const decision = await fetchDecisionForLink(tx, tenant.tenantId, link.id);
      return {
        kind: "found",
        body: reservationViewBody(
          view,
          null,
          reservationRefundSummary(decision, "shopper")
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
  return ok(result.body, {}, corsHeaders);
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:booking:read",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    ["content-type", "authorization"]
  );
