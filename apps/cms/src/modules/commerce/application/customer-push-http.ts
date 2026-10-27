/**
 * The HTTP behaviour of the customer Web Push routes (Issue #430, ADR-0048
 * sections 4, 5.2, 5.3 and 6), kept out of the route files so each stays a thin
 * Astro adapter and the whole path - tenant, feature gate, bearer, limits,
 * validation, write, response - is testable without Astro.
 *
 * Routes under `/api/v1/commerce/storefront/account/push/`:
 *
 * | Method and path                          | Handler                          |
 * | ---------------------------------------- | -------------------------------- |
 * | `GET    subscriptions`                   | {@link handleCustomerPushState}  |
 * | `POST   subscriptions`                   | {@link handleCustomerPushSubscribe} |
 * | `DELETE subscriptions`                   | {@link handleCustomerPushRevokeAll} |
 * | `DELETE subscriptions/{id}`              | {@link handleCustomerPushRevokeOne} |
 * | `GET    preferences`                     | {@link handleCustomerPushPreferencesGet} |
 * | `PUT    preferences`                     | {@link handleCustomerPushPreferencesPut} |
 *
 * ## Credentials: the bearer, and nothing else (ADR-0048 T1, P1)
 *
 * Every handler authenticates with `requireCustomerSession` ONLY. This file
 * reads no cookie, imports no staff principal resolver and never accepts an
 * admin session, a machine token or a tenant-user id: a staff credential on a
 * customer route is a `401` like any other unknown bearer, and `TS-S1`
 * (`tests/commerce-customer-push-static.test.ts`) fails the build if that ever
 * changes. The principal `(tenant, account, session)` comes from the bearer and
 * the resolved tenant; the body schema is strict and cannot name a principal,
 * an id, a title, a body or a click target (T2, T7).
 *
 * ## One neutral 404 (T18)
 *
 * A feature that is OFF, an unresolvable or refused tenant, and (on the DELETE
 * by id) a device that is absent, someone else's or already revoked all answer
 * the same `404 NOT_FOUND` body. The feature gate runs BEFORE authentication, so
 * an anonymous prober learns nothing from a missing bearer either.
 *
 * ## Headers (T19)
 *
 * Every answer carries `Cache-Control: private, no-store` and `Vary: Origin`,
 * and the CORS grant only for a tenant-resolved origin. No
 * `Access-Control-Allow-Credentials` is ever sent: the bearer is a capability
 * script attaches deliberately, never a cookie, so there is no ambient
 * credential for a third-party page to ride (CSRF is not exposed).
 *
 * ## Rate limits (ADR-0048 6.2)
 *
 * Per IP before any work; per account after authentication. Over the limit: `429
 * RATE_LIMITED` with `Retry-After`. The register body is capped at 8 KiB.
 */
import { getDatabaseClient } from "../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../lib/security/rate-limit";
import { readCappedText } from "../../../lib/security/request-body-limit";
import {
  isCrossOriginRequest,
  parseRequestOrigin
} from "../../../lib/security/request-origin";
import { fail, jsonResponse, ok } from "../../_shared/api-response";
import { validateSubscriptionInput } from "../../push-delivery/domain/subscription-input";
import {
  CUSTOMER_PUSH_BODY_LIMIT_BYTES,
  CUSTOMER_PUSH_RATE_LIMITS,
  parsePreferencesBody,
  parseRegisterBodyShape,
  validateRegisterConsent,
  type FieldError
} from "../domain/customer-push";
import {
  checkCustomerPushEndpoint,
  resolvePushHostPolicy
} from "../domain/customer-push-endpoint";
import { classifyUserAgent } from "../domain/customer-push-user-agent";
import { requireCommerceFeatureForPublicRoute } from "./commerce-feature-gate";
import { auditPreferences } from "./customer-push-audit";
import {
  buildCustomerPushCapability,
  resolvePushAvailability,
  resolveStorefrontOrigin,
  type CustomerPushCapability
} from "./customer-push-capability";
import {
  listOwnCustomerPushDevices,
  registerCustomerPushDevice,
  revokeAllOwnCustomerPushDevices,
  revokeOwnCustomerPushDevice,
  type CustomerPushDeviceView
} from "./customer-push-devices";
import {
  applyPreferenceChanges,
  listCustomerPushPreferences,
  type CustomerPushPreferenceView
} from "./customer-push-preferences";
import type { CustomerAccountRecord } from "./customer-account-store";
import { requireCustomerSession } from "./customer-session-auth";
import { withPublicCommerceTenant } from "./public-commerce-tenant";
import { parsePositiveIntSetting } from "../../../lib/security/env-thresholds";

