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
import { decodeKeysetCursor } from "../../../../../../../modules/_shared/keyset-pagination";
import { listConversationsForAccount } from "../../../../../../../modules/commerce/application/conversation-directory";
import { requireCustomerSession } from "../../../../../../../modules/commerce/application/customer-session-auth";
import { fetchCommerceFeatures } from "../../../../../../../modules/commerce/application/commerce-feature-gate";
import { validateOpenConversationInput } from "../../../../../../../modules/commerce/domain/conversation-validation";
import { commerceIdempotentPreflightHeaders } from "../../../../../../../modules/commerce/domain/commerce-cors";
import {
  openConversationIdempotent,
  type OpenConversationIdempotentOutcome
} from "../../../../../../../modules/commerce/application/storefront-idempotent-mutations";
import {
  readStorefrontIdempotencyKey,
  storefrontIdempotencyConflictResponse
} from "../../../../../../../modules/commerce/application/storefront-idempotency-http";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";

/**
 * `GET`/`POST /api/v1/commerce/storefront/account/conversations` (Issue
 * #111, contract #106 D8) — bearer. `GET` per the storefront's own
 * `ambilPercakapan` (`akun-klien.ts`): keyset-paginated, newest-activity
 * first. `POST` per `buatPercakapan`: opens a thread with its own first
 * (customer) message, `201 {conversation, message}`.
 *
 * `POST` takes an OPTIONAL `Idempotency-Key` (Issue #513, unit C): a repeat
 * opens a second thread, so the same key + same subject/body replays the
 * original `201` (`data.replayed: true`, no second thread, no second message,
 * and it does not spend the per-account post limit); another request under the
 * same key is `409 IDEMPOTENCY_CONFLICT`.
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
/** 10 posts per hour per ACCOUNT (Issue #111's own rate limit, keyed by account id, not IP — unlike every other limiter in this file). */
const CONVERSATION_POST_RATE_LIMIT_MAX = parsePositiveIntSetting(
  process.env.COMMERCE_CONVERSATION_POST_RATE_LIMIT_MAX,
  10,
  "COMMERCE_CONVERSATION_POST_RATE_LIMIT_MAX"
);
const CONVERSATION_POST_RATE_LIMIT_WINDOW_SEC = 60 * 60;
const PREFLIGHT_ALLOWED_HEADERS = commerceIdempotentPreflightHeaders([
  "content-type",
  "authorization"
]);

type ListOutcome =
  | { kind: "feature_disabled" }
  | { kind: "unauthenticated" }
  | { kind: "blocked" }
  | { kind: "validation_error"; errors: { field: string; message: string }[] }
  | {
      kind: "list";
      page: Awaited<ReturnType<typeof listConversationsForAccount>>;
    };

type CreateOutcome =
  | { kind: "feature_disabled" }
  | { kind: "unauthenticated" }
  | { kind: "blocked" }
  | { kind: "validation_error"; errors: { field: string; message: string }[] }
  | OpenConversationIdempotentOutcome;

/** Issue #118 — a disabled `inbox` feature answers the SAME neutral 404 shape an unresolvable tenant does; `withPublicCommerceTenant` already collapses those two together (its own header), so a disabled feature must too, never a 409 that would tell an anonymous caller the route exists. */
const NEUTRAL_NOT_FOUND = (corsHeaders: Record<string, string>) =>
  fail(404, "NOT_FOUND", "Not found.", {}, undefined, corsHeaders);

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

export const GET: APIRoute = async ({ request, clientAddress, url }) => {
  const limited = await rateLimited(
    request,
    clientAddress,
    "commerce:account:conversations:list"
  );
  if (limited) return limited;

  const cursorParam = url.searchParams.get("cursor");
  const cursor = cursorParam ? decodeKeysetCursor(cursorParam) : null;
  if (cursorParam && !cursor) {
    return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
  }

  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant): Promise<ListOutcome> => {
      const features = await fetchCommerceFeatures(tx, tenant.tenantId);
      if (!features.inbox) return { kind: "feature_disabled" };

      const authOutcome = await requireCustomerSession(
        request,
        tx,
        tenant.tenantId
      );
      if (!authOutcome.ok) return { kind: "unauthenticated" };
      if (authOutcome.account.status === "blocked") return { kind: "blocked" };

      const page = await listConversationsForAccount(
        tx,
        tenant.tenantId,
        authOutcome.account.id,
        cursor
      );
      return { kind: "list", page };
    }
  );

  return respondList(result, corsHeaders);
};

export const POST: APIRoute = async ({ request, clientAddress, locals }) => {
  const limited = await rateLimited(
    request,
    clientAddress,
    "commerce:account:conversations:create"
  );
  if (limited) return limited;

  const idempotency = readStorefrontIdempotencyKey(request);
  if ("response" in idempotency) return idempotency.response;

  const bodyRead = await readJsonBody(request);
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

  const validation = validateOpenConversationInput(bodyRead.value);

  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant): Promise<CreateOutcome> => {
      const features = await fetchCommerceFeatures(tx, tenant.tenantId);
      if (!features.inbox) return { kind: "feature_disabled" };

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

      const accountId = authOutcome.account.id;
      return openConversationIdempotent(
        tx,
        tenant.tenantId,
        accountId,
        validation.value,
        {
          key: idempotency.key,
          correlationId: locals.correlationId,
          // Asked only for a NEW conversation: a replay does not spend the limit.
          admit: async () => {
            const postLimit = await checkSharedRateLimit(
              `commerce:conversations:post:account:${accountId}`,
              {
                maxAttempts: CONVERSATION_POST_RATE_LIMIT_MAX,
                windowMs: CONVERSATION_POST_RATE_LIMIT_WINDOW_SEC * 1000
              }
            );
            return postLimit.allowed
              ? null
              : { retryAfterSec: postLimit.retryAfterSec };
          }
        }
      );
    }
  );

  return respondCreate(result, corsHeaders);
};

function respondList(
  result: ListOutcome | null,
  corsHeaders: Record<string, string>
): Response {
  if (result && result.kind === "feature_disabled") {
    return NEUTRAL_NOT_FOUND(corsHeaders);
  }
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
  return ok(
    { items: result.page.items, nextCursor: result.page.nextCursor },
    {},
    corsHeaders
  );
}

function respondCreate(
  result: CreateOutcome | null,
  corsHeaders: Record<string, string>
): Response {
  if (result && result.kind === "feature_disabled") {
    return NEUTRAL_NOT_FOUND(corsHeaders);
  }
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
      "Invalid conversation.",
      {},
      result.errors,
      corsHeaders
    );
  }
  if (result.kind === "rate_limited") {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many messages. Try again later.",
      {},
      undefined,
      {
        ...corsHeaders,
        "retry-after": String(result.retryAfterSec)
      }
    );
  }
  if (result.kind === "idempotency_conflict") {
    return storefrontIdempotencyConflictResponse(corsHeaders);
  }
  return jsonResponse(
    {
      success: true,
      data: {
        conversation: result.result.conversation,
        message: result.result.message,
        ...(result.replayed ? { replayed: true } : {})
      },
      meta: {}
    },
    { status: 201, headers: corsHeaders }
  );
}

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:account:conversations",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    PREFLIGHT_ALLOWED_HEADERS
  );
