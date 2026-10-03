import {
  fail,
  jsonResponse,
  ok
} from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readTextBody
} from "../../../../../lib/security/request-body-limit";
import { resolveClientIp } from "../../../../../lib/security/rate-limit";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../modules/_shared/idempotency";
import { authorizeInTransaction } from "../../../../../modules/identity-access/application/access-guard";
import {
  applyCatalogImport,
  dryRunCatalogImport,
  sha256Hex
} from "../../../../../modules/commerce/application/catalog-import";
import { COMMERCE_PRODUCTS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const IDEMPOTENCY_SCOPE = "commerce_catalog_import_apply";

const IMPORT_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
  action: "import"
} as const;

/** An apply also needs the ordinary write permissions the rows exercise. */
const APPLY_EXTRA_GUARDS = [
  {
    moduleKey: "commerce",
    activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
    action: "create"
  },
  {
    moduleKey: "commerce",
    activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
    action: "update"
  }
] as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ACCEPTED_CONTENT_TYPES = ["text/csv", "text/plain", "application/csv"];

type Prepared = {
  mode: "dry_run" | "apply";
  csv: string;
  idempotencyKey: string | null;
  expectedSha256: string | null;
};

/**
 * `POST /api/v1/commerce/products/import?mode=dry_run|apply` (Issue #291) — body
 * is the CSV itself (`Content-Type: text/csv`, UTF-8), capped at the "large"
 * body tier (5 MiB) and {@link MAX_CATALOG_IMPORT_ROWS} data rows.
 *
 *   - `mode=dry_run` (default): validates every row, writes NOTHING, answers 200
 *     with the per-row report. Needs `commerce.products.import`.
 *   - `mode=apply`: needs `import` AND `create` AND `update`, and an
 *     `Idempotency-Key`. Re-runs the identical planner, then writes ALL rows or
 *     NONE (422 when the plan has errors, 409 on a write-time conflict). Replaying
 *     the same key with the same file returns the original response without
 *     re-applying; the same key with a different file is a 409. Optional
 *     `expectedSha256` (the dry-run report's `fileSha256`) refuses a file that
 *     differs from the one the operator reviewed.
 *
 * Rows match on `sku`; media is never fetched or referenced (see
 * `docs/adr/0027-catalog-custom-attributes-are-typed-and-allowlisted.md`).
 */
export const POST = defineTenantRoute<Prepared>({
  workClass: "background_sync",
  prepare: async ({ request, url }): Promise<Prepared | Response> => {
    const modeParam = url.searchParams.get("mode") ?? "dry_run";
    if (modeParam !== "dry_run" && modeParam !== "apply") {
      return fail(
        400,
        "VALIDATION_ERROR",
        'mode must be "dry_run" or "apply".'
      );
    }

    const contentType = (request.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (!ACCEPTED_CONTENT_TYPES.includes(contentType)) {
      return fail(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "The request body must be text/csv (UTF-8)."
      );
    }

    let idempotencyKey: string | null = null;
    if (modeParam === "apply") {
      idempotencyKey = request.headers.get("idempotency-key");
      if (!idempotencyKey) {
        return fail(
          400,
          "IDEMPOTENCY_REQUIRED",
          "Idempotency-Key header is required to apply an import."
        );
      }
    }

    const expectedSha256 = url.searchParams.get("expectedSha256");
    if (expectedSha256 !== null && !SHA256_PATTERN.test(expectedSha256)) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "expectedSha256 must be a lowercase hex SHA-256."
      );
    }

    const bodyRead = await readTextBody(request, "large");
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    return {
      mode: modeParam,
      csv: bodyRead.value,
      idempotencyKey,
      expectedSha256
    };
  },
  authorize: IMPORT_GUARD,
  handler: async ({
    tx,
    tenantId,
    auth,
    prepared,
    locals,
    request,
    clientAddress,
    tokenHash,
    now
  }) => {
    if (prepared.mode === "dry_run") {
      const report = await dryRunCatalogImport(tx, tenantId, prepared.csv);
      return ok(report);
    }

    for (const guard of APPLY_EXTRA_GUARDS) {
      const decision = await authorizeInTransaction(
        tx,
        tenantId,
        tokenHash,
        now,
        guard,
        { clientIp: resolveClientIp(request, clientAddress) }
      );
      if (!decision.allowed) return decision.denied;
    }

    const fileSha256 = sha256Hex(prepared.csv);
    if (
      prepared.expectedSha256 !== null &&
      prepared.expectedSha256 !== fileSha256
    ) {
      return fail(
        409,
        "IMPORT_FILE_MISMATCH",
        "The uploaded file differs from the one the dry-run reviewed (expectedSha256 does not match)."
      );
    }

    const idempotencyKey = prepared.idempotencyKey as string;
    // The file hash binds the key to the exact bytes: the same key with a
    // different file is a different request.
    const requestHash = computeRequestHash({
      fileSha256,
      action: "catalog_import_apply"
    });
    const existing = await findIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      idempotencyKey
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

    const outcome = await applyCatalogImport(
      tx,
      tenantId,
      auth.context.tenantUserId,
      prepared.csv,
      idempotencyKey,
      locals.correlationId
    );

    if (outcome.kind === "invalid") {
      return fail(
        422,
        "IMPORT_VALIDATION_FAILED",
        "The file has errors; nothing was imported.",
        {},
        outcome.report
      );
    }
    if (outcome.kind === "rolled_back") {
      return fail(409, "IMPORT_CONFLICT", outcome.message, {}, outcome.report);
    }

    const successResponse = ok(outcome.report);
    const successBody = await successResponse.clone().json();
    await saveIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      idempotencyKey,
      requestHash,
      200,
      successBody
    );
    return successResponse;
  }
});
