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
  getPracticeSessionForCustomer,
  updatePracticeSession,
  type UpdatePracticeSessionInput
} from "../../../../../../../modules/practice-irm/application/practice-session-directory";
import {
  isValidIntensityValue,
  type PracticeSession
} from "../../../../../../../modules/practice-irm/domain/practice-session";
import { requireCustomerSession } from "../../../../../../../modules/commerce/application/customer-session-auth";
import { practiceIrmPreflightResponse } from "../../../../../../../modules/practice-irm/application/public-practice-irm-preflight";
import { withPublicPracticeIrmTenant } from "../../../../../../../modules/practice-irm/application/public-practice-irm-tenant";

/**
 * `GET/PATCH /api/v1/practice-irm/storefront/account/sessions/{id}` (Issue
 * #270) — read one session ("save-draft" reads use this too) and save its
 * content fields. Both require `productId` and re-verify entitlement every
 * call. `PATCH` on a `completed` session answers `409 IMMUTABLE` — see
 * `updatePracticeSession`'s own header.
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

const TEXT_FIELDS = [
  "situation",
  "emotion",
  "body",
  "automaticThought",
  "meaning",
  "neutralize",
  "navigate",
  "embed",
  "reinforce",
  "reflection"
] as const;

function parseContentInput(
  input: Record<string, unknown>
): UpdatePracticeSessionInput | null {
  const parsed: UpdatePracticeSessionInput = {};

  for (const field of TEXT_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return null;
    parsed[field] = value;
  }

  if (input.intensity !== undefined) {
    if (input.intensity !== null && !isValidIntensityValue(input.intensity)) {
      return null;
    }
    parsed.intensity = input.intensity as number | null;
  }
  if (input.postIntensity !== undefined) {
    if (
      input.postIntensity !== null &&
      !isValidIntensityValue(input.postIntensity)
    ) {
      return null;
    }
    parsed.postIntensity = input.postIntensity as number | null;
  }

  return parsed;
}

type GetOutcome =
  | { kind: "unauthenticated" }
  | { kind: "blocked" }
  | { kind: "validation_error" }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "found"; session: PracticeSession };

export const GET: APIRoute = async ({
  request,
  url,
  params,
  clientAddress
}) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `practice_irm:account:sessions:get:${clientIp}`,
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
  const productId = url.searchParams.get("productId");
  const inputMalformed =
    !sessionId ||
    !UUID_PATTERN.test(sessionId) ||
    !productId ||
    !UUID_PATTERN.test(productId);

  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicPracticeIrmTenant(
    sql,
    request,
    async (tx, tenant): Promise<GetOutcome> => {
      const authOutcome = await requireCustomerSession(
        request,
        tx,
        tenant.tenantId
      );
      if (!authOutcome.ok) return { kind: "unauthenticated" };
      if (authOutcome.account.status === "blocked") return { kind: "blocked" };
      if (inputMalformed) return { kind: "validation_error" };

      const getResult = await getPracticeSessionForCustomer(
        tx,
        tenant.tenantId,
        authOutcome.account.customerId,
        productId,
        sessionId
      );
      return getResult;
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

  return ok(result.session, {}, corsHeaders);
};

type PatchOutcome =
  | { kind: "unauthenticated" }
  | { kind: "blocked" }
  | { kind: "validation_error" }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "immutable" }
  | { kind: "updated"; session: PracticeSession };

export const PATCH: APIRoute = async ({ request, params, clientAddress }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `practice_irm:account:sessions:update:${clientIp}`,
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
  const input = body as Record<string, unknown>;

  const productId = input.productId;
  const idMalformed = !sessionId || !UUID_PATTERN.test(sessionId);
  const productIdMalformed =
    typeof productId !== "string" || !UUID_PATTERN.test(productId);

  const contentInput =
    idMalformed || productIdMalformed ? null : parseContentInput(input);
  const contentMalformed =
    !idMalformed && !productIdMalformed && contentInput === null;

  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicPracticeIrmTenant(
    sql,
    request,
    async (tx, tenant): Promise<PatchOutcome> => {
      const authOutcome = await requireCustomerSession(
        request,
        tx,
        tenant.tenantId
      );
      if (!authOutcome.ok) return { kind: "unauthenticated" };
      if (authOutcome.account.status === "blocked") return { kind: "blocked" };
      if (idMalformed || productIdMalformed || contentMalformed) {
        return { kind: "validation_error" };
      }

      return updatePracticeSession(
        tx,
        tenant.tenantId,
        authOutcome.account.customerId,
        productId as string,
        sessionId as string,
        contentInput ?? {}
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
      "id/productId must be valid uuids, and intensity/postIntensity (if present) must be integers 0-10.",
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
  if (result.kind === "immutable") {
    return fail(
      409,
      "SESSION_COMPLETED",
      "This session is completed and can no longer be edited.",
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
    "practice_irm:account:sessions:item",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 }
  );
