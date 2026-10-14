/**
 * Reads the live status of `upstream`-mode WhatsApp messages back from the
 * `whatsapp_delivery` queue by correlation id (Issue #392, ADR-0133 section 8:
 * "status is read back by `correlationId` and is never copied into the caller's
 * table, so it cannot drift"). The one reader a commerce screen uses for a
 * message that left through the port - the document-delivery history today.
 *
 * Same import rules as `whatsapp-upstream-enqueue.ts`: the port's shapes and the
 * `whatsapp_delivery` adapter, never the legacy table.
 */
import type { WhatsappStatus } from "../../_shared/ports/whatsapp-delivery-port";
import { whatsappDeliveryPortAdapter } from "../../whatsapp-delivery/application/whatsapp-enqueue";
import type { OutboxStatus } from "../domain/document-delivery";

export type UpstreamOutboxState = {
  status: OutboxStatus;
  providerMessageId: string | null;
  retryCount: number;
  lastError: string | null;
  sentAt: string | null;
};

/**
 * The queue's `expired` (a `security` message that outlived its window) is a
 * terminal failure to send, and commerce's status vocabulary has no `expired`:
 * it reads as `failed`. The port exposes neither the provider message id nor an
 * attempt count (it is not a delivery log), so those are `null` and `0`; the
 * `failureCode` stands in for the last error.
 */
export function toOutboxState(status: WhatsappStatus): UpstreamOutboxState {
  return {
    status: status.status === "expired" ? "failed" : status.status,
    providerMessageId: null,
    retryCount: 0,
    lastError: status.failureCode,
    sentAt: status.sentAt
  };
}

/** The state of each correlation id the queue holds a message for; an id with none is absent from the map. */
export async function readUpstreamWhatsappStates(
  tx: Bun.SQL,
  tenantId: string,
  correlationIds: readonly string[]
): Promise<Map<string, UpstreamOutboxState>> {
  const result = new Map<string, UpstreamOutboxState>();

  for (const correlationId of correlationIds) {
    const [latest] = (
      await whatsappDeliveryPortAdapter.getStatusByCorrelation(
        tx as Bun.TransactionSQL,
        tenantId,
        correlationId
      )
    ).slice(-1);

    if (latest) {
      result.set(correlationId, toOutboxState(latest));
    }
  }

  return result;
}
