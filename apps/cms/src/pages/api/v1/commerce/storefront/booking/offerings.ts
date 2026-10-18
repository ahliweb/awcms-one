import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../lib/database/client";
import { composedBookingPort } from "../../../../../../lib/composition/booking-port";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../lib/security/env-thresholds";
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { listBookableOfferings } from "../../../../../../modules/commerce/application/booking-storefront-reads";
import { requireCommerceFeatureForPublicRoute } from "../../../../../../modules/commerce/application/commerce-feature-gate";
import { fetchCustomerById } from "../../../../../../modules/commerce/application/customer-directory";
import { requireCustomerSession } from "../../../../../../modules/commerce/application/customer-session-auth";
import { commercePreflightResponse } from "../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../modules/commerce/application/public-commerce-tenant";
import type { CustomerLevel } from "../../../../../../modules/commerce/domain/cart-quote";
import { mediaLibraryPortAdapter } from "../../../../../../modules/media-library/application/media-library-port-adapter";

/**
 * `GET /api/v1/commerce/storefront/booking/offerings` (Issue #386, ADR-0045
 * implementation notes) - the offerings the tenant SELLS online, for the
 * `/booking` service picker: an active offering link, an active service
 * product, and an active `hold_then_confirm` Booking offering. Anonymous; an
 * OPTIONAL live bearer only prices the unit at the customer's level (a dead or
 * absent one is never a failure, like the cart quote). Behind the `booking`
 * feature (off = the neutral `404`).
 *
 * Each item carries the product's public name/slug/image, the live per-night (or
 * per-booking) unit price, the offering's night and party limits, and the ids of
 * the resources the page may probe for availability - ids only, never a name,
 * a unit label or a capacity. The offering's own internal code is not returned.
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
      kind: "listed";
      items: Awaited<ReturnType<typeof listBookableOfferings>>;
    };

export const GET: APIRoute = async ({ request, url, clientAddress }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:booking:offerings:${clientIp}`,
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
  const unknown = [...new Set(url.searchParams.keys())];
  if (unknown.length > 0) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "This route takes no query parameters.",
      {},
      unknown.map((field) => ({
        field,
        message: `${field} is not a known parameter.`
      })),
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
        kind: "listed",
        items: await listBookableOfferings(
          tx,
          tenant.tenantId,
          await composedBookingPort(),
          mediaLibraryPortAdapter,
          customerLevel,
          new Date()
        )
      };
    }
  );

  const headers = { ...corsHeaders, ...NO_STORE };
  if (!result || result.kind === "feature_off") {
    return fail(404, "NOT_FOUND", "Not found.", {}, undefined, headers);
  }
  return ok({ items: result.items }, {}, headers);
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:booking:offerings",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    [...PREFLIGHT_ALLOWED_HEADERS]
  );
