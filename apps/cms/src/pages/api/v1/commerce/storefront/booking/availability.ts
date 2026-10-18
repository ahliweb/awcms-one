import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../lib/database/client";
import { composedBookingPort } from "../../../../../../lib/composition/booking-port";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../lib/security/env-thresholds";
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { answerStorefrontAvailability } from "../../../../../../modules/commerce/application/booking-storefront-reads";
import { requireCommerceFeatureForPublicRoute } from "../../../../../../modules/commerce/application/commerce-feature-gate";
import { commercePreflightResponse } from "../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../modules/commerce/application/public-commerce-tenant";
import { validateAvailabilityQuery } from "../../../../../../modules/commerce/domain/booking-storefront-reads";

/**
 * `GET /api/v1/commerce/storefront/booking/availability` (Issue #386, ADR-0045
 * implementation notes) - the ANONYMOUS availability read behind `/booking`.
 * The tenant is resolved from the request's `Origin`/host exactly like every
 * other storefront commerce route; there is no tenant, customer or resource-name
 * parameter. For one LINKED offering and one resource it answers a stay's
 * free-unit count (`checkInDate` + `checkOutDate`) or the free slots of a window
 * (`from` + `to`) through `BookingPort.availability` (contract 1.1.0).
 *
 * What it never returns: a resource name or unit label, a reservation, a block,
 * the staff who serve a slot, any customer data or the tenant's policy. The
 * body is an allow-list built field by field (`availabilityBody`), and an
 * unavailable stay is always `available: false` + `SLOT_UNAVAILABLE` whatever
 * the cause (booked, blocked, min/max stay, lead time, horizon). An offering
 * that is unknown, another tenant's, unlinked, inactive or not sold is ONE
 * `404 NOT_FOUND`; bad input is `400 VALIDATION_ERROR` (unknown query keys
 * included); the `booking` feature off is the same neutral `404`.
 *
 * Bounded and rate-limited (the port bounds one call; a public page is the
 * caller that loops): the window is at most 366 nights / 31 days of slots and
 * 730 days ahead, and the route shares the storefront limiter's thresholds on
 * its own bucket. Never cached - the answer changes with every hold, and the
 * tenant comes from `Origin` - so `Cache-Control: no-store` (no existing public
 * commerce read is cacheable either).
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
const NO_STORE = { "cache-control": "no-store" } as const;

type Outcome =
  | { kind: "feature_off" }
  | {
      kind: "answered";
      answer: Awaited<ReturnType<typeof answerStorefrontAvailability>>;
    };

export const GET: APIRoute = async ({ request, url, clientAddress }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:booking:availability:${clientIp}`,
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 }
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
        vary: "Origin",
        ...NO_STORE
      }
    );
  }

  const validation = validateAvailabilityQuery(url.searchParams, new Date());
  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Invalid availability request.",
      {},
      validation.errors,
      { vary: "Origin", ...NO_STORE }
    );
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
      if (gate) return { kind: "feature_off" };
      return {
        kind: "answered",
        answer: await answerStorefrontAvailability(
          tx,
          tenant.tenantId,
          await composedBookingPort(),
          validation.value
        )
      };
    }
  );

  const headers = { ...corsHeaders, ...NO_STORE };
  if (!result || result.kind === "feature_off") {
    return fail(404, "NOT_FOUND", "Not found.", {}, undefined, headers);
  }
  if (result.answer.kind === "refused") {
    return fail(
      result.answer.status,
      result.answer.code,
      result.answer.message,
      {},
      undefined,
      headers
    );
  }
  return ok(result.answer.body, {}, headers);
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:booking:availability",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    ["content-type"]
  );
