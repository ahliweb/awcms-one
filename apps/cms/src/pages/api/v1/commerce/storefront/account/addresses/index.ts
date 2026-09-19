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
import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../../modules/_shared/api-response";
import {
  createAccountAddress,
  listAccountAddresses
} from "../../../../../../../modules/commerce/application/customer-account-resources";
import { requireCustomerSession } from "../../../../../../../modules/commerce/application/customer-session-auth";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";
import { validateAccountAddressInput } from "../../../../../../../modules/commerce/domain/address-validation";

/**
 * `GET`/`POST /api/v1/commerce/storefront/account/addresses` (Issue #91,
 * contract #86/ADR-0016) — bearer. Max 10 live addresses per account (`409
 * ADDRESS_LIMIT_REACHED`); the FIRST address ever saved becomes the default
 * automatically (`application/customer-account-resources.ts`'s own rule).
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

type AddressListOutcome =
  | { kind: "unauthenticated" }
  | { kind: "blocked" }
  | { kind: "validation_error"; errors: { field: string; message: string }[] }
  | { kind: "limit_reached" }
  | { kind: "list"; items: Awaited<ReturnType<typeof listAccountAddresses>> }
  | {
      kind: "created";
      address: Extract<
        Awaited<ReturnType<typeof createAccountAddress>>,
        { kind: "created" }
      >["address"];
    };

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
    "commerce:account:addresses:list"
  );
  if (limited) return limited;

  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant): Promise<AddressListOutcome> => {
      const authOutcome = await requireCustomerSession(
        request,
        tx,
        tenant.tenantId
      );
      if (!authOutcome.ok) return { kind: "unauthenticated" };
      if (authOutcome.account.status === "blocked") return { kind: "blocked" };

      const items = await listAccountAddresses(
        tx,
        tenant.tenantId,
        authOutcome.account.customerId
      );
      return { kind: "list", items };
    }
  );

  return respond(result, corsHeaders);
};

export const POST: APIRoute = async ({ request, clientAddress, locals }) => {
  const limited = await rateLimited(
    request,
    clientAddress,
    "commerce:account:addresses:create"
  );
  if (limited) return limited;

  const bodyRead = await readJsonBody(request);
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

  const validation = validateAccountAddressInput(bodyRead.value);

  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant): Promise<AddressListOutcome> => {
      const authOutcome = await requireCustomerSession(
        request,
        tx,
        tenant.tenantId
      );
      if (!authOutcome.ok) return { kind: "unauthenticated" };
      if (authOutcome.account.status === "blocked") return { kind: "blocked" };

      if (!validation.valid) {
        return { kind: "validation_error", errors: validation.errors };
      }

      const outcome = await createAccountAddress(
        tx,
        tenant.tenantId,
        authOutcome.account.customerId,
        validation.value,
        locals.correlationId
      );

      if (outcome.kind === "limit_reached") return { kind: "limit_reached" };
      return { kind: "created", address: outcome.address };
    }
  );

  return respond(result, corsHeaders);
};

function respond(
  result: AddressListOutcome | null,
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
  if (result.kind === "limit_reached") {
    return fail(
      409,
      "ADDRESS_LIMIT_REACHED",
      "Maximum number of saved addresses reached.",
      {},
      undefined,
      corsHeaders
    );
  }
  if (result.kind === "created") {
    return jsonResponse(
      { success: true, data: { address: result.address }, meta: {} },
      { status: 201, headers: corsHeaders }
    );
  }
  return ok({ items: result.items }, {}, corsHeaders);
}

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:account:addresses",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    PREFLIGHT_ALLOWED_HEADERS
  );
