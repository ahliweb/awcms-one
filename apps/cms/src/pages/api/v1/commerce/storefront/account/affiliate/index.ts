import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../../lib/security/env-thresholds";
import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../../modules/_shared/api-response";
import {
  AffiliateProgramDisabledError,
  enrolAffiliate,
  fetchAccountAffiliate,
  type AccountAffiliateRecord
} from "../../../../../../../modules/commerce/application/affiliate-directory";
import { requireCustomerSession } from "../../../../../../../modules/commerce/application/customer-session-auth";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";

/**
 * `GET`/`POST /api/v1/commerce/storefront/account/affiliate` (Issue #92,
 * contract #86's D5) — bearer. `GET` never 404s (`{affiliate: null}` for an
 * account that has not enrolled); `POST` enrols (idempotent — a
 * second call returns the same row, see `affiliate-directory.ts`'s
 * `enrolAffiliate`) or answers `409 AFFILIATE_PROGRAM_DISABLED` when the
 * tenant's program is off. Matches
 * `apps/storefront/src/lib/akun-klien.ts`'s `ambilAfiliasi`/`gabungAfiliasi`
 * contract exactly.
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
  | { kind: "program_disabled" }
  | { kind: "affiliate"; affiliate: AccountAffiliateRecord | null };

async function rateLimited(
  request: Request,
  clientAddress: string,
  scope: string
): Promise<Response | null> {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(`${scope}:${clientIp}`, {
    maxAttempts: RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_SEC * 1000
  });
  if (rateLimit.allowed) return null;
  return fail(
    429,
    "RATE_LIMITED",
    "Too many requests. Try again later.",
    {},
    undefined,
    { "retry-after": String(rateLimit.retryAfterSec), vary: "Origin" }
  );
}

export const GET: APIRoute = async ({ request, clientAddress }) => {
  const limited = await rateLimited(
    request,
    clientAddress,
    "commerce:account:affiliate:get"
  );
  if (limited) return limited;

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

      const affiliate = await fetchAccountAffiliate(
        tx,
        tenant.tenantId,
        authOutcome.account.customerId
      );
      return { kind: "affiliate", affiliate };
    }
  );

  return respond(result, corsHeaders);
};

export const POST: APIRoute = async ({ request, clientAddress, locals }) => {
  const limited = await rateLimited(
    request,
    clientAddress,
    "commerce:account:affiliate:enrol"
  );
  if (limited) return limited;

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

      try {
        const affiliate = await enrolAffiliate(
          tx,
          tenant.tenantId,
          authOutcome.account.customerId,
          locals.correlationId
        );
        return { kind: "affiliate", affiliate };
      } catch (error) {
        if (error instanceof AffiliateProgramDisabledError) {
          return { kind: "program_disabled" };
        }
        throw error;
      }
    }
  );

  return respond(result, corsHeaders, true);
};

function respond(
  result: Outcome | null,
  corsHeaders: Record<string, string>,
  isEnrol = false
): Response {
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
  if (result.kind === "program_disabled") {
    return fail(
      409,
      "AFFILIATE_PROGRAM_DISABLED",
      "The affiliate program is not enabled for this store.",
      {},
      undefined,
      corsHeaders
    );
  }
  if (isEnrol) {
    return jsonResponse(
      { success: true, data: { affiliate: result.affiliate }, meta: {} },
      { status: 201, headers: corsHeaders }
    );
  }
  return ok({ affiliate: result.affiliate }, {}, corsHeaders);
}

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:account:affiliate",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    PREFLIGHT_ALLOWED_HEADERS
  );