const NO_STORE = { "cache-control": "private, no-store" } as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `GET` per IP: the commerce storefront default (60 per minute), env-tunable like every sibling route. */
const READ_LIMITS = {
  maxAttempts: parsePositiveIntSetting(
    process.env.COMMERCE_STOREFRONT_RATE_LIMIT_MAX,
    60,
    "COMMERCE_STOREFRONT_RATE_LIMIT_MAX"
  ),
  windowMs:
    parsePositiveIntSetting(
      process.env.COMMERCE_STOREFRONT_RATE_LIMIT_WINDOW_SEC,
      60,
      "COMMERCE_STOREFRONT_RATE_LIMIT_WINDOW_SEC"
    ) * 1000
} as const;

export type CustomerPushRequestContext = {
  request: Request;
  clientAddress: string | undefined;
  correlationId?: string;
};

type RateLimitConfig = { maxAttempts: number; windowMs: number };

async function ipRateLimited(
  ctx: CustomerPushRequestContext,
  scope: string,
  limits: RateLimitConfig
): Promise<Response | null> {
  const clientIp = resolveClientIp(ctx.request, ctx.clientAddress);
  const budget = await checkSharedRateLimit(`${scope}:${clientIp}`, limits);
  return budget.allowed
    ? null
    : rateLimitedResponse(budget.retryAfterSec, { vary: "Origin" });
}

function rateLimitedResponse(
  retryAfterSec: number,
  cors: Record<string, string>
): Response {
  return fail(
    429,
    "RATE_LIMITED",
    "Too many requests. Try again later.",
    {},
    undefined,
    { ...cors, ...NO_STORE, "retry-after": String(retryAfterSec) }
  );
}

// ---------------------------------------------------------------------------
// The shared gate: feature -> bearer -> account state
// ---------------------------------------------------------------------------

type GateFailure =
  | { kind: "not_found" }
  | { kind: "unauthenticated" }
  | { kind: "blocked" }
  | { kind: "not_verified" };

type Authenticated = {
  kind: "ok";
  tenantId: string;
  account: CustomerAccountRecord;
  sessionId: string;
};

async function gate(
  tx: Bun.TransactionSQL,
  tenantId: string,
  request: Request,
  options: { allowBlocked?: boolean; requireVerified?: boolean } = {}
): Promise<Authenticated | GateFailure> {
  // Feature first: OFF is the same neutral 404 as an unresolvable tenant.
  const off = await requireCommerceFeatureForPublicRoute(
    tx,
    tenantId,
    "customerPush",
    () => fail(404, "NOT_FOUND", "Not found.")
  );
  if (off) return { kind: "not_found" };

  const auth = await requireCustomerSession(request, tx, tenantId);
  if (!auth.ok) return { kind: "unauthenticated" };

  if (auth.account.status === "blocked" && !options.allowBlocked) {
    return { kind: "blocked" };
  }
  if (options.requireVerified && auth.account.emailVerifiedAt === null) {
    return { kind: "not_verified" };
  }

  return {
    kind: "ok",
    tenantId,
    account: auth.account,
    sessionId: auth.sessionId
  };
}

function gateFailureResponse(
  failure: GateFailure,
  headers: Record<string, string>
): Response {
  switch (failure.kind) {
    case "not_found":
      return fail(404, "NOT_FOUND", "Not found.", {}, undefined, headers);
    case "unauthenticated":
      return fail(
        401,
        "UNAUTHENTICATED",
        "Missing, invalid, or expired session.",
        {},
        undefined,
        headers
      );
    case "blocked":
      return fail(
        403,
        "ACCOUNT_BLOCKED",
        "This account has been blocked.",
        {},
        undefined,
        headers
      );
    case "not_verified":
      return fail(
        403,
        "ACCOUNT_NOT_VERIFIED",
        "Verify your e-mail address before turning notifications on.",
        {},
        undefined,
        headers
      );
  }
}

/** Whether the request is a cross-origin browser request (the shared classifier already refused unknown origins). */
function isCrossOrigin(request: Request): boolean {
  const parsed = parseRequestOrigin(request.headers.get("origin"));
  return parsed !== null && isCrossOriginRequest(parsed, request.url);
}

