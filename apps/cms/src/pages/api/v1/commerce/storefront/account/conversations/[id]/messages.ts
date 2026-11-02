import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../../../lib/security/env-thresholds";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../../lib/security/request-body-limit";
import {
  fail,
  jsonResponse
} from "../../../../../../../../modules/_shared/api-response";
import { requireCustomerSession } from "../../../../../../../../modules/commerce/application/customer-session-auth";
import { fetchCommerceFeatures } from "../../../../../../../../modules/commerce/application/commerce-feature-gate";
import { validateConversationMessageInput } from "../../../../../../../../modules/commerce/domain/conversation-validation";
import { commerceIdempotentPreflightHeaders } from "../../../../../../../../modules/commerce/domain/commerce-cors";
import {
  postCustomerMessageIdempotent,
  type PostMessageIdempotentOutcome
} from "../../../../../../../../modules/commerce/application/storefront-idempotent-mutations";
import {
  readStorefrontIdempotencyKey,
  storefrontIdempotencyConflictResponse
} from "../../../../../../../../modules/commerce/application/storefront-idempotency-http";
import { commercePreflightResponse } from "../../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../../modules/commerce/application/public-commerce-tenant";

/**
 * `POST /api/v1/commerce/storefront/account/conversations/{id}/messages`
 * (Issue #111) — bearer, per the storefront's own `kirimPesanPercakapan`
 * (`akun-klien.ts`). `409 CONVERSATION_CLOSED` once the thread is closed —
 * a customer never reopens their own thread (only a store reply does).
 * Rate-limited 10/h PER ACCOUNT (`COMMERCE_CONVERSATION_POST_RATE_LIMIT_MAX`),
 * keyed by account id rather than IP — the abuse this limit guards against
 * is one account spamming the store's inbox, not one IP spamming many
 * accounts (the IP-keyed limiter below still applies on top, same as every
 * other route in this file).
 *
 * Takes an OPTIONAL `Idempotency-Key` (Issue #513, unit C): a repeat posts the
 * message twice, so the same key + same conversation + same text replays the
 * original `201` (`data.replayed: true`, no second message, no spent post
 * limit); the same key for another conversation or text is `409
 * IDEMPOTENCY_CONFLICT`.
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

type Outcome =
  | { kind: "unauthenticated" }
  | { kind: "blocked" }
  | { kind: "validation_error"; errors: { field: string; message: string }[] }
  | PostMessageIdempotentOutcome;

export const POST: APIRoute = async ({
  request,
  clientAddress,
  params,
  locals
}) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const ipLimit = await checkSharedRateLimit(
    `commerce:account:conversations:messages:${clientIp}`,
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 }
  );
  if (!ipLimit.allowed) {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many requests. Try again later.",
      {},
      undefined,
      {
        "retry-after": String(ipLimit.retryAfterSec),
        vary: "Origin"
      }
    );
  }

  const idempotency = readStorefrontIdempotencyKey(request);
  if ("response" in idempotency) return idempotency.response;

  const conversationId = params.id;
  const bodyRead = await readJsonBody(request);
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const validation = validateConversationMessageInput(bodyRead.value);

  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant): Promise<Outcome> => {
      const features = await fetchCommerceFeatures(tx, tenant.tenantId);
      if (!features.inbox) return { kind: "not_found" };

      const authOutcome = await requireCustomerSession(
        request,
        tx,
        tenant.tenantId
      );
      if (!authOutcome.ok) return { kind: "unauthenticated" };
      if (authOutcome.account.status === "blocked") return { kind: "blocked" };
      if (!conversationId) return { kind: "not_found" };
      if (!validation.valid) {
        return { kind: "validation_error", errors: validation.errors };
      }

      const accountId = authOutcome.account.id;
      return postCustomerMessageIdempotent(
        tx,
        tenant.tenantId,
        accountId,
        conversationId,
        validation.value.body,
        {
          key: idempotency.key,
          correlationId: locals.correlationId,
          // Asked only for a NEW message: a replay does not spend the limit.
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
      "Invalid message.",
      {},
      result.errors,
      corsHeaders
    );
  }
  if (result.kind === "not_found") {
    return fail(404, "NOT_FOUND", "Not found.", {}, undefined, corsHeaders);
  }
  if (result.kind === "closed") {
    return fail(
      409,
      "CONVERSATION_CLOSED",
      "This conversation has been closed.",
      {},
      undefined,
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
        message: result.message,
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
    "commerce:account:conversations:messages",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    PREFLIGHT_ALLOWED_HEADERS
  );
