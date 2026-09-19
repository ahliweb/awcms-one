import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../../../lib/security/env-thresholds";
import { fail, ok } from "../../../../../../../../modules/_shared/api-response";
import { fetchConversationForAccount } from "../../../../../../../../modules/commerce/application/conversation-directory";
import { requireCustomerSession } from "../../../../../../../../modules/commerce/application/customer-session-auth";
import { commercePreflightResponse } from "../../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../../modules/commerce/application/public-commerce-tenant";

/**
 * `GET /api/v1/commerce/storefront/account/conversations/{id}` (Issue #111)
 * — bearer, per the storefront's own `ambilPercakapanById` (`akun-klien.ts`):
 * the thread's own header + every message, oldest first. Marks the thread
 * read for the CUSTOMER as a side effect (`fetchConversationForAccount`'s
 * own contract). `404 NOT_FOUND` for an unknown conversation or one that is
 * not this account's own — the same neutral 404 either way.
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

export const GET: APIRoute = async ({ request, clientAddress, params }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:account:conversations:detail:${clientIp}`,
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

  const conversationId = params.id;
  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (
      tx,
      tenant
    ): Promise<
      | "unauthenticated"
      | "blocked"
      | "not_found"
      | Awaited<ReturnType<typeof fetchConversationForAccount>>
    > => {
      const authOutcome = await requireCustomerSession(
        request,
        tx,
        tenant.tenantId
      );
      if (!authOutcome.ok) return "unauthenticated";
      if (authOutcome.account.status === "blocked") return "blocked";
      if (!conversationId) return "not_found";

      const thread = await fetchConversationForAccount(
        tx,
        tenant.tenantId,
        authOutcome.account.id,
        conversationId
      );
      return thread ?? "not_found";
    }
  );

  if (!result || result === "unauthenticated") {
    return fail(
      401,
      "UNAUTHENTICATED",
      "Missing, invalid, or expired session.",
      {},
      undefined,
      corsHeaders
    );
  }
  if (result === "blocked") {
    return fail(
      403,
      "ACCOUNT_BLOCKED",
      "This account has been blocked.",
      {},
      undefined,
      corsHeaders
    );
  }
  if (result === "not_found") {
    return fail(404, "NOT_FOUND", "Not found.", {}, undefined, corsHeaders);
  }
  return ok(result, {}, corsHeaders);
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:account:conversations:detail",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    PREFLIGHT_ALLOWED_HEADERS
  );
