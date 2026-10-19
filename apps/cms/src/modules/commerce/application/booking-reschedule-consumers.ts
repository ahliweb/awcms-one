/**
 * The domain-event handlers of the booking reschedule and no-show (Issue #382,
 * ADR-0045 D15; threat controls C-38, C-41). Declared in
 * `booking-adapter-consumers.ts` with the default `runtime_effect_once`
 * idempotency, so each handler is the SIDE EFFECT and none calls
 * `applyConsumerEffectOnce`; every one is ALSO a no-op on a state it has already
 * produced, so a replayed event changes nothing.
 *
 * ## Both exist for the case the adapter did not do itself
 *
 * A reschedule or a no-show made THROUGH the adapter (the staff routes) writes
 * everything in its own transaction: the reservation link is already moved or
 * released when Booking's event arrives, so these handlers find nothing to do.
 * They matter when a person acts in Booking's OWN screens:
 *
 *   - **`commerce.booking_rescheduled_link_reconciler`**
 *     (`awcms.booking.reservation.rescheduled`): Booking carried the order
 *     reference to the replacement reservation, but the commerce link still names
 *     the old one - the order is left with ONE reference. The handler restores
 *     the pair (zero or two, never one): the old link is superseded and a new
 *     link for the replacement points at the same order and line. Whether the
 *     night count changed is not priced here (there is no actor to charge and no
 *     quote the person saw), so the new link is flagged
 *     `rescheduled_externally` for an operator, who settles any difference by
 *     the ordinary order and refund paths. A replacement whose reference does
 *     not name the order is NOT relinked: the old link is flagged instead.
 *   - **`commerce.booking_no_show_decision_recorder`**
 *     (`awcms.booking.reservation.no_show`): records the decision of a no-show a
 *     person marked in Booking, under the policy's retention rule, as the
 *     system. The money rule is the same as the staff route's: it retains by the
 *     original policy version and creates no refund leg.
 *
 * Everything is derived from the database, never from the event (C-05, X7): the
 * order is the one the reservation LINK names, the replacement's reference is
 * read from the reservation row, the money is the ledger's. An event for a
 * reservation with no link (a staff booking made directly in Booking) is not
 * ours and is ignored.
 */
import { composedBookingPort } from "../../../lib/composition/booking-port";
import { BOOKING_RESERVATION_ORDER_REFERENCE_TYPE } from "../domain/booking-adapter";
import { DEFAULT_NO_SHOW_REASON_CODE } from "../domain/booking-no-show";
import { raiseBookingAttention } from "./booking-attention";
import { recordBookingNoShow } from "./booking-no-show";
import { readBookingReservation } from "./booking-reservation-reads";
import { fetchReservationLinkByReservationId } from "./booking-reservation-links";
import { lockOrderForSettlement } from "./payment-allocation-directory";

const RECONCILER = "commerce.booking_rescheduled_link_reconciler";
const NO_SHOW_RECORDER = "commerce.booking_no_show_decision_recorder";

export type ReconcileOutcome =
  | "not_a_booking_order"
  | "already_reconciled"
  | "relinked"
  | "reference_mismatch";

type LinkRow = {
  id: string;
  order_id: string;
  order_item_id: string;
  reservation_id: string;
  offering_link_id: string;
};

/**
 * `awcms.booking.reservation.rescheduled` -> the order keeps TWO references. The
 * event's aggregate is the OLD reservation and `supersededById` the replacement;
 * both are only LOOKUP keys - the order is the one the old link names.
 */