function storefrontOriginOf(request: Request) {
  return resolveStorefrontOrigin(
    request.headers.get("origin"),
    isCrossOrigin(request)
  );
}

function validationFailure(
  status: 400 | 422,
  errors: FieldError[],
  headers: Record<string, string>
): Response {
  return fail(
    status,
    "VALIDATION_ERROR",
    "Invalid request.",
    {},
    errors,
    headers
  );
}

// ---------------------------------------------------------------------------
// Body reading (capped, JSON only)
// ---------------------------------------------------------------------------

type BodyRead =
  | { kind: "ok"; value: unknown }
  | { kind: "too_large" }
  | { kind: "bad_content_type" }
  | { kind: "malformed" };

async function readPushBody(request: Request): Promise<BodyRead> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return { kind: "bad_content_type" };
  }

  const text = await readCappedText(request, CUSTOMER_PUSH_BODY_LIMIT_BYTES);
  if (text.tooLarge) return { kind: "too_large" };

  try {
    return { kind: "ok", value: JSON.parse(text.text) as unknown };
  } catch {
    return { kind: "malformed" };
  }
}

function bodyFailureResponse(
  body: Exclude<BodyRead, { kind: "ok" }>,
  headers: Record<string, string>
): Response {
  if (body.kind === "too_large") {
    return fail(
      413,
      "PAYLOAD_TOO_LARGE",
      `Request body exceeds the maximum allowed size of ${CUSTOMER_PUSH_BODY_LIMIT_BYTES} bytes.`,
      {},
      undefined,
      headers
    );
  }
  if (body.kind === "bad_content_type") {
    return fail(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json.",
      {},
      undefined,
      headers
    );
  }
  return validationFailure(
    400,
    [{ field: "body", message: "Body must be valid JSON." }],
    headers
  );
}

// ---------------------------------------------------------------------------
// GET subscriptions - capability, preferences, this account's devices
// ---------------------------------------------------------------------------

type StateOutcome =
  | GateFailure
  | {
      kind: "state";
      capability: CustomerPushCapability;
      preferences: CustomerPushPreferenceView[];
      devices: CustomerPushDeviceView[];
    };

export async function handleCustomerPushState(
  ctx: CustomerPushRequestContext
): Promise<Response> {
  const limited = await ipRateLimited(
    ctx,
    "commerce:push:state:ip",
    READ_LIMITS
  );
  if (limited) return limited;

  const { result, corsHeaders } = await withPublicCommerceTenant(
    getDatabaseClient(),
    ctx.request,
    async (tx, tenant): Promise<StateOutcome> => {
      const auth = await gate(tx, tenant.tenantId, ctx.request);
      if (auth.kind !== "ok") return auth;

      return {
        kind: "state",
        capability: buildCustomerPushCapability(
          resolvePushAvailability(),
          storefrontOriginOf(ctx.request)
        ),
        preferences: await listCustomerPushPreferences(
          tx,
          auth.tenantId,
          auth.account.id
        ),
        devices: await listOwnCustomerPushDevices(
          tx,
          auth.tenantId,
          auth.account.id,
          auth.sessionId
        )
      };
    }
  );

  const headers = { ...corsHeaders, ...NO_STORE };
  if (!result) return gateFailureResponse({ kind: "not_found" }, headers);
  if (result.kind !== "state") return gateFailureResponse(result, headers);

  return ok(
    {
      capability: result.capability,
      preferences: result.preferences,
      devices: result.devices
    },
    {},
    headers
  );
}

// ---------------------------------------------------------------------------
// POST subscriptions - register or re-register this browser
// ---------------------------------------------------------------------------

type SubscribeOutcome =
  | GateFailure
  | { kind: "rate_limited"; retryAfterSec: number }
  | { kind: "body"; failure: Exclude<BodyRead, { kind: "ok" }> }
  | { kind: "push_unavailable" }
  | { kind: "origin_not_allowed" }
  | { kind: "invalid"; status: 400 | 422; errors: FieldError[] }
  | { kind: "endpoint_not_allowed" }
  | { kind: "device_limit" }
  | {
      kind: "done";
      status: 200 | 201;
      device: CustomerPushDeviceView;
      preferences: CustomerPushPreferenceView[];
    };

