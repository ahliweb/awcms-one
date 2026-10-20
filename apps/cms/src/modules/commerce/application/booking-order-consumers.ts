/**
 * The booking adapter's domain-event handlers (Issue #380, ADR-0045 D15, G6,
 * G7, G11; threat controls C-08, C-09, C-38). Declared in
 * `booking-adapter-consumers.ts` with the default `runtime_effect_once`
 * idempotency, so each handler below is the SIDE EFFECT: the runtime guarantees
 * it runs once per (tenant, consumer, event), and none of them calls
 * `applyConsumerEffectOnce`. Every handler is ALSO a no-op on a state it has
 * already produced, so a replayed event (a fresh delivery row after a manual
 * re-drive) changes nothing either.
 *
 * ## Everything is derived from the database, never from the event (C-05, X7)
 *
 * A Booking event carries a reservation id (the aggregate) and the adapter's
 * opaque `externalRef`; neither is trusted. The order is the one the reservation
 * LINK names, the customer is that order's, the money is the ledger's, the
 * reservation state is read from the row. An event for a reservation with no
 * link (a staff booking made directly in Booking) is not ours and is ignored.
 *
 * ## The ledger decides, never a clock (C-08)
 *
 * The race between "the deposit arrived" and "the hold lapsed" is resolved by
 * what the ledger and the reservation say NOW:
 *
 *   - payment first, hold still `held`: the order reaches `paid` at the release
 *     threshold, `order.paid` is published, and the confirmer confirms. Booking
 *     then never expires the (confirmed) reservation.
 *   - hold expired first, no money yet: the expired-canceller expires the unpaid
 *     order. A payment that still arrives (a gateway callback after the window)
 *     is recorded on the ledger by the generic path - the money is real - and
 *     the late-payment flagger raises `deposit_after_expiry`.
 *   - hold expired, money arrived before the canceller ran: the order is `paid`
 *     or part-paid. The canceller REFUSES to cancel an order that holds settled
 *     money and raises the attention flag instead; the confirmer's confirm is
 *     refused (`HOLD_EXPIRED`) and raises the same.
 *
 * Booking's `lateCancellation` fact is ignored (G6): the commerce windows decide
 * money, and that is a later issue. The adapter never auto-cancels an order that
 * holds money and never auto-refunds; the attention flag is the work queue.
 *
 * ## Who Booking sees (G3)
 *
 * A call into the port passes the tenant's service-account user; with none
 * configured a confirm raises `confirm_failed` (the operator queue is the
 * place to learn it) and a hold release is skipped (the hold lapses on its own
 * at the order's expiry).
 */
import { composedBookingPort } from "../../../lib/composition/booking-port";
import { log } from "../../../lib/logging/logger";
import type { BookingAttentionReason } from "../domain/booking-adapter";
import { fetchBookingServiceActor } from "./booking-adapter-settings";
import { raiseBookingAttention } from "./booking-attention";
import { readBookingReservationStatus } from "./booking-reservation-reads";
import {
  cancelUnpaidOrderForBooking,
  expireOrderBySystem
} from "./order-directory";
import { orderHoldsSettledMoney } from "./payment-allocation-directory";

type LinkRef = {
  id: string;
  orderId: string;
  reservationId: string;
};

const CONFIRMED_OR_BEYOND = new Set([
  "confirmed",
  "checked_in",
  "completed",
  "no_show"
]);
const DEAD = new Set(["expired", "cancelled"]);

async function activeLinkForOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<LinkRef | null> {
  const rows = (await tx`
    SELECT id, order_id, reservation_id
    FROM awcms_commerce_booking_reservation_links
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND status = 'active'
  `) as { id: string; order_id: string; reservation_id: string }[];
  return rows[0]
    ? {
        id: rows[0].id,
        orderId: rows[0].order_id,
        reservationId: rows[0].reservation_id
      }
    : null;
}

async function activeLinkForReservation(
  tx: Bun.SQL,
  tenantId: string,
  reservationId: string
): Promise<LinkRef | null> {
  const rows = (await tx`
    SELECT id, order_id, reservation_id
    FROM awcms_commerce_booking_reservation_links
    WHERE tenant_id = ${tenantId} AND reservation_id = ${reservationId}
      AND status = 'active'
  `) as { id: string; order_id: string; reservation_id: string }[];
  return rows[0]
    ? {
        id: rows[0].id,
        orderId: rows[0].order_id,
        reservationId: rows[0].reservation_id
      }
    : null;
}

