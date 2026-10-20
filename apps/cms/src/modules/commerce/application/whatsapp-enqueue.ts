/**
 * `enqueueWhatsappMessage` (Issue #108, contract #106/ADR-0017 D5; a mode router
 * since Issue #392, ADR-0133 section 6 phase 2) - the ONE function every
 * commerce caller (customer OTP, order paid, campaigns, document delivery, ADR-0034)
 * uses to send a WhatsApp message. Its signature is unchanged. It takes the
 * caller's own transaction, so the message commits with the fact that produced
 * it, and it never calls a provider (ADR-0006).
 *
 * ## Where a NEW message goes: the tenant's mode
 *
 *   * `legacy` (the default) - `whatsapp-enqueue-legacy.ts`: the function exactly
 *     as it was, one INSERT into `awcms_commerce_whatsapp_messages`, drained by
 *     `commerce:whatsapp:dispatch`. A tenant in this mode is byte-for-byte
 *     unchanged; `tests/integration/commerce-whatsapp-compat.integration.test.ts`
 *     pins the row it writes.
 *   * `upstream` - `whatsapp-upstream-enqueue.ts`: `WhatsappDeliveryPort.enqueue`
 *     in the same transaction, drained by `whatsapp:dispatch`.
 *
 * There is NO dual write and NO row copying: a message is in exactly one queue,
 * the one the tenant's mode named when it was enqueued. Rows already in the
 * legacy queue when a tenant moves to `upstream` are drained by the legacy
 * dispatcher, which stays; the guarded flip that waits for that drain is issue
 * #393. The mode is read under a shared advisory lock (`whatsapp-mode.ts`) so it
 * cannot change between this read and the commit.
 *
 * ## The result
 *
 * `{ id, bodyRendered, enqueued }`: `legacy` always answers `enqueued: true`, as
 * the function always inserted. `upstream` can answer `enqueued: false` with a
 * `reason` (consent required, suppressed, disabled, rate limited, ...): the port
 * returns those rather than throwing, and so does this. A caller that records
 * the outcome (a campaign recipient, a document delivery) reads `enqueued`; a
 * caller that does not (the customer OTP, whose HTTP answer must not reveal
 * whether an address could be reached) may ignore it.
 *
 * ## Channel availability is tenant-aware too
 *
 * `isWhatsappChannelAvailable` is what a caller asks BEFORE issuing an OTP or
 * recording a delivery: `legacy` asks the legacy flag (`COMMERCE_WHATSAPP_ENABLED`),
 * `upstream` asks the queue's (`WHATSAPP_ENABLED`) - each is the gate its own
 * dispatcher honours.
 */
import { isWhatsappEnabled } from "../../whatsapp-delivery/domain/whatsapp-config";
import type {
  EnqueueWhatsappMessageInput,
  EnqueueWhatsappMessageResult
} from "../domain/whatsapp-enqueue-types";
import { isWhatsappChannelEnabled } from "../domain/whatsapp-config";
import { enqueueLegacyWhatsappMessage } from "./whatsapp-enqueue-legacy";
import { readWhatsappMode, resolveWhatsappMode } from "./whatsapp-mode";
import { enqueueUpstreamWhatsappMessage } from "./whatsapp-upstream-enqueue";

export type {
  EnqueueWhatsappMessageInput,
  EnqueueWhatsappMessageResult
} from "../domain/whatsapp-enqueue-types";

export async function enqueueWhatsappMessage(
  tx: Bun.SQL,
  input: EnqueueWhatsappMessageInput
): Promise<EnqueueWhatsappMessageResult> {
  const mode = await resolveWhatsappMode(tx, input.tenantId);

  if (mode === "upstream") {
    return enqueueUpstreamWhatsappMessage(tx as Bun.TransactionSQL, input);
  }

  return { ...(await enqueueLegacyWhatsappMessage(tx, input)), enqueued: true };
}

/**
 * Whether the tenant's WhatsApp channel would actually be serviced by a
 * dispatcher: the legacy flag in `legacy` mode, the queue's in `upstream` mode.
 * Reads the mode without the write lock (nothing is written here), and only when
 * the answer depends on it: with both flags off, or both on, every mode answers
 * the same, so a deployment that has not turned the queue on is asked nothing of
 * the database (and a `legacy` deployment behaves exactly as before the mode).
 */
export async function isWhatsappChannelAvailable(
  tx: Bun.SQL,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const legacyOn = isWhatsappChannelEnabled(env);
  const upstreamOn = isWhatsappEnabled(env);

  if (legacyOn === upstreamOn) return legacyOn;

  return (await readWhatsappMode(tx, tenantId)) === "upstream"
    ? upstreamOn
    : legacyOn;
}
