import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../../lib/security/env-thresholds";
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { listPracticeIrmDomains } from "../../../../../../../modules/practice-irm/application/practice-irm-domain-directory";
import { verifyEntitlement } from "../../../../../../../modules/commerce/application/commerce-entitlement-directory";
import { requireCustomerSession } from "../../../../../../../modules/commerce/application/customer-session-auth";
import { practiceIrmPreflightResponse } from "../../../../../../../modules/practice-irm/application/public-practice-irm-preflight";
import { withPublicPracticeIrmTenant } from "../../../../../../../modules/practice-irm/application/public-practice-irm-tenant";

/**
 * `GET /api/v1/practice-irm/storefront/account/content?productId=` (Issue
 * #270) — the five IRM domains' current content, for a customer entitled
 * to `productId`. Entitlement is checked EVERY call, no cache — a customer
 * without an active entitlement for `productId` gets `403` and never sees
 * this content, per PRD.
 */
const RATE_LIMIT_MAX = parsePositiveIntSetting(
  process.env.PRACTICE_IRM_STOREFRONT_RATE_LIMIT_MAX,
  60,
  "PRACTICE_IRM_STOREFRONT_RATE_LIMIT_MAX"
);
const RATE_LIMIT_WINDOW_SEC = parsePositiveIntSetting(
  process.env.PRACTICE_IRM_STOREFRONT_RATE_LIMIT_WINDOW_SEC,
  60,
  "PRACTICE_IRM_STOREFRONT_RATE_LIMIT_WINDOW_SEC"
);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Outcome =
  | { kind: "unauthenticated" }
  | { kind: "blocked" }
  | { kind: "validation_error" }
  | { kind: "forbidden" }
  | { kind: "ok"; domains: Awaited<ReturnType<typeof listPracticeIrmDomains>> };

export const GET: APIRoute = async ({ request, url, clientAddress }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `practice_irm:account:content:read:${clientIp}`,
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

  const productId = url.searchParams.get("productId");
  const productIdMalformed = !productId || !UUID_PATTERN.test(productId);

  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicPracticeIrmTenant(
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
      if (productIdMalformed) return { kind: "validation_error" };

      const entitlement = await verifyEntitlement(
        tx,
        tenant.tenantId,
        authOutcome.account.customerId,
        productId
      );
      if (!entitlement) return { kind: "forbidden" };

      return {
        kind: "ok",
        domains: await listPracticeIrmDomains(tx, tenant.tenantId)
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
      "productId must be a valid uuid.",
      {},
      undefined,
      corsHeaders
    );
  }
  if (result.kind === "forbidden") {
    return fail(
      403,
      "ENTITLEMENT_REQUIRED",
      "You do not have an active entitlement for this product.",
      {},
      undefined,
      corsHeaders
    );
  }

  return ok({ items: result.domains }, {}, corsHeaders);
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  practiceIrmPreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "practice_irm:account:content",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 }
  );
