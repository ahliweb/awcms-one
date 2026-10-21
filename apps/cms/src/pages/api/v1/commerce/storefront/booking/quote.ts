import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../lib/database/client";
import { composedBookingPort } from "../../../../../../lib/composition/booking-port";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../lib/security/env-thresholds";
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { quoteStorefrontBooking } from "../../../../../../modules/commerce/application/booking-storefront-reads";
import { requireCommerceFeatureForPublicRoute } from "../../../../../../modules/commerce/application/commerce-feature-gate";
import { fetchCustomerById } from "../../../../../../modules/commerce/application/customer-directory";
import { requireCustomerSession } from "../../../../../../modules/commerce/application/customer-session-auth";
import { commercePreflightResponse } from "../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../modules/commerce/application/public-commerce-tenant";
import type { CustomerLevel } from "../../../../../../modules/commerce/domain/cart-quote";
import { validateQuoteQuery } from "../../../../../../modules/commerce/domain/booking-storefront-reads";
import { mediaLibraryPortAdapter } from "../../../../../../modules/media-library/application/media-library-port-adapter";

/**
 * `GET /api/v1/commerce/storefront/booking/quote` (Issue #386, ADR-0045
 * implementation notes) - the non-binding server quote of a stay (or a
 * time-slot booking): the NIGHTS, the unit price, tax, total, and the deposit
 * and balance the shopper would owe if they choose `dp`. Nothing is written and
 * nothing is held; a quote is not a promise (only the hold is).
 *
 * The storefront never computes a night or a total: it sends the two dates and
 * shows what comes back. The figures are `buildCartQuote`'s with
 * `bookingSale: true` - the same call the hold-to-order path re-quotes with - at
 * the signed-in customer's level when a live bearer is presented (a dead or
 * absent one is never a failure). An offering that is not sold is the neutral
 * `404`; a stay outside the offering's min/max nights, or dates for a slot
 * offering, is `400 VALIDATION_ERROR`; the `booking` feature off is `404`.
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
const PREFLIGHT_ALLOWED_HEADERS = ["content-type", "authorization"] as const;

type Outcome =
  | { kind: "feature_off" }
  | {
      kind: "quoted";
      quote: Awaited<ReturnType<typeof quoteStorefrontBooking>>;
    };

export const GET: APIRoute = async ({ request, url, clientAddress }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:booking:quote:${clientIp}`,
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

  const now = new Date();
  const validation = validateQuoteQuery(url.searchParams, now);
  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Invalid quote request.",
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

      const auth = await requireCustomerSession(request, tx, tenant.tenantId);
      let customerLevel: CustomerLevel | null = null;
      if (auth.ok) {
        const customer = await fetchCustomerById(
          tx,
          tenant.tenantId,
          auth.account.customerId
        );
        if (customer && customer.level >= 1 && customer.level <= 4) {
          customerLevel = customer.level as CustomerLevel;
        }
      }
      return {
        kind: "quoted",
        quote: await quoteStorefrontBooking(
          tx,
          tenant.tenantId,
          await composedBookingPort(),
          mediaLibraryPortAdapter,
          validation.value,
          customerLevel,
          now
        )
      };
    }
  );

  const headers = { ...corsHeaders, ...NO_STORE };
  if (!result || result.kind === "feature_off") {
    return fail(404, "NOT_FOUND", "Not found.", {}, undefined, headers);
  }
  const quote = result.quote;
  if (quote.kind === "not_found") {
    return fail(404, "NOT_FOUND", "Not found.", {}, undefined, headers);
  }
  if (quote.kind === "invalid") {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Invalid quote request.",
      {},
      quote.errors,
      headers
    );
  }
  return ok(quote.body, {}, headers);
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:booking:quote",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    [...PREFLIGHT_ALLOWED_HEADERS]
  );
