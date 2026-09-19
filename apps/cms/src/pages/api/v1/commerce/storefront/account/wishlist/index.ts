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
  ACCOUNT_WISHLIST_LIMIT,
  listAccountWishlist,
  mergeAccountWishlist
} from "../../../../../../../modules/commerce/application/customer-account-resources";
import { requireCustomerSession } from "../../../../../../../modules/commerce/application/customer-session-auth";
import { mediaLibraryPortAdapter } from "../../../../../../../modules/media-library/application/media-library-port-adapter";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";

/**
 * `GET`/`PUT /api/v1/commerce/storefront/account/wishlist` (Issue #91) —
 * bearer. `PUT` union-merges `{productIds}` into whatever the account
 * already has, max {@link ACCOUNT_WISHLIST_LIMIT}, and returns the merged,
 * authoritative list.
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
  | { kind: "limit_reached" }
  | { kind: "list"; items: Awaited<ReturnType<typeof listAccountWishlist>> };

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
    {
      "retry-after": String(rateLimit.retryAfterSec),
      vary: "Origin"
    }
  );
}

export const GET: APIRoute = async ({ request, clientAddress }) => {
  const limited = await rateLimited(
    request,
    clientAddress,
    "commerce:account:wishlist:list"
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

      const items = await listAccountWishlist(
        tx,
        tenant.tenantId,
        authOutcome.account.customerId,
        mediaLibraryPortAdapter
      );
      return { kind: "list", items };
    }
  );

  return respond(result, corsHeaders);
};

export const PUT: APIRoute = async ({ request, clientAddress, locals }) => {
  const limited = await rateLimited(
    request,
    clientAddress,
    "commerce:account:wishlist:merge"
  );
  if (limited) return limited;

  const bodyRead = await readJsonBody(request);
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

  const body = (bodyRead.value ?? {}) as Record<string, unknown>;
  const rawIds = Array.isArray(body.productIds) ? body.productIds : null;
  const shapeValid =
    rawIds !== null && rawIds.every((id) => typeof id === "string");
  const productIds = shapeValid ? (rawIds as string[]) : [];

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

      if (!shapeValid) {
        return {
          kind: "validation_error",
          errors: [
            {
              field: "productIds",
              message: "productIds must be an array of strings."
            }
          ]
        };
      }

      const outcome = await mergeAccountWishlist(
        tx,
        tenant.tenantId,
        authOutcome.account.customerId,
        productIds,
        mediaLibraryPortAdapter,
        locals.correlationId
      );

      if (outcome.kind === "limit_reached") return { kind: "limit_reached" };
      return { kind: "list", items: outcome.items };
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
      "Invalid request.",
      {},
      result.errors,
      corsHeaders
    );
  }
  if (result.kind === "limit_reached") {
    return fail(
      409,
      "WISHLIST_LIMIT_REACHED",
      "Maximum wishlist size reached.",
      {},
      undefined,
      corsHeaders
    );
  }
  return ok({ items: result.items }, {}, corsHeaders);
}

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:account:wishlist",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    PREFLIGHT_ALLOWED_HEADERS
  );