export async function reconcileRescheduledReservation(
  tx: Bun.TransactionSQL,
  tenantId: string,
  oldReservationId: string,
  replacementReservationId: string | null,
  correlationId: string
): Promise<ReconcileOutcome> {
  const found = (await tx`
    SELECT id, order_id, order_item_id, reservation_id, offering_link_id
    FROM awcms_commerce_booking_reservation_links
    WHERE tenant_id = ${tenantId} AND reservation_id = ${oldReservationId}
      AND status = 'active'
  `) as LinkRow[];
  if (!found[0]) {
    // Moved by the adapter itself (its link is already superseded), or not ours.
    return "not_a_booking_order";
  }
  if (replacementReservationId === null) return "already_reconciled";

  // The order lock, then everything again under it (the cancel's lock order),
  // so a staff reschedule or cancel running now queues with this repair.
  const header = await lockOrderForSettlement(tx, tenantId, found[0].order_id);
  if (!header) return "not_a_booking_order";
  const rows = (await tx`
    SELECT id, order_id, order_item_id, reservation_id, offering_link_id
    FROM awcms_commerce_booking_reservation_links
    WHERE tenant_id = ${tenantId} AND id = ${found[0].id} AND status = 'active'
  `) as LinkRow[];
  const old = rows[0];
  if (!old) return "already_reconciled";

  const existing = await fetchReservationLinkByReservationId(
    tx,
    tenantId,
    replacementReservationId
  );
  if (existing) return "already_reconciled";

  const replacement = await readBookingReservation(
    tx,
    tenantId,
    replacementReservationId
  );
  if (
    !replacement ||
    replacement.externalRefType !== BOOKING_RESERVATION_ORDER_REFERENCE_TYPE ||
    replacement.externalRef !== old.order_id
  ) {
    // Booking's replacement does not name the order: not a move we can mirror.
    await raiseBookingAttention(tx, tenantId, {
      linkId: old.id,
      orderId: old.order_id,
      reservationId: old.reservation_id,
      reason: "rescheduled_externally",
      initiatedBy: RECONCILER,
      correlationId
    });
    return "reference_mismatch";
  }

  const superseded = (await tx`
    UPDATE awcms_commerce_booking_reservation_links
    SET status = 'superseded', updated_at = now(),
        attention_resolved_at = CASE
          WHEN attention_reason IS NOT NULL AND attention_resolved_at IS NULL
            THEN now() ELSE attention_resolved_at END
    WHERE tenant_id = ${tenantId} AND id = ${old.id} AND status = 'active'
    RETURNING id
  `) as { id: string }[];
  if (superseded.length === 0) return "already_reconciled";

  const created = (await tx`
    INSERT INTO awcms_commerce_booking_reservation_links (
      tenant_id, order_id, order_item_id, reservation_id, offering_link_id,
      supersedes_link_id, client_key, request_hash
    )
    VALUES (
      ${tenantId}, ${old.order_id}, ${old.order_item_id},
      ${replacementReservationId}, ${old.offering_link_id}, ${old.id},
      ${`bx1:${replacementReservationId}`}, ${"external-reschedule"}
    )
    RETURNING id
  `) as { id: string }[];

  await raiseBookingAttention(tx, tenantId, {
    linkId: created[0]!.id,
    orderId: old.order_id,
    reservationId: replacementReservationId,
    reason: "rescheduled_externally",
    initiatedBy: RECONCILER,
    correlationId
  });
  return "relinked";
}

export type NoShowRecorderOutcome =
  "not_a_booking_order" | "already_recorded" | "recorded" | "refused";

/**
 * `awcms.booking.reservation.no_show` -> the decision of a no-show a person
 * marked in Booking's own screen. The link is read with the order lock inside
 * the service; a link already released (the adapter marked it itself) or already
 * decided is a no-op.
 */
export async function recordNoShowForReservation(
  tx: Bun.TransactionSQL,
  tenantId: string,
  reservationId: string,
  correlationId: string
): Promise<NoShowRecorderOutcome> {
  const link = await fetchReservationLinkByReservationId(
    tx,
    tenantId,
    reservationId
  );
  if (!link) return "not_a_booking_order";
  // Marked through the adapter: its own transaction released the link.
  if (link.status !== "active") return "already_recorded";

  const result = await recordBookingNoShow(
    tx,
    {
      tenantId,
      actor: { kind: "system", initiatedBy: NO_SHOW_RECORDER },
      correlationId,
      port: await composedBookingPort()
    },
    {
      link,
      idempotencyKey: null,
      reasonCode: DEFAULT_NO_SHOW_REASON_CODE
    }
  );
  if (result.kind === "refused") {
    return result.refusal.code === "INVALID_STATE"
      ? "already_recorded"
      : "refused";
  }
  return result.kind === "replayed" ? "already_recorded" : "recorded";
}
