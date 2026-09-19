import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../../lib/security/env-thresholds";
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import {
  ACCOUNT_ORDER_LIST_DEFAULT_LIMIT,
  ACCOUNT_ORDER_LIST_MAX_LIMIT,
  listOrdersForAccount
} from "../../../../../../../modules/commerce/application/order-directory";
import { requireCustomerSession } from "../../../../../../../modules/commerce/application/customer-session-auth";
import { mediaLibraryPortAdapter } from "../../../../../../../modules/media-library/application/media-library-port-adapter";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../../../modules/_shared/keyset-pagination";

/**
 * `GET /api/v1/commerce/storefront/account/orders` (Issue #91) — bearer,
 * keyset, `created_at >= account.historyFrom` (ADR-0016 D4) enforced INSIDE
 * `listOrdersForAccount`'s own query.
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
  | { kind: "validation_error" }
  | { kind: "page"; page: Awaited<ReturnType<typeof listOrdersForAccount>> };

export const GET: APIRoute = async ({ request, url, clientAddress }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:account:orders:list:${clientIp}`,
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

  const cursorParam = url.searchParams.get("cursor");
  const decodedCursor: KeysetCursor | null = cursorParam
    ? decodeKeysetCursor(cursorParam)
    : null;
  const cursorMalformed = cursorParam !== null && decodedCursor === null;

  const limitParam = url.searchParams.get("limit");
  const limit = limitParam
    ? Math.min(
        Math.max(
          1,
          Number.parseInt(limitParam, 10) || ACCOUNT_ORDER_LIST_DEFAULT_LIMIT
        ),
        ACCOUNT_ORDER_LIST_MAX_LIMIT
      )
    : ACCOUNT_ORDER_LIST_DEFAULT_LIMIT;

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
      if (cursorMalformed) return { kind: "validation_error" };

      const page = await listOrdersForAccount(
        tx,
        tenant.tenantId,
        mediaLibraryPortAdapter,
        authOutcome.account.customerId,
        new Date(authOutcome.account.historyFrom),
        decodedCursor,
        limit
      );
      return { kind: "page", page };
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
      "cursor is malformed.",
      {},
      undefined,
      corsHeaders
    );
  }
  return ok(
    { items: result.page.items, nextCursor: result.page.nextCursor },
    {},
    corsHeaders
  );
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:account:orders:list",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    PREFLIGHT_ALLOWED_HEADERS
  );
