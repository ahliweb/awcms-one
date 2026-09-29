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
import { fail, ok } from "../../../../../../../../modules/_shared/api-response";
import { completePracticeSession } from "../../../../../../../../modules/practice-irm/application/practice-session-directory";
import { requireCustomerSession } from "../../../../../../../../modules/commerce/application/customer-session-auth";
import { practiceIrmPreflightResponse } from "../../../../../../../../modules/practice-irm/application/public-practice-irm-preflight";
import { withPublicPracticeIrmTenant } from "../../../../../../../../modules/practice-irm/application/public-practice-irm-tenant";

/**
 * `POST /api/v1/practice-irm/storefront/account/sessions/{id}/complete`
 * (Issue #270) — `draft -> completed`, the one status transition this table
 * has. Requires `situation`/`intensity` already present
 * (`hasMinimumFieldsToComplete`) — `409 INCOMPLETE_FIELDS` otherwise, never
 * a value judgement about what was written.
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
  | { kind: "not_found" }
  | { kind: "already_completed" }
  | { kind: "incomplete_fields" }
  | { kind: "completed"; session: unknown };

export const POST: APIRoute = async ({ request, params, clientAddress }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `practice_irm:account:sessions:complete:${clientIp}`,
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

  const sessionId = params.id;

  const bodyRead = await readJsonBody(request);
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  if (bodyRead.malformed) {
    return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }
  const body = bodyRead.value;
  if (typeof body !== "object" || body === null) {
    return fail(400, "VALIDATION_ERROR", "Request body must be an object.");
  }
  const productId = (body as Record<string, unknown>).productId;

  const inputMalformed =
    !sessionId ||
    !UUID_PATTERN.test(sessionId) ||
    typeof productId !== "string" ||
    !UUID_PATTERN.test(productId);

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
      if (inputMalformed) return { kind: "validation_error" };

      return completePracticeSession(
        tx,
        tenant.tenantId,
        authOutcome.account.customerId,
        productId as string,
        sessionId as string
      );
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
      "id/productId must be valid uuids.",
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
  if (result.kind === "not_found") {
    return fail(
      404,
      "RESOURCE_NOT_FOUND",
      "Session not found.",
      {},
      undefined,
      corsHeaders
    );
  }
  if (result.kind === "already_completed") {
    return fail(
      409,
      "ALREADY_COMPLETED",
      "This session is already completed.",
      {},
      undefined,
      corsHeaders
    );
  }
  if (result.kind === "incomplete_fields") {
    return fail(
      409,
      "INCOMPLETE_FIELDS",
      "situation and intensity must be filled in before completing a session.",
      {},
      undefined,
      corsHeaders
    );
  }

  return ok(result.session, {}, corsHeaders);
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  practiceIrmPreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "practice_irm:account:sessions:complete",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 }
  );
