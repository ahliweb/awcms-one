/**
 * The `upstream` path of `enqueueWhatsappMessage` (Issue #392, ADR-0133 section
 * 6 phase 2): commerce's call into the `whatsapp_delivery` queue through
 * `WhatsappDeliveryPort`, in the CALLER's transaction.
 *
 * ## What this file may and may not import
 *
 * Only `_shared/ports/whatsapp-delivery-port.ts` (the shapes), the
 * `whatsapp_delivery` in-process adapter and config (the composition seam, the
 * way `commerce-inventory.ts` names the inventory adapter) and commerce's PURE
 * `domain/` files. Never the legacy table, the legacy writer, the legacy
 * provider or the legacy dispatcher: `tests/commerce-whatsapp-upstream-boundary.test.ts`
 * fails if this file, or any other file on the upstream path, names one. That is
 * ADR-0133 section 6 end condition 1 made checkable before the end condition
 * itself, and it is what keeps "one queue per channel" true by construction.
 *
 * ## What the mapping does
 *
 *   * the template key is the commerce key; its PURPOSE was fixed at
 *     registration (`domain/whatsapp-upstream-templates.ts`), so a caller cannot
 *     send the campaign as transactional;
 *   * the recipient is `{ kind: "address" }`: commerce holds a customer's phone
 *     on its own customer row, with no `profile_identity` profile to resolve;
 *   * a `security` message (the customer OTP) carries `expiresAt` = now + the
 *     code's own validity (`expiresInMinutes`), so a code that cannot be sent
 *     inside its window is expired, never sent late;
 *   * the idempotency key is `commerce:<caller identity>` when the caller named
 *     one (a campaign recipient, a document delivery), else a fresh one;
 *   * the correlation id is the caller's own (an OTP request, a delivery id, a
 *     dispatch run), so status is read back by it and never copied into a
 *     commerce table.
 *
 * A refusal or suppression is RETURNED as `enqueued: false` with its reason,
 * never thrown (the port's contract, and the reason a returned 4xx after a
 * refusal still commits the surrounding transaction - callers decide what a
 * non-queued message means for their own record).
 */
import { randomUUID, createHash } from "node:crypto";

import type { EnqueueWhatsappResult } from "../../_shared/ports/whatsapp-delivery-port";
import { whatsappDeliveryPortAdapter } from "../../whatsapp-delivery/application/whatsapp-enqueue";
import type {
  EnqueueWhatsappMessageInput,
  EnqueueWhatsappMessageResult,
  WhatsappNotQueuedReason
} from "../domain/whatsapp-enqueue-types";
import { COMMERCE_UPSTREAM_TEMPLATE_PLANS } from "../domain/whatsapp-upstream-templates";
import { renderWhatsappTemplate } from "../domain/whatsapp-templates";

/** The longest idempotency key the queue accepts (`whatsapp_delivery`'s own bound). */
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
/** A customer OTP is valid for 10 minutes (`OTP_TTL_SECONDS`); used only when the variable is unusable. */
const FALLBACK_OTP_VALIDITY_MINUTES = 10;
const MAX_OTP_VALIDITY_MINUTES = 24 * 60;

/** `commerce:<identity>`, or a hash of it when that would not fit the queue's key length. Pure. */
export function upstreamIdempotencyKey(
  identity: string | undefined,
  templateKey: string
): string {
  const key = `commerce:${identity ?? `${templateKey}:${randomUUID()}`}`;

  return key.length <= MAX_IDEMPOTENCY_KEY_LENGTH
    ? key
    : `commerce:sha256:${createHash("sha256").update(key).digest("hex")}`;
}

/** When a `security` message stops being worth sending, from the code's own validity. Pure. */
export function otpExpiresAt(
  variables: Record<string, string>,
  now: Date
): Date {
  const minutes = Number.parseInt(variables.expiresInMinutes ?? "", 10);
  const validFor =
    Number.isFinite(minutes) && minutes > 0
      ? Math.min(minutes, MAX_OTP_VALIDITY_MINUTES)
      : FALLBACK_OTP_VALIDITY_MINUTES;

  return new Date(now.getTime() + validFor * 60_000);
}

/** The port's outcome, in the legacy result shape plus `enqueued`. Pure. */
export function toEnqueueResult(
  outcome: EnqueueWhatsappResult,
  bodyRendered: string
): EnqueueWhatsappMessageResult {
  switch (outcome.status) {
    case "queued":
    case "duplicate":
      return { id: outcome.messageId, bodyRendered, enqueued: true };
    case "suppressed":
      return {
        id: "",
        bodyRendered,
        enqueued: false,
        reason:
          outcome.reason === "opt_out"
            ? "SUPPRESSED_OPT_OUT"
            : "SUPPRESSED_HARD_FAILURE"
      };
    case "refused":
      return {
        id: "",
        bodyRendered,
        enqueued: false,
        reason: outcome.reason satisfies WhatsappNotQueuedReason
      };
  }
}

export async function enqueueUpstreamWhatsappMessage(
  tx: Bun.TransactionSQL,
  input: EnqueueWhatsappMessageInput,
  now: Date = new Date()
): Promise<EnqueueWhatsappMessageResult> {
  const plan = COMMERCE_UPSTREAM_TEMPLATE_PLANS[input.templateKey];
  // The wording as commerce renders it: returned to the caller exactly as the
  // legacy writer returned it. The queue renders (and, for an OTP, later clears)
  // its own copy.
  const bodyRendered = renderWhatsappTemplate(
    input.templateKey,
    input.variables
  );

  const outcome = await whatsappDeliveryPortAdapter.enqueue(tx, {
    tenantId: input.tenantId,
    templateKey: input.templateKey,
    variables: input.variables,
    recipient: { kind: "address", phone: input.toPhone },
    idempotencyKey: upstreamIdempotencyKey(
      input.idempotencyKey,
      input.templateKey
    ),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(plan.purpose === "security"
      ? { expiresAt: otpExpiresAt(input.variables, now) }
      : {})
  });

  return toEnqueueResult(outcome, bodyRendered);
}
