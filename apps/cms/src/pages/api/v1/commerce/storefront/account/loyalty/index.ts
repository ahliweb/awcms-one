import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../../lib/security/env-thresholds";
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { requireCustomerSession } from "../../../../../../../modules/commerce/application/customer-session-auth";
import {
  fetchCustomerLoyaltyOverview,
  isLoyaltyEnabled,
  LOYALTY_LEDGER_DEFAULT_LIMIT,
  LOYALTY_LEDGER_MAX_LIMIT,
  type CustomerLoyaltyOverview
} from "../../../../../../../modules/commerce/application/loyalty-ledger";
import { readPageParams } from "../../../../../../../modules/commerce/application/loyalty-route-support";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";

/**
 * `GET /api/v1/commerce/storefront/account/loyalty` (Issue #289) — the
 * signed-in customer's OWN points balance, the earn rule currently in force,
 * and their point history (newest first, keyset-paginated). Bearer-secured
 * exactly like `account/entitlements` (ADR-0016 D3): the customer id is read
 * ONLY from the verified session, never from a query parameter or the path,
 * so there is no identifier a caller could change to read another customer's
 * ledger (BOLA by construction), and every query below filters on it.
 *
 * What a customer sees is deliberately narrower than the staff ledger: each
 * history item is `{ id, kind, points, balanceAfter, expiresAt, createdAt }` —
 * never the actor, the free-text reason a staff member typed, the source order
 * id or the program id.
 *
 * A tenant that has not turned the `loyalty` feature on answers the neutral
 * `404` every other disabled/unknown public case does (`domain/commerce-
 * features.ts`'s 409-vs-404 rule).
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
const PREFLIGHT_ALLOWED_HEADERS = ["content-type", "authorization"] as const;

type Outcome =
  | { kind: "unauthenticated" }
  | { kind: "blocked" }
  | { kind: "not_found" }
  | { kind: "validation_error"; message: string }
  | { kind: "page"; body: CustomerLoyaltyOverview };

export const GET: APIRoute = async ({ request, url, clientAddress }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:account:loyalty:${clientIp}`,
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
        vary: "Origin"
      }
    );
  }

  const page = readPageParams(
    url,
    LOYALTY_LEDGER_DEFAULT_LIMIT,
    LOYALTY_LEDGER_MAX_LIMIT
  );

  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant): Promise<Outcome> => {
      const authOutcome = await requireCustomerSession(
        request,
        tx,
        tenant.tenantId
      );
      if (!authOutcome.ok) return { kind: "unauthenticated" };
      if (authOutcome.account.status === "blocked") return { kind: "blocked" };
      if (!page.ok) return { kind: "validation_error", message: page.message };

      if (!(await isLoyaltyEnabled(tx, tenant.tenantId))) {
        return { kind: "not_found" };
      }

      return {
        kind: "page",
        body: await fetchCustomerLoyaltyOverview(
          tx,
          tenant.tenantId,
          // The customer comes ONLY from the verified session.
          authOutcome.account.customerId,
          { cursor: page.cursor, limit: page.limit },
          new Date()
        )
      };
    }
  );

  if (!result || result.kind === "unauthenticated") {
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
      "This account has been blocked.",
      {},
      undefined,
      corsHeaders
    );
  }
  if (result.kind === "validation_error") {
    return fail(
      400,
      "VALIDATION_ERROR",
      result.message,
      {},
      undefined,
      corsHeaders
    );
  }
  if (result.kind === "not_found") {
    return fail(
      404,
      "RESOURCE_NOT_FOUND",
      "Not found.",
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
    "commerce:account:loyalty",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    PREFLIGHT_ALLOWED_HEADERS
  );