export async function handleCustomerPushSubscribe(
  ctx: CustomerPushRequestContext
): Promise<Response> {
  const limited = await ipRateLimited(
    ctx,
    "commerce:push:subscribe:ip",
    CUSTOMER_PUSH_RATE_LIMITS.subscribeIp
  );
  if (limited) return limited;

  const body = await readPushBody(ctx.request);

  const { result, corsHeaders } = await withPublicCommerceTenant(
    getDatabaseClient(),
    ctx.request,
    async (tx, tenant): Promise<SubscribeOutcome> => {
      const auth = await gate(tx, tenant.tenantId, ctx.request, {
        requireVerified: true
      });
      if (auth.kind !== "ok") return auth;

      const budget = await checkSharedRateLimit(
        `commerce:push:subscribe:account:${auth.account.id}`,
        CUSTOMER_PUSH_RATE_LIMITS.subscribeAccount
      );
      if (!budget.allowed) {
        return { kind: "rate_limited", retryAfterSec: budget.retryAfterSec };
      }

      if (body.kind !== "ok") return { kind: "body", failure: body };

      const availability = resolvePushAvailability();
      if (!availability.ok) return { kind: "push_unavailable" };

      const origin = storefrontOriginOf(ctx.request);
      if (!origin.ok) return { kind: "origin_not_allowed" };

      // Structure: a client-chosen principal or content key is a 400 (T2).
      const shape = parseRegisterBodyShape(body.value);
      if (!shape.ok) {
        return { kind: "invalid", status: 400, errors: shape.errors };
      }

      // Semantics: upstream's validator (https, no literal private address, key
      // sizes) with the transport fixed SERVER-side, then the consent.
      const subscription = validateSubscriptionInput({
        transport: "web_push",
        endpoint: shape.value.endpoint,
        keys: shape.value.keys
      });
      if (!subscription.valid) {
        return { kind: "invalid", status: 422, errors: subscription.errors };
      }
      const consent = validateRegisterConsent(shape.value.consent);
      if (!consent.ok) {
        return { kind: "invalid", status: 422, errors: consent.errors };
      }

      // The push-service host allowlist (T9): refused BEFORE any write.
      if (
        !checkCustomerPushEndpoint(
          subscription.value.endpoint,
          resolvePushHostPolicy()
        ).ok
      ) {
        return { kind: "endpoint_not_allowed" };
      }

      const registered = await registerCustomerPushDevice(tx, {
        tenantId: auth.tenantId,
        accountId: auth.account.id,
        sessionId: auth.sessionId,
        storefrontOrigin: origin.origin,
        endpoint: subscription.value.endpoint,
        p256dhKey: subscription.value.p256dhKey ?? "",
        authSecret: subscription.value.authSecret ?? "",
        userAgentSummary: classifyUserAgent(
          ctx.request.headers.get("user-agent")
        ),
        consent: consent.value,
        ring: availability.ring,
        correlationId: ctx.correlationId
      });

      if (registered.kind === "device_limit") return { kind: "device_limit" };

      return {
        kind: "done",
        // 201 when the caller newly owns an active device (new, transferred or
        // revived); 200 for a no-op re-registration. The two are identical to
        // the caller for a transfer, so the answer never reveals that the
        // endpoint was known.
        status: registered.kind === "registered" ? 201 : 200,
        device: registered.device,
        preferences: await listCustomerPushPreferences(
          tx,
          auth.tenantId,
          auth.account.id
        )
      };
    }
  );

  const headers = { ...corsHeaders, ...NO_STORE };
  if (!result) return gateFailureResponse({ kind: "not_found" }, headers);

  switch (result.kind) {
    case "not_found":
    case "unauthenticated":
    case "blocked":
    case "not_verified":
      return gateFailureResponse(result, headers);
    case "rate_limited":
      return rateLimitedResponse(result.retryAfterSec, corsHeaders);
    case "body":
      return bodyFailureResponse(result.failure, headers);
    case "push_unavailable":
      return fail(
        409,
        "PUSH_UNAVAILABLE",
        "Push notifications are not available on this deployment.",
        {},
        undefined,
        headers
      );
    case "origin_not_allowed":
      return fail(
        422,
        "ORIGIN_NOT_ALLOWED",
        "Notifications can only be turned on from the store's own site.",
        {},
        undefined,
        headers
      );
    case "invalid":
      return validationFailure(result.status, result.errors, headers);
    case "endpoint_not_allowed":
      return fail(
        422,
        "ENDPOINT_NOT_ALLOWED",
        "This push service is not supported. Use a current browser (Chrome, Edge, Firefox or Safari).",
        {},
        undefined,
        headers
      );
    case "device_limit":
      return fail(
        409,
        "DEVICE_LIMIT",
        "Maximum number of devices reached. Remove one to add another.",
        {},
        undefined,
        headers
      );
    case "done":
      return jsonResponse(
        {
          success: true,
          data: { device: result.device, preferences: result.preferences },
          meta: {}
        },
        { status: result.status, headers }
      );
  }
}