function flag(
  tx: Bun.SQL,
  tenantId: string,
  link: LinkRef,
  reason: BookingAttentionReason,
  initiatedBy: string,
  correlationId: string
): Promise<boolean> {
  return raiseBookingAttention(tx, tenantId, {
    linkId: link.id,
    orderId: link.orderId,
    reservationId: link.reservationId,
    reason,
    initiatedBy,
    correlationId
  });
}

export type ConfirmOutcome =
  | "not_a_booking_order"
  | "already_confirmed"
  | "confirmed"
  | "attention_deposit_after_expiry"
  | "attention_confirm_failed";

/**
 * `awcms.commerce.order.paid` -> confirm the held reservation (D16: `order.paid`
 * fires when settlement reaches the RELEASE THRESHOLD - the deposit for a
 * down-payment order, the total for a whole-total one - so it is exactly "the
 * deposit threshold was reached"; `order.settled` adds nothing the confirm
 * needs).
 */
export async function confirmReservationForPaidOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  correlationId: string
): Promise<ConfirmOutcome> {
  const link = await activeLinkForOrder(tx, tenantId, orderId);
  if (!link) return "not_a_booking_order";

  const by = "commerce.booking_order_paid_confirmer";
  const status = await readBookingReservationStatus(
    tx,
    tenantId,
    link.reservationId
  );
  if (status !== null && CONFIRMED_OR_BEYOND.has(status)) {
    return "already_confirmed";
  }
  if (status !== null && DEAD.has(status)) {
    await flag(tx, tenantId, link, "deposit_after_expiry", by, correlationId);
    return "attention_deposit_after_expiry";
  }
  if (status !== "held") {
    await flag(tx, tenantId, link, "confirm_failed", by, correlationId);
    return "attention_confirm_failed";
  }

  const actor = await fetchBookingServiceActor(tx, tenantId);
  if (!actor) {
    await flag(tx, tenantId, link, "confirm_failed", by, correlationId);
    return "attention_confirm_failed";
  }

  const confirmed = await (
    await composedBookingPort()
  ).confirm(tx, {
    tenantId,
    reservationId: link.reservationId,
    // Derived from the link, never from the event or the client.
    idempotencyKey: `commerce-booking-confirm:${link.id}`,
    correlationId,
    actorTenantUserId: actor
  });
  if (confirmed.ok) return "confirmed";

  if (confirmed.reason === "HOLD_EXPIRED") {
    await flag(tx, tenantId, link, "deposit_after_expiry", by, correlationId);
    return "attention_deposit_after_expiry";
  }
  const after = await readBookingReservationStatus(
    tx,
    tenantId,
    link.reservationId
  );
  if (after !== null && DEAD.has(after)) {
    await flag(tx, tenantId, link, "deposit_after_expiry", by, correlationId);
    return "attention_deposit_after_expiry";
  }
  await flag(tx, tenantId, link, "confirm_failed", by, correlationId);
  return "attention_confirm_failed";
}

export type CancellerOutcome =
  | "not_a_booking_order"
  | "order_cancelled"
  | "order_already_closed"
  | "attention_raised"
  | "attention_already_open";

/**
 * `awcms.booking.reservation.expired` / `.cancelled` -> the UNPAID order goes
 * with its reservation; an order that holds settled money is never cancelled by
 * an event, the attention flag is raised instead (C-08: `deposit_after_expiry`
 * for an expiry, `cancelled_externally_paid` for a cancel made outside the
 * adapter).
 */
