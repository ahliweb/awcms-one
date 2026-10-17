/**
 * Raising the booking adapter's attention flag (Issue #380, ADR-0045 G7;
 * threat controls C-08/C-09).
 *
 * The flag lives on the reservation link (`attention_reason`, `attention_at`,
 * `attention_resolved_at`; `sql/1035`) and is the OPERATOR QUEUE: the adapter
 * never "fixes" a conflict between a payment and a reservation by itself (a
 * deposit that arrived after the hold lapsed is money, not an error to cancel
 * away); it records the fact, once, and a person decides.
 *
 * - A flag is raised only when none is OPEN (the table's guard refuses to
 *   replace an open one), so a replayed event and a second reason on the same
 *   link are no-ops: the first fact stays the work item. The UPDATE's own
 *   predicate does the check, so two concurrent consumers cannot both raise.
 * - The same transaction writes one audit row (no actor: it is the adapter, not
 *   a person, and `initiatedBy` says which consumer) and the domain event
 *   `awcms.commerce.booking_reservation_link.attention_raised`.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  COMMERCE_BOOKING_ATTENTION_RAISED_EVENT_TYPE,
  COMMERCE_EVENT_VERSION,
  COMMERCE_ORDER_AGGREGATE_TYPE
} from "../domain/commerce-events";
import type { BookingAttentionReason } from "../domain/booking-adapter";

const PRODUCER_MODULE = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_booking_reservation_link";

export type RaiseAttentionInput = {
  linkId: string;
  orderId: string;
  reservationId: string;
  reason: BookingAttentionReason;
  /** Which consumer or path raised it, for the audit row. */
  initiatedBy: string;
  correlationId?: string;
};

/** `true` when this call raised the flag, `false` when one was already open (nothing written). */
export async function raiseBookingAttention(
  tx: Bun.SQL,
  tenantId: string,
  input: RaiseAttentionInput
): Promise<boolean> {
  const rows = (await tx`
    UPDATE awcms_commerce_booking_reservation_links
    SET attention_reason = ${input.reason},
        attention_at = now(),
        attention_resolved_at = NULL,
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${input.linkId}
      AND (attention_reason IS NULL OR attention_resolved_at IS NOT NULL)
    RETURNING id
  `) as { id: string }[];
  if (rows.length === 0) return false;

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: "commerce",
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: input.linkId,
    severity: "warning",
    message: `Booking attention raised: ${input.reason}.`,
    attributes: {
      orderId: input.orderId,
      reservationId: input.reservationId,
      reason: input.reason,
      initiatedBy: input.initiatedBy
    },
    correlationId: input.correlationId
  });

  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_BOOKING_ATTENTION_RAISED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_ORDER_AGGREGATE_TYPE,
    aggregateId: input.orderId,
    producerModule: PRODUCER_MODULE,
    correlationId: input.correlationId,
    payload: {
      orderId: input.orderId,
      reservationId: input.reservationId,
      reason: input.reason
    }
  });
  return true;
}