// ---------------------------------------------------------------------------
// DELETE subscriptions/{id} and DELETE subscriptions
// ---------------------------------------------------------------------------

type RevokeOutcome =
  | GateFailure
  | { kind: "rate_limited"; retryAfterSec: number }
  | { kind: "revoked" };

function revokeResponse(
  result: RevokeOutcome | null,
  corsHeaders: Record<string, string>
): Response {
  const headers = { ...corsHeaders, ...NO_STORE };
  if (!result) return gateFailureResponse({ kind: "not_found" }, headers);
  if (result.kind === "rate_limited") {
    return rateLimitedResponse(result.retryAfterSec, corsHeaders);
  }
  if (result.kind === "revoked") {
    return new Response(null, { status: 204, headers });
  }
  return gateFailureResponse(result, headers);
}

export async function handleCustomerPushRevokeOne(
  ctx: CustomerPushRequestContext,
  deviceId: string | undefined
): Promise<Response> {
  const limited = await ipRateLimited(
    ctx,
    "commerce:push:revoke:ip",
    CUSTOMER_PUSH_RATE_LIMITS.mutateIp
  );
  if (limited) return limited;

  const { result, corsHeaders } = await withPublicCommerceTenant(
    getDatabaseClient(),
    ctx.request,
    async (tx, tenant): Promise<RevokeOutcome | { kind: "absent" }> => {
      // A blocked account may still revoke its own devices.
      const auth = await gate(tx, tenant.tenantId, ctx.request, {
        allowBlocked: true
      });
      if (auth.kind !== "ok") return auth;

      const budget = await checkSharedRateLimit(
        `commerce:push:revoke:account:${auth.account.id}`,
        CUSTOMER_PUSH_RATE_LIMITS.mutateAccount
      );
      if (!budget.allowed) {
        return { kind: "rate_limited", retryAfterSec: budget.retryAfterSec };
      }

      // A malformed id, an absent device, someone else's and an already
      // revoked one are the same answer.
      if (!deviceId || !UUID_PATTERN.test(deviceId)) return { kind: "absent" };

      const revoked = await revokeOwnCustomerPushDevice(
        tx,
        auth.tenantId,
        auth.account.id,
        deviceId,
        ctx.correlationId
      );
      return revoked ? { kind: "revoked" } : { kind: "absent" };
    }
  );

  if (result && result.kind === "absent") {
    return gateFailureResponse(
      { kind: "not_found" },
      { ...corsHeaders, ...NO_STORE }
    );
  }
  return revokeResponse(result, corsHeaders);
}

export async function handleCustomerPushRevokeAll(
  ctx: CustomerPushRequestContext
): Promise<Response> {
  const limited = await ipRateLimited(
    ctx,
    "commerce:push:revoke:ip",
    CUSTOMER_PUSH_RATE_LIMITS.mutateIp
  );
  if (limited) return limited;

  const { result, corsHeaders } = await withPublicCommerceTenant(
    getDatabaseClient(),
    ctx.request,
    async (tx, tenant): Promise<RevokeOutcome> => {
      const auth = await gate(tx, tenant.tenantId, ctx.request, {
        allowBlocked: true
      });
      if (auth.kind !== "ok") return auth;

      const budget = await checkSharedRateLimit(
        `commerce:push:revoke:account:${auth.account.id}`,
        CUSTOMER_PUSH_RATE_LIMITS.mutateAccount
      );
      if (!budget.allowed) {
        return { kind: "rate_limited", retryAfterSec: budget.retryAfterSec };
      }

      await revokeAllOwnCustomerPushDevices(
        tx,
        auth.tenantId,
        auth.account.id,
        ctx.correlationId
      );
      // "All of my devices" is idempotent: nothing to revoke is still a 204.
      return { kind: "revoked" };
    }
  );

  return revokeResponse(result, corsHeaders);
}

// ---------------------------------------------------------------------------
// GET / PUT preferences
// ---------------------------------------------------------------------------

