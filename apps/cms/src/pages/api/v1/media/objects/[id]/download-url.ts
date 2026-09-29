import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  boundPresignedDownloadTtlSeconds,
  findMissingNewsMediaR2Vars,
  resolveNewsMediaR2Config
} from "../../../../../../modules/media-library/domain/media-r2-config";
import { MEDIA_PERMISSION_ACTIVITY_CODE } from "../../../../../../modules/media-library/domain/media-permissions";
import {
  fetchNewsMediaObjectById,
  isMediaObjectDownloadable
} from "../../../../../../modules/media-library/application/media-object-directory";
import { isMediaObjectId } from "../../../../../../modules/media-library/domain/media-object-id";
import { recordMediaDownloadIssuance } from "../../../../../../modules/media-library/application/media-download-audit";
import { createNewsMediaR2Client } from "../../../../../../modules/media-library/infrastructure/media-r2-client";

/**
 * `GET /api/v1/media/objects/{id}/download-url` (Issue #268, IRMbyDUS) — the
 * STAFF/tenant half of the private-object issuance flow: Authentication
 * (tenant user session, `defineTenantRoute`'s own gate) → Authorization
 * (ABAC/RBAC, `media_library.media.download` — the existing
 * `authorizeInTransaction` evaluator, no new mechanism) → short-lived
 * presigned GET URL.
 *
 * Deliberately NOT entitlement-gated: a tenant user holding `media.download`
 * administers the tenant's own media (any object, public or private, they
 * can already `media.read`), never purchases it. The CUSTOMER-facing,
 * entitlement-gated sibling is `GET /api/v1/commerce/storefront/products/
 * {id}/download` (`commerce` module) — see that route's own header for why
 * customers go through `verifyEntitlement` instead of ABAC (ADR-0016 D1:
 * storefront customers sit outside the tenant_user RBAC/ABAC vocabulary
 * entirely, so that route cannot use `defineTenantRoute` at all).
 *
 * Works for EITHER visibility class: a `"public"` object may also be issued
 * a signed URL this way (it simply has no need to, since `publicUrl` already
 * resolves permanently) — `isMediaObjectDownloadable` gates on `status`
 * only, deliberately not on `visibility` (see that function's own doc
 * comment).
 *
 * `media.download` is audited on EVERY issuance decision that reaches a real
 * object (`recordMediaDownloadIssuance`) — an unknown/soft-deleted/not-yet-
 * verified id is a plain 404 with no audit row: nothing was "issued or
 * denied" because there is no real object behind the id to issue anything
 * for.
 *
 * `presignDownloadUrl` is a pure, local HMAC signature computation (no
 * network round trip) — unlike `POST /api/v1/media/news-images/upload-
 * sessions` (a route predating `defineTenantRoute`, `api:tenant-route:check`
 * refuses new files that hand-roll their own `withTenant`), this route MUST
 * use the factory, which offers no "after commit" hook. Calling the presign
 * inside the transaction is safe here specifically because it never touches
 * the network (ADR-0006 is about real R2 calls, not this).
 */
const DOWNLOAD_GUARD = {
  moduleKey: "media_library",
  activityCode: MEDIA_PERMISSION_ACTIVITY_CODE,
  action: "download"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  prepare: () => {
    const config = resolveNewsMediaR2Config();
    return { config };
  },
  authorize: DOWNLOAD_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const objectId = params.id;

    if (!isMediaObjectId(objectId)) {
      return fail(400, "VALIDATION_ERROR", "Media object id must be a uuid.");
    }

    const { config } = prepared;

    if (!config.enabled || findMissingNewsMediaR2Vars().length > 0) {
      return fail(
        502,
        "PROVIDER_ERROR",
        "News media R2 storage is not configured for this deployment."
      );
    }

    const media = await fetchNewsMediaObjectById(tx, tenantId, objectId);

    if (!media || !isMediaObjectDownloadable(media.status)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Media object not found.");
    }

    await recordMediaDownloadIssuance(tx, {
      tenantId,
      mediaObjectId: media.id,
      objectKey: media.objectKey,
      outcome: "issued",
      actorTenantUserId: auth.context.tenantUserId,
      correlationId: locals.correlationId
    });

    // Local/pure — no network call, so doing this inside the transaction
    // does not violate ADR-0006 (see this route's own header).
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
      objectKey: media.objectKey,
      ttlSeconds: boundedTtlSeconds
    });

    const expiresAt = new Date(Date.now() + boundedTtlSeconds * 1000);

    // Never include raw R2 credentials — only the already-signed URL.
    return ok({
      mediaObjectId: media.id,
      url,
      expiresAt: expiresAt.toISOString()
    });
  }
});
