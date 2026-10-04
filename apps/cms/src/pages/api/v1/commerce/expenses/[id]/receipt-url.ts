/**
 * `GET /api/v1/commerce/expenses/{id}/receipt-url` — a short-lived presigned GET
 * URL for an expense's PRIVATE receipt (Issue #294, ADR-0031; the same issuance
 * mechanism as `GET /api/v1/media/objects/{id}/download-url`, #268).
 *
 * Gated on `commerce.expense_receipts.read` - deliberately NOT implied by
 * `commerce.expenses.read` (a receipt can show a person's name or an account
 * number) and NOT satisfied by `media_library.media.download` (that key is for
 * administering the media library; this route reaches only the object attached
 * to THIS expense, resolved server-side - never a caller-supplied media id, which
 * would turn the route into a read of any private object).
 *
 * Fails closed: the object is re-verified on EVERY issuance (it must still be a
 * verified `private` object); a missing receipt, a soft-deleted or
 * public-by-mistake object, and an expense of another tenant are all
 * non-issuing answers. Every issuance decision that reaches a real object is
 * audited (`media.download`, `recordMediaDownloadIssuance`), granted or refused.
 * `presignDownloadUrl` is a pure local HMAC computation (no network round trip),
 * so signing inside the transaction does not breach ADR-0006 - the same
 * reasoning as the media route. The URL is returned with `Cache-Control:
 * no-store` and is never logged.
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { fetchExpenseReceiptObjectId } from "../../../../../../modules/commerce/application/expense-directory";
import { requireExpenseFeature } from "../../../../../../modules/commerce/application/expense-http";
import { isUuid } from "../../../../../../modules/commerce/domain/register";
import { COMMERCE_EXPENSE_RECEIPTS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";
import { recordMediaDownloadIssuance } from "../../../../../../modules/media-library/application/media-download-audit";
import {
  fetchNewsMediaObjectById,
  isMediaObjectDownloadable
} from "../../../../../../modules/media-library/application/media-object-directory";
import {
  boundPresignedDownloadTtlSeconds,
  findMissingNewsMediaR2Vars,
  resolveNewsMediaR2Config
} from "../../../../../../modules/media-library/domain/media-r2-config";
import { createNewsMediaR2Client } from "../../../../../../modules/media-library/infrastructure/media-r2-client";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_EXPENSE_RECEIPTS_ACTIVITY_CODE,
  action: "read"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  prepare: () => ({ config: resolveNewsMediaR2Config() }),
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const gate = await requireExpenseFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Expense not found.");
    }

    const receipt = await fetchExpenseReceiptObjectId(tx, tenantId, params.id);
    if (!receipt.found) {
      return fail(404, "RESOURCE_NOT_FOUND", "Expense not found.");
    }
    if (receipt.mediaObjectId === null) {
      return fail(404, "RESOURCE_NOT_FOUND", "This expense has no receipt.");
    }

    const media = await fetchNewsMediaObjectById(
      tx,
      tenantId,
      receipt.mediaObjectId
    );
    if (!media) {
      return fail(404, "RESOURCE_NOT_FOUND", "This expense has no receipt.");
    }
    if (
      media.visibility !== "private" ||
      !isMediaObjectDownloadable(media.status)
    ) {
      await recordMediaDownloadIssuance(tx, {
        tenantId,
        mediaObjectId: media.id,
        objectKey: media.objectKey,
        outcome: "denied_not_downloadable",
        actorTenantUserId: auth.context.tenantUserId,
        correlationId: locals.correlationId
      });
      return fail(
        409,
        "EXPENSE_RECEIPT_UNAVAILABLE",
        "The receipt is not in a state that can be downloaded."
      );
    }

    const { config } = prepared;
    if (!config.enabled || findMissingNewsMediaR2Vars().length > 0) {
      return fail(
        502,
        "PROVIDER_ERROR",
        "Media storage is not configured for this deployment."
      );
    }

    await recordMediaDownloadIssuance(tx, {
      tenantId,
      mediaObjectId: media.id,
      objectKey: media.objectKey,
      outcome: "issued",
      actorTenantUserId: auth.context.tenantUserId,
      correlationId: locals.correlationId
    });

    const ttlSeconds = boundPresignedDownloadTtlSeconds(
      config.presignedDownloadTtlSeconds
    );
    const url = createNewsMediaR2Client({
      accountId: config.accountId,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      bucket: config.bucket
    }).presignDownloadUrl({ objectKey: media.objectKey, ttlSeconds });

    return ok(
      {
        expenseId: params.id,
        url,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString()
      },
      {},
      { "cache-control": "no-store" }
    );
  }
});