type PreferencesOutcome =
  | GateFailure
  | { kind: "rate_limited"; retryAfterSec: number }
  | { kind: "body"; failure: Exclude<BodyRead, { kind: "ok" }> }
  | { kind: "invalid"; errors: FieldError[] }
  | { kind: "preferences"; preferences: CustomerPushPreferenceView[] };

function preferencesResponse(
  result: PreferencesOutcome | null,
  corsHeaders: Record<string, string>
): Response {
  const headers = { ...corsHeaders, ...NO_STORE };
  if (!result) return gateFailureResponse({ kind: "not_found" }, headers);

  switch (result.kind) {
    case "not_found":
    case "unauthenticated":
    case "blocked":
    case "not_verified":
      return gateFailureResponse(result, headers);
    case "rate_limited":
      return rateLimitedResponse(result.retryAfterSec, corsHeaders);
    case "body":
      return bodyFailureResponse(result.failure, headers);
    case "invalid":
      return validationFailure(422, result.errors, headers);
    case "preferences":
      return ok({ preferences: result.preferences }, {}, headers);
  }
}

export async function handleCustomerPushPreferencesGet(
  ctx: CustomerPushRequestContext
): Promise<Response> {
  const limited = await ipRateLimited(
    ctx,
    "commerce:push:preferences:read:ip",
    READ_LIMITS
  );
  if (limited) return limited;

  const { result, corsHeaders } = await withPublicCommerceTenant(
    getDatabaseClient(),
    ctx.request,
    async (tx, tenant): Promise<PreferencesOutcome> => {
      const auth = await gate(tx, tenant.tenantId, ctx.request);
      if (auth.kind !== "ok") return auth;

      return {
        kind: "preferences",
        preferences: await listCustomerPushPreferences(
          tx,
          auth.tenantId,
          auth.account.id
        )
      };
    }
  );

  return preferencesResponse(result, corsHeaders);
}

export async function handleCustomerPushPreferencesPut(
  ctx: CustomerPushRequestContext
): Promise<Response> {
  const limited = await ipRateLimited(
    ctx,
    "commerce:push:preferences:ip",
    CUSTOMER_PUSH_RATE_LIMITS.mutateIp
  );
  if (limited) return limited;

  const body = await readPushBody(ctx.request);

  const { result, corsHeaders } = await withPublicCommerceTenant(
    getDatabaseClient(),
    ctx.request,
    async (tx, tenant): Promise<PreferencesOutcome> => {
      // Withdrawal must always be possible (ADR-0048): a body whose every
      // change is `enabled: false` is gated like the DELETE routes (blocked
      // and unverified accounts allowed); enabling anything, or a body that
      // does not parse, keeps the strict gate. Validation is unchanged: the
      // same parser runs below and reports its errors after the gate.
      const early =
        body.kind === "ok" ? parsePreferencesBody(body.value) : null;
      const pureWithdrawal =
        early !== null &&
        early.ok &&
        early.value.changes.length > 0 &&
        early.value.changes.every((change) => change.enabled === false);
      const auth = await gate(
        tx,
        tenant.tenantId,
        ctx.request,
        pureWithdrawal ? { allowBlocked: true } : { requireVerified: true }
      );
      if (auth.kind !== "ok") return auth;

      const budget = await checkSharedRateLimit(
        `commerce:push:preferences:account:${auth.account.id}`,
        CUSTOMER_PUSH_RATE_LIMITS.mutateAccount
      );
      if (!budget.allowed) {
        return { kind: "rate_limited", retryAfterSec: budget.retryAfterSec };
      }

      if (body.kind !== "ok") return { kind: "body", failure: body };

      const parsed = early ?? parsePreferencesBody(body.value);
      if (!parsed.ok) return { kind: "invalid", errors: parsed.errors };

      const applied = await applyPreferenceChanges(
        tx,
        auth.tenantId,
        auth.account.id,
        parsed.value.changes,
        parsed.value.textVersion
      );
      if (applied.changed.length > 0) {
        await auditPreferences(
          tx,
          auth.tenantId,
          auth.account.id,
          applied,
          ctx.correlationId
        );
      }

      return {
        kind: "preferences",
        preferences: await listCustomerPushPreferences(
          tx,
          auth.tenantId,
          auth.account.id
        )
      };
    }
  );

  return preferencesResponse(result, corsHeaders);
}
