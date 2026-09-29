import {
  fail,
  jsonResponse,
  ok
} from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../modules/_shared/idempotency";
import { COMMERCE_PRODUCTS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";
import {
  clearProtectedMediaLinkForProduct,
  setProtectedMediaLinkForProduct
} from "../../../../../../modules/commerce/application/protected-media-directory";
import {
  fetchNewsMediaObjectById,
  isMediaObjectDownloadable
} from "../../../../../../modules/media-library/application/media-object-directory";
import { isMediaObjectId } from "../../../../../../modules/media-library/domain/media-object-id";

/** Managed as part of editing a PRODUCT — gated on `products.update`, same convention as `products/{id}/images` (that route's own header). */
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
  action: "update"
} as const;

type PutPrepared = { idempotencyKey: string; mediaObjectId: string };

/**
 * `PUT /api/v1/commerce/products/{id}/protected-media` (Issue #268, IRMbyDUS)
 * — link (or re-link) a product to the PRIVATE media object its commerce
 * entitlement gates (`sql/939`). Admin/staff surface only; the customer-
 * facing issuance path is `GET /api/v1/commerce/storefront/products/{id}/
 * download`.
 *
 * `mediaObjectId` must resolve, same-tenant, non-deleted, to a
 * `visibility: "private"` object in a downloadable status
 * (`isMediaObjectDownloadable` — `verified`/`attached`). A `"public"` object
 * is refused here: linking one would make FR-LIB-002's "no permanent public
 * URL for protected content" a lie the caller told themselves, since the
 * object already has one.
 */
export const PUT = defineTenantRoute<PutPrepared>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const idempotencyKey = request.headers.get("idempotency-key");

    if (!idempotencyKey) {
      return fail(
        400,
        "IDEMPOTENCY_REQUIRED",
        "Idempotency-Key header is required."
      );
    }

    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const mediaObjectId = (bodyRead.value as { mediaObjectId?: unknown })
      ?.mediaObjectId;

    if (typeof mediaObjectId !== "string" || !isMediaObjectId(mediaObjectId)) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "mediaObjectId is required and must be a uuid."
      );
    }

    return { idempotencyKey, mediaObjectId };
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const productId = params.id;

    if (!productId) {
      return fail(400, "VALIDATION_ERROR", "Product id is required.");
    }

    const requestHash = computeRequestHash({
      productId,
      mediaObjectId: prepared.mediaObjectId,
      action: "protected_media_link_set"
    });

    const existing = await findIdempotencyRecord(
      tx,
      tenantId,
      "commerce_product_protected_media_set",
      prepared.idempotencyKey
    );

    if (existing) {
      if (existing.requestHash !== requestHash) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
      return jsonResponse(existing.responseBody, {
        status: existing.responseStatus
      });
    }

    const media = await fetchNewsMediaObjectById(
      tx,
      tenantId,
      prepared.mediaObjectId
    );

    if (
      !media ||
      media.visibility !== "private" ||
      !isMediaObjectDownloadable(media.status)
    ) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "mediaObjectId must reference an existing, verified, private media object in this tenant."
      );
    }

    const link = await setProtectedMediaLinkForProduct(
      tx,
      tenantId,
      auth.context.tenantUserId,
      productId,
      prepared.mediaObjectId,
      locals.correlationId
    );

    const response = ok(link);
    const body = await response.clone().json();

    await saveIdempotencyRecord(
      tx,
      tenantId,
      "commerce_product_protected_media_set",
      prepared.idempotencyKey,
      requestHash,
      200,
      body
    );

    return response;
  }
});

type DeletePrepared = { idempotencyKey: string };

/** `DELETE /api/v1/commerce/products/{id}/protected-media` — remove the link. Idempotent: removing an already-unlinked product is a no-op success, not an error. */
export const DELETE = defineTenantRoute<DeletePrepared>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const idempotencyKey = request.headers.get("idempotency-key");

    if (!idempotencyKey) {
      return fail(
        400,
        "IDEMPOTENCY_REQUIRED",
        "Idempotency-Key header is required."
      );
    }

    return { idempotencyKey };
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const productId = params.id;

    if (!productId) {
      return fail(400, "VALIDATION_ERROR", "Product id is required.");
    }

    const requestHash = computeRequestHash({
      productId,
      action: "protected_media_link_clear"
    });

    const existing = await findIdempotencyRecord(
      tx,
      tenantId,
      "commerce_product_protected_media_clear",
      prepared.idempotencyKey
    );

    if (existing) {
      if (existing.requestHash !== requestHash) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
      return jsonResponse(existing.responseBody, {
        status: existing.responseStatus
      });
    }

    await clearProtectedMediaLinkForProduct(
      tx,
      tenantId,
      auth.context.tenantUserId,
      productId,
      locals.correlationId
    );

    const response = ok({ productId, unlinked: true });
    const body = await response.clone().json();

    await saveIdempotencyRecord(
      tx,
      tenantId,
      "commerce_product_protected_media_clear",
      prepared.idempotencyKey,
      requestHash,
      200,
      body
    );

    return response;
  }
});
