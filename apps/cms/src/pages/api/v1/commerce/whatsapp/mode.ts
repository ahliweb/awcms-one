/**
 * `GET` / `POST /api/v1/commerce/whatsapp/mode` (Issue #393, ADR-0133 section 6
 * phase 3, ADR-0047 "Cutover") - which queue a tenant's NEW WhatsApp messages go
 * to, and the guarded flip between `legacy` and `upstream`.
 *
 * `GET` (`commerce.whatsapp_mode.read`) answers the mode, the drain state of both
 * queues, what the channel would face if flipped and what a flip to the other
 * mode would be refused for right now. `POST` (`commerce.whatsapp_mode.manage`,
 * high-risk) flips it, or with `dryRun` only reports. The rule lives in
 * `flipWhatsappMode` (one function, shared with
 * `bun run commerce:whatsapp:cutover`): the flip is refused `409` while the queue
 * being left holds a non-terminal row, while the queue being entered cannot send,
 * and until the warnings are acknowledged. A refusal carries the whole evidence
 * record in `error.details`.
 *
 * A real flip additionally requires a recent step-up (`STEP_UP_REQUIRED`) and an
 * `Idempotency-Key`; a dry run needs neither, because it writes nothing. The
 * step-up gate follows `POST /api/v1/auth/mfa/admin/reset`.
 *
 * Issue #449: the drain that blocks a ROLLBACK counts only commerce's own rows in
 * the shared upstream queue, `force: true` (rollback only, same permission and
 * step-up, its own audit action) overrides it, and both responses carry
 * `channelEnvironmentNotice` - the channel facts are read from THIS web process,
 * not from the dispatchers that will send.
 */
import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { requireStepUp } from "../../../../../modules/identity-access/application/mfa-session-assurance";
import {
  flipWhatsappMode,
  readWhatsappModeStatus
} from "../../../../../modules/commerce/application/whatsapp-mode-flip";
import {
  WHATSAPP_MODE_MANAGE_GUARD,
  WHATSAPP_MODE_READ_GUARD,
  findFlipReplay,
  flipIdempotencyErrorResponse,
  flipRequestHash,
  flipResultResponse,
  readFlipRequestBody,
  saveFlipReplay,
  type FlipRequestBody
} from "../../../../../modules/commerce/application/whatsapp-mode-http";
import { requireIdempotencyKey } from "../../../../../modules/commerce/application/register-http";

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: WHATSAPP_MODE_READ_GUARD,
  handler: async ({ tx, tenantId }) =>
    ok(await readWhatsappModeStatus(tx, tenantId, { surface: "api" }))
});

type Prepared = { body: FlipRequestBody; idempotencyKey: string | null };

export const POST = defineTenantRoute<Prepared>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const body = await readFlipRequestBody(request);
    if (body instanceof Response) return body;

    if (body.dryRun) return { body, idempotencyKey: null };

    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;

    return { body, idempotencyKey: key.key };
  },
  authorize: WHATSAPP_MODE_MANAGE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, tokenHash, now, locals }) => {
    const { body, idempotencyKey } = prepared;

    if (!body.dryRun) {
      const stepUp = await requireStepUp(tx, tenantId, tokenHash, now);
      if (!stepUp.ok) return stepUp.denied;
    }

    const requestHash = flipRequestHash(auth.context.tenantUserId, body);

    try {
      if (idempotencyKey) {
        const replay = await findFlipReplay(
          tx,
          tenantId,
          idempotencyKey,
          auth.context.tenantUserId,
          requestHash
        );
        if (replay) return ok(replay);
      }

      const result = await flipWhatsappMode(
        tx,
        tenantId,
        { tenantUserId: auth.context.tenantUserId, surface: "api" },
        body.to,
        {
          reason: body.reason,
          ...(body.from ? { expected: body.from } : {}),
          acknowledgeWarnings: body.acknowledgeWarnings,
          dryRun: body.dryRun,
          force: body.force,
          correlationId: locals.correlationId
        }
      );

      if (
        idempotencyKey &&
        (result.outcome === "flipped" || result.outcome === "unchanged")
      ) {
        await saveFlipReplay(
          tx,
          tenantId,
          idempotencyKey,
          auth.context.tenantUserId,
          requestHash,
          result.evidence
        );
      }

      return flipResultResponse(result);
    } catch (error) {
      // tx-swallow-ok: IdempotencyRaceLostError and
      // IdempotencyPayloadMismatchError are raised by application code after
      // statements that succeeded (ON CONFLICT DO NOTHING plus a replay
      // lookup), so the transaction is healthy.
      const mapped = flipIdempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
