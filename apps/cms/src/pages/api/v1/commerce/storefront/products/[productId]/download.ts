import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../../lib/security/env-thresholds";
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { verifyEntitlement } from "../../../../../../../modules/commerce/application/commerce-entitlement-directory";
import { fetchProtectedMediaLinkForProduct } from "../../../../../../../modules/commerce/application/protected-media-directory";
import { requireCustomerSession } from "../../../../../../../modules/commerce/application/customer-session-auth";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";
import {
  fetchNewsMediaObjectById,
  isMediaObjectDownloadable
} from "../../../../../../../modules/media-library/application/media-object-directory";
import { recordMediaDownloadIssuance } from "../../../../../../../modules/media-library/application/media-download-audit";
import { createNewsMediaR2Client } from "../../../../../../../modules/media-library/infrastructure/media-r2-client";
import {
  boundPresignedDownloadTtlSeconds,
  findMissingNewsMediaR2Vars,
  type NewsMediaR2Config,
  resolveNewsMediaR2Config
} from "../../../../../../../modules/media-library/domain/media-r2-config";

/**
 * `GET /api/v1/commerce/storefront/products/{productId}/download` (Issue
 * #268, IRMbyDUS: media-library private object class + presigned GET) — the
 * CUSTOMER-facing half of the issuance flow implementing FR-LIB-002/003/004:
 *
 *   Authentication (customer bearer session, `requireCustomerSession` — the
 *   existing evaluator every other `storefront/account/*` route already
 *   reuses) → Authorization (the blocked-account gate every bearer-secured
 *   storefront route already applies — see below for why this, not the
 *   tenant_user ABAC evaluator, is the reused mechanism here) → Entitlement
 *   Verification (`verifyEntitlement`, `commerce-entitlement-directory.ts`)
 *   → short-lived presigned GET URL.
 *
 * ## Why "Authorization" here is the blocked-account gate, not ABAC
 *
 * `identity-access`'s ABAC/RBAC evaluator (`authorizeInTransaction`) is built
 * entirely around `TenantContext` — a `tenant_user`'s roles/permissions.
 * Storefront customers are a structurally SEPARATE identity (ADR-0016 D1:
 * "keeps a customer OUT of this schema's tenant_user/identity/profile/
 * principal RLS vocabulary entirely"), so there is no tenant_user context to
 * evaluate a policy against — this is not an oversight here, it is the same
 * boundary every OTHER bearer-secured storefront account route in this same
 * feature already accepts (`storefront/account/entitlements/check.ts`,
 * `.../entitlements/index.ts`, both merged with this same entitlement
 * module and calling nothing but `requireCustomerSession` +
 * `account.status === "blocked"`). This route follows that established,
 * already-reviewed precedent rather than inventing a parallel ABAC system
 * for an identity type this codebase does not model that way. The STAFF/
 * tenant-user side of this same issue (`GET /api/v1/media/objects/{id}/
 * download-url`, `media_library`) is where the real ABAC evaluator applies
 * (`media_library.media.download`) — see that route's own header.
 *
 * ## Entitlement Verification
 *
 * `productId` names the product; the media object it gates is resolved
 * SERVER-SIDE from `awcms_commerce_protected_media_links` (`sql/939`) —
 * never accepted as a caller-supplied media object id, which would let an
 * entitled customer for product A request ANY other private object by id.
 * `verifyEntitlement`'s `ownerCustomerId` comes ONLY from the verified
 * bearer session, never from request input (same owner-scoping rule
 * `sql/936`'s header states for the sibling entitlement-check route).
 *
 * Missing entitlement → `403`, with NO `url` field anywhere in the body —
 * never a broken link, never a URL of any kind (Issue #268's own acceptance
 * criteria).
 *
 * ## Audit
 *
 * `media.download` is recorded on EVERY issuance decision that reaches a
 * real, correctly-configured link (`recordMediaDownloadIssuance`) — success
 * AND entitlement-denial alike. A request for a product with NO protected-
 * media link, or whose link points at a misconfigured (non-private/not-
 * downloadable) object, is a plain `404`/`409` with no audit row: there is
 * no real download decision to record, only a configuration gap.
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Outcome =
  | { kind: "unauthenticated" }
  | { kind: "blocked" }
  | { kind: "validation_error" }
  | { kind: "no_protected_content" }
  | { kind: "misconfigured" }
  | { kind: "entitlement_required" }
  | { kind: "provider_error" }
  | { kind: "issue"; mediaObjectId: string; objectKey: string };

export const GET: APIRoute = async ({ request, params, clientAddress }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:storefront:products:download:${clientIp}`,
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 }
  );
  if (!rateLimit.allowed) {
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

  const productId = params.productId;
  const productIdMalformed = !productId || !UUID_PATTERN.test(productId);

  const sql = getDatabaseClient();
  const correlationId = crypto.randomUUID();
  // Read here (env only, no network/credential use) so the tx callback below
  // can hold the 502 refusal until AFTER entitlement is decided — an
  // unauthenticated/non-entitled caller must not learn whether this
  // deployment even has R2 configured, same probing-prevention discipline as
  // the staff-facing sibling route.
  const config: NewsMediaR2Config = resolveNewsMediaR2Config();
  const providerReady =
    config.enabled && findMissingNewsMediaR2Vars().length === 0;

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
      if (productIdMalformed) return { kind: "validation_error" };

      const link = await fetchProtectedMediaLinkForProduct(
        tx,
        tenant.tenantId,
        productId
      );
      if (!link) return { kind: "no_protected_content" };

      const media = await fetchNewsMediaObjectById(
        tx,
        tenant.tenantId,
        link.mediaObjectId
      );

      // Fail-closed: a link pointing at a non-private or non-downloadable
      // object is a deployment misconfiguration (see `protected-media-
      // directory.ts`'s header — the issuance path re-verifies this live,
      // deliberately, rather than trusting the link's write-time state),
      // never silently served either as a public reference or a signed URL.
      if (
        !media ||
        media.visibility !== "private" ||
        !isMediaObjectDownloadable(media.status)
      ) {
        return { kind: "misconfigured" };
      }

      const entitlement = await verifyEntitlement(
        tx,
        tenant.tenantId,
        authOutcome.account.customerId,
        productId
      );

      if (!entitlement) {
        await recordMediaDownloadIssuance(tx, {
          tenantId: tenant.tenantId,
          mediaObjectId: media.id,
          objectKey: media.objectKey,
          outcome: "denied_entitlement_required",
          correlationId
        });
        return { kind: "entitlement_required" };
      }

      if (!providerReady) {
        // Not audited as an "issuance" — nothing was decided about THIS
        // caller's entitlement question; the deployment itself cannot serve
        // any download right now, for anyone.
        return { kind: "provider_error" };
      }

      await recordMediaDownloadIssuance(tx, {
        tenantId: tenant.tenantId,
        mediaObjectId: media.id,
        objectKey: media.objectKey,
        outcome: "issued",
        correlationId
      });

      return {
        kind: "issue",
        mediaObjectId: media.id,
        objectKey: media.objectKey
      };
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
      "productId must be a valid uuid.",
      {},
      undefined,
      corsHeaders
    );
  }
  if (result.kind === "no_protected_content") {
    return fail(
      404,
      "RESOURCE_NOT_FOUND",
      "This product has no protected content to download.",
      {},
      undefined,
      corsHeaders
    );
  }
  if (result.kind === "misconfigured") {
    return fail(
      409,
      "RESOURCE_MISCONFIGURED",
      "This product's protected content is not currently available.",
      {},
      undefined,
      corsHeaders
    );
  }
  if (result.kind === "entitlement_required") {
    // Never a URL of any kind on this path — Issue #268's own acceptance
    // criteria ("if entitlement is missing, return 403 — never a broken
    // link, never a URL of any kind").
    return fail(
      403,
      "ENTITLEMENT_REQUIRED",
      "You do not have an active entitlement for this product.",
      {},
      undefined,
      corsHeaders
    );
  }
  if (result.kind === "provider_error") {
    return fail(
      502,
      "PROVIDER_ERROR",
      "Media storage is not configured for this deployment.",
      {},
      undefined,
      corsHeaders
    );
  }

  // Outside the transaction (ADR-0006) — `presignDownloadUrl` is a pure,
  // local HMAC signature computation, kept out of `withPublicCommerceTenant`'s
  // transaction anyway, same discipline as every other R2 call in this repo.
  const r2Client = createNewsMediaR2Client({
    accountId: config.accountId,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket
  });

  const boundedTtlSeconds = boundPresignedDownloadTtlSeconds(
    config.presignedDownloadTtlSeconds
  );

  const url = r2Client.presignDownloadUrl({
    objectKey: result.objectKey,
    ttlSeconds: boundedTtlSeconds
  });

  const expiresAt = new Date(Date.now() + boundedTtlSeconds * 1000);

  return ok(
    {
      mediaObjectId: result.mediaObjectId,
      url,
      expiresAt: expiresAt.toISOString()
    },
    {},
    corsHeaders
  );
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:storefront:products:download",
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 },
    PREFLIGHT_ALLOWED_HEADERS
  );
