/**
 * The HTTP plumbing of `GET` / `POST /api/v1/commerce/whatsapp/mode` (Issue
 * #393): the two guards, the request body, the idempotency record and the one
 * mapping from a {@link FlipResult} to a response. Kept out of the route file so
 * the route stays thin and the mapping is testable without a request.
 */
import { fail, ok } from "../../_shared/api-response";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord,
  userIdempotencyActor
} from "../../_shared/idempotency";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../lib/security/request-body-limit";
import { COMMERCE_WHATSAPP_MODE_ACTIVITY_CODE } from "../domain/commerce-permissions";
import { validateFlipReason } from "../domain/whatsapp-cutover";
import { WHATSAPP_MODES, type WhatsappMode } from "../domain/whatsapp-mode";
import type { FlipEvidence, FlipResult } from "./whatsapp-mode-flip";
import { IdempotencyPayloadMismatchError } from "./order-directory";

export const WHATSAPP_MODE_READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_WHATSAPP_MODE_ACTIVITY_CODE,
  action: "read"
} as const;

export const WHATSAPP_MODE_MANAGE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_WHATSAPP_MODE_ACTIVITY_CODE,
  action: "manage"
} as const;

/** The scope the flip's idempotency records are kept under (`awcms_idempotency_keys.request_scope`). */
export const WHATSAPP_MODE_FLIP_SCOPE = "commerce.whatsapp_mode.flip";

export type FlipRequestBody = {
  to: WhatsappMode;
  reason: string;
  from?: WhatsappMode;
  acknowledgeWarnings: boolean;
  dryRun: boolean;
};

const ALLOWED_KEYS = new Set([
  "to",
  "reason",
  "from",
  "acknowledgeWarnings",
  "dryRun"
]);

const isMode = (value: unknown): value is WhatsappMode =>
  typeof value === "string" &&
  (WHATSAPP_MODES as readonly string[]).includes(value);

/** Reads and validates the POST body, or answers the finished `400` / `413`. */
export async function readFlipRequestBody(
  request: Request
): Promise<FlipRequestBody | Response> {
  const read = await readJsonBody(request);

  if (read.tooLarge) return bodyTooLargeResponse(read.limitBytes);
  if (read.malformed || read.value === null) {
    return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }

  const body = read.value as Record<string, unknown>;

  if (typeof body !== "object" || Array.isArray(body)) {
    return fail(400, "VALIDATION_ERROR", "Request body must be an object.");
  }

  const errors: { field: string; message: string }[] = [];

  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) {
      errors.push({ field: key, message: "Unknown field." });
    }
  }
  if (!isMode(body.to)) {
    errors.push({ field: "to", message: "to must be legacy or upstream." });
  }
  if (body.from !== undefined && !isMode(body.from)) {
    errors.push({
      field: "from",
      message: "from must be legacy or upstream."
    });
  }
  for (const flag of ["acknowledgeWarnings", "dryRun"] as const) {
    if (body[flag] !== undefined && typeof body[flag] !== "boolean") {
      errors.push({ field: flag, message: `${flag} must be a boolean.` });
    }
  }
  const reason = validateFlipReason(body.reason);
  if (!reason.valid) {
    errors.push({ field: "reason", message: reason.message });
  }

  if (errors.length > 0 || !reason.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Request body failed validation.",
      {},
      errors
    );
  }

  return {
    to: body.to as WhatsappMode,
    reason: reason.reason,
    ...(isMode(body.from) ? { from: body.from } : {}),
    acknowledgeWarnings: body.acknowledgeWarnings === true,
    dryRun: body.dryRun === true
  };
}

/** `409`: a refusal carries the full evidence record in `details`, so the caller sees every blocker. */
export function flipResultResponse(result: FlipResult): Response {
  if (result.outcome === "refused" && result.evidence.refusal) {
    return fail(
      409,
      result.evidence.refusal.code,
      result.evidence.refusal.message,
      {},
      result.evidence
    );
  }

  return ok(result.evidence);
}

/** The same key with a different request: `409 IDEMPOTENCY_CONFLICT`. */
export function flipIdempotencyErrorResponse(error: unknown): Response | null {
  if (error instanceof IdempotencyPayloadMismatchError) {
    return fail(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key was already used with a different request."
    );
  }

  return null;
}

export function flipRequestHash(
  actorTenantUserId: string,
  body: FlipRequestBody
): string {
  return computeRequestHash({
    scope: WHATSAPP_MODE_FLIP_SCOPE,
    actorTenantUserId,
    to: body.to,
    from: body.from ?? null,
    reason: body.reason,
    acknowledgeWarnings: body.acknowledgeWarnings
  });
}

/** A stored response for this key, `null` when none, or a thrown mismatch when the key was used for another request. */
export async function findFlipReplay(
  tx: Bun.SQL,
  tenantId: string,
  idempotencyKey: string,
  actorTenantUserId: string,
  requestHash: string
): Promise<FlipEvidence | null> {
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    WHATSAPP_MODE_FLIP_SCOPE,
    idempotencyKey,
    userIdempotencyActor(actorTenantUserId)
  );

  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw new IdempotencyPayloadMismatchError();
  }

  return existing.responseBody as FlipEvidence;
}

/** Remembers a flip that was applied or found already applied; refusals and dry runs are never stored (a retry must re-evaluate). */
export async function saveFlipReplay(
  tx: Bun.SQL,
  tenantId: string,
  idempotencyKey: string,
  actorTenantUserId: string,
  requestHash: string,
  evidence: FlipEvidence
): Promise<void> {
  await saveIdempotencyRecord(
    tx,
    tenantId,
    WHATSAPP_MODE_FLIP_SCOPE,
    idempotencyKey,
    userIdempotencyActor(actorTenantUserId),
    requestHash,
    200,
    evidence
  );
}
