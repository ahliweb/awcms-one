import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../../lib/security/env-thresholds";
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { listAccountAffiliateCommissions } from "../../../../../../../modules/commerce/application/affiliate-directory";
import { requireCustomerSession } from "../../../../../../../modules/commerce/application/customer-session-auth";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../../../modules/_shared/keyset-pagination";

/**
 * `GET /api/v1/commerce/storefront/account/affiliate/commissions`
 * (Issue #92) — bearer, keyset. An account that has not enrolled gets an
 * empty page, not an error (`affiliate-directory.ts`'s
 * `listAccountAffiliateCommissions`). Matches
 * `apps/storefront/src/lib/akun-klien.ts`'s `ambilKomisiAfiliasi` contract
 * exactly: `data: {items, nextCursor}`.
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
  | {
      kind: "page";
      page: Awaited<ReturnType<typeof listAccountAffiliateCommissions>>;
    };

export const GET: APIRoute = async ({ request, url, clientAddress }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:account:affiliate:commissions:${clientIp}`,
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

  const cursorParam = url.searchParams.get("cursor");
  const decodedCursor: KeysetCursor | null = cursorParam
    ? decodeKeysetCursor(cursorParam)
    : null;
  const cursorMalformed = cursorParam !== null && decodedCursor === null;

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

      const page = await listAccountAffiliateCommissions(
        tx,
        tenant.tenantId,
        authOutcome.account.customerId,
        decodedCursor
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
    "commerce:account:affiliate:commissions",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    PREFLIGHT_ALLOWED_HEADERS
  );
