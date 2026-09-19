import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../../lib/security/env-thresholds";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import {
  deleteAccountAddress,
  updateAccountAddress
} from "../../../../../../../modules/commerce/application/customer-account-resources";
import { requireCustomerSession } from "../../../../../../../modules/commerce/application/customer-session-auth";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";
import { validateAccountAddressInput } from "../../../../../../../modules/commerce/domain/address-validation";

/**
 * `PATCH`/`DELETE /api/v1/commerce/storefront/account/addresses/{id}`
 * (Issue #91) — bearer. Deleting the default address promotes the
 * most-recently-created remaining one
 * (`application/customer-account-resources.ts`'s own rule).
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
  | { kind: "validation_error"; errors: { field: string; message: string }[] }
  | { kind: "not_found" }
  | {
      kind: "updated";
      address: Awaited<ReturnType<typeof updateAccountAddress>>;
    }
  | { kind: "deleted" };

async function rateLimited(
  request: Request,
  clientAddress: string
): Promise<Response | null> {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:account:addresses:mutate:${clientIp}`,
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 }
  );
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

export const PATCH: APIRoute = async ({
  request,
  clientAddress,
  params,
  locals
}) => {
  const limited = await rateLimited(request, clientAddress);
  if (limited) return limited;

  const addressId = params.id;
  const bodyRead = await readJsonBody(request);
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

  const validation = validateAccountAddressInput(bodyRead.value);

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
      if (!addressId) return { kind: "not_found" };

      if (!validation.valid) {
        return { kind: "validation_error", errors: validation.errors };
      }

      const address = await updateAccountAddress(
        tx,
        tenant.tenantId,
        authOutcome.account.customerId,
        addressId,
        validation.value,
        locals.correlationId
      );
      if (!address) return { kind: "not_found" };
      return { kind: "updated", address };
    }
  );

  return respond(result, corsHeaders);
};

export const DELETE: APIRoute = async ({
  request,
  clientAddress,
  params,
  locals
}) => {
  const limited = await rateLimited(request, clientAddress);
  if (limited) return limited;

  const addressId = params.id;
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
      if (!addressId) return { kind: "not_found" };

      const deleted = await deleteAccountAddress(
        tx,
        tenant.tenantId,
        authOutcome.account.customerId,
        addressId,
        locals.correlationId
      );
      if (!deleted) return { kind: "not_found" };
      return { kind: "deleted" };
    }
  );

  return respond(result, corsHeaders);
};

function respond(
  result: Outcome | null,
  corsHeaders: Record<string, string>
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
  if (result.kind === "validation_error") {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Invalid address.",
      {},
      result.errors,
      corsHeaders
    );
  }
  if (result.kind === "not_found") {
    return fail(404, "NOT_FOUND", "Not found.", {}, undefined, corsHeaders);
  }
  if (result.kind === "deleted") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return ok({ address: result.address }, {}, corsHeaders);
}

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:account:addresses:mutate",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    PREFLIGHT_ALLOWED_HEADERS
  );