export async function closeOrderForEndedReservation(
  tx: Bun.SQL,
  tenantId: string,
  reservationId: string,
  how: "expired" | "cancelled",
  correlationId: string
): Promise<CancellerOutcome> {
  const link = await activeLinkForReservation(tx, tenantId, reservationId);
  if (!link) return "not_a_booking_order";

  const by =
    how === "expired"
      ? "commerce.booking_expired_order_canceller"
      : "commerce.booking_cancelled_order_canceller";

  const holdsMoney = await orderHoldsSettledMoney(tx, tenantId, link.orderId);
  if (holdsMoney === null) return "not_a_booking_order";
  if (holdsMoney) {
    const raised = await flag(
      tx,
      tenantId,
      link,
      how === "expired" ? "deposit_after_expiry" : "cancelled_externally_paid",
      by,
      correlationId
    );
    return raised ? "attention_raised" : "attention_already_open";
  }

  const rows = (await tx`
    SELECT status FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${link.orderId} AND deleted_at IS NULL
  `) as { status: string }[];
  if (rows[0]?.status !== "pending_payment") return "order_already_closed";

  if (how === "expired") {
    await expireOrderBySystem(tx, tenantId, link.orderId, correlationId);
    return "order_cancelled";
  }
  const result = await cancelUnpaidOrderForBooking(
    tx,
    tenantId,
    link.orderId,
    correlationId
  );
  return result === "cancelled" ? "order_cancelled" : "order_already_closed";
}

export type ReleaseOutcome =
  | "not_a_booking_order"
  | "hold_released"
  | "nothing_to_release"
  | "attention_raised"
  | "no_service_actor";

/**
 * `awcms.commerce.order.cancelled` / `.expired` -> release the reservation's
 * hold (G11): an unpaid booking order cancelled through the generic admin path
 * frees its claim at once instead of at the hold's expiry. A reservation that is
 * already past `held` is left alone; a CONFIRMED reservation behind a cancelled
 * order holding money is an inconsistency an operator must see.
 */
export async function releaseHoldForClosedOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  correlationId: string
): Promise<ReleaseOutcome> {
  const link = await activeLinkForOrder(tx, tenantId, orderId);
  if (!link) return "not_a_booking_order";

  const status = await readBookingReservationStatus(
    tx,
    tenantId,
    link.reservationId
  );
  if (status === "held") {
    const actor = await fetchBookingServiceActor(tx, tenantId);
    if (!actor) {
      log("warning", "booking.hold_release_skipped_no_service_actor", {
        tenantId,
        orderId
      });
      return "no_service_actor";
    }
    const released = await (
      await composedBookingPort()
    ).cancel(tx, {
      tenantId,
      reservationId: link.reservationId,
      idempotencyKey: `commerce-booking-release:${link.id}`,
      correlationId,
      actorTenantUserId: actor,
      reasonCode: "order_closed"
    });
    // A refusal here means the hold ended on its own meanwhile: nothing to do.
    return released.ok ? "hold_released" : "nothing_to_release";
  }

  if (status !== null && CONFIRMED_OR_BEYOND.has(status)) {
    if (await orderHoldsSettledMoney(tx, tenantId, orderId)) {
      const raised = await flag(
        tx,
        tenantId,
        link,
        "cancelled_externally_paid",
        "commerce.booking_order_cancelled_hold_releaser",
        correlationId
      );
      return raised ? "attention_raised" : "nothing_to_release";
    }
  }
  return "nothing_to_release";
}

export type LatePaymentOutcome =
  | "not_a_booking_order"
  | "reservation_live"
  | "attention_raised"
  | "attention_already_open";

/**
 * `awcms.commerce.payment.recorded` -> money reached an order whose reservation
 * is already dead (`expired` or `cancelled`): record the fact for an operator
 * (`deposit_after_expiry`). Covers the path nothing else sees - a gateway
 * callback after the order was already closed, where the ledger records the
 * leg but the order stays closed and `order.paid` never fires.
 */
export async function flagPaymentOnDeadReservation(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  correlationId: string
): Promise<LatePaymentOutcome> {
  const link = await activeLinkForOrder(tx, tenantId, orderId);
  if (!link) return "not_a_booking_order";

  const status = await readBookingReservationStatus(
    tx,
    tenantId,
    link.reservationId
  );
  if (status === null || !DEAD.has(status)) return "reservation_live";
  if (!(await orderHoldsSettledMoney(tx, tenantId, orderId))) {
    return "reservation_live";
  }
  const raised = await flag(
    tx,
    tenantId,
    link,
    "deposit_after_expiry",
    "commerce.booking_late_payment_flagger",
    correlationId
  );
  return raised ? "attention_raised" : "attention_already_open";
}
