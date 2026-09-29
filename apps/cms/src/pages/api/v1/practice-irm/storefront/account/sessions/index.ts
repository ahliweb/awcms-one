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
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../../../modules/_shared/keyset-pagination";
import {
  createPracticeSession,
  listPracticeSessionsForCustomer,
  PRACTICE_SESSION_LIST_DEFAULT_LIMIT,
  PRACTICE_SESSION_LIST_MAX_LIMIT,
  type CreatePracticeSessionInput,
  type PracticeSessionListPage
} from "../../../../../../../modules/practice-irm/application/practice-session-directory";
import { isValidIntensityValue } from "../../../../../../../modules/practice-irm/domain/practice-session";
import { requireCustomerSession } from "../../../../../../../modules/commerce/application/customer-session-auth";
import { practiceIrmPreflightResponse } from "../../../../../../../modules/practice-irm/application/public-practice-irm-preflight";
import { withPublicPracticeIrmTenant } from "../../../../../../../modules/practice-irm/application/public-practice-irm-tenant";

/**
 * `GET/POST /api/v1/practice-irm/storefront/account/sessions` (Issue #270)
 * — "my sessions" history (keyset-paginated) and create a new draft
 * session. Both require `productId` and re-verify the entitlement on every
 * call (see `practice-session-directory.ts`'s header) — mirrors
 * `commerce/storefront/account/entitlements/index.ts` exactly for the
 * bearer-session/owner-scoping shape.
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
): CreatePracticeSessionInput | null {
  const parsed: CreatePracticeSessionInput = {};

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

type ListOutcome =
  | { kind: "unauthenticated" }
  | { kind: "blocked" }
  | { kind: "validation_error" }
  | { kind: "forbidden" }
  | { kind: "page"; page: PracticeSessionListPage };

export const GET: APIRoute = async ({ request, url, clientAddress }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `practice_irm:account:sessions:list:${clientIp}`,
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

  const cursorParam = url.searchParams.get("cursor");
  const decodedCursor: KeysetCursor | null = cursorParam
    ? decodeKeysetCursor(cursorParam)
    : null;
  const cursorMalformed = cursorParam !== null && decodedCursor === null;

  const limitParam = url.searchParams.get("limit");
  const limit = limitParam
    ? Math.min(
        Math.max(
          1,
          Number.parseInt(limitParam, 10) || PRACTICE_SESSION_LIST_DEFAULT_LIMIT
        ),
        PRACTICE_SESSION_LIST_MAX_LIMIT
      )
    : PRACTICE_SESSION_LIST_DEFAULT_LIMIT;

  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicPracticeIrmTenant(
    sql,
    request,
    async (tx, tenant): Promise<ListOutcome> => {
      const authOutcome = await requireCustomerSession(
        request,
        tx,
        tenant.tenantId
      );
      if (!authOutcome.ok) return { kind: "unauthenticated" };
      if (authOutcome.account.status === "blocked") return { kind: "blocked" };
      if (productIdMalformed || cursorMalformed) {
        return { kind: "validation_error" };
      }

      const listResult = await listPracticeSessionsForCustomer(
        tx,
        tenant.tenantId,
        authOutcome.account.customerId,
        productId,
        decodedCursor,
        limit
      );
      if (listResult.kind === "forbidden") return { kind: "forbidden" };

      return { kind: "page", page: listResult.page };
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
      "productId/cursor is malformed.",
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

  return ok(
    { items: result.page.items, nextCursor: result.page.nextCursor },
    {},
    corsHeaders
  );
};

type CreateOutcome =
  | { kind: "unauthenticated" }
  | { kind: "blocked" }
  | { kind: "validation_error" }
  | { kind: "forbidden" }
  | { kind: "created"; session: unknown };

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `practice_irm:account:sessions:create:${clientIp}`,
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
  const productIdMalformed =
    typeof productId !== "string" || !UUID_PATTERN.test(productId);

  const contentInput = productIdMalformed ? null : parseContentInput(input);
  const contentMalformed = !productIdMalformed && contentInput === null;

  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicPracticeIrmTenant(
    sql,
    request,
    async (tx, tenant): Promise<CreateOutcome> => {
      const authOutcome = await requireCustomerSession(
        request,
        tx,
        tenant.tenantId
      );
      if (!authOutcome.ok) return { kind: "unauthenticated" };
      if (authOutcome.account.status === "blocked") return { kind: "blocked" };
      if (productIdMalformed || contentMalformed) {
        return { kind: "validation_error" };
      }

      const createResult = await createPracticeSession(
        tx,
        tenant.tenantId,
        authOutcome.account.customerId,
        productId as string,
        contentInput ?? {}
      );
      if (createResult.kind === "forbidden") return { kind: "forbidden" };

      return { kind: "created", session: createResult.session };
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
      "productId must be a valid uuid, and intensity/postIntensity (if present) must be integers 0-10.",
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

  return ok(result.session, {}, corsHeaders);
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  practiceIrmPreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "practice_irm:account:sessions",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 }
  );
