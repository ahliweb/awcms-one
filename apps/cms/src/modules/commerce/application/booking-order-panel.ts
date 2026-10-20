/**
 * The booking panel of the order detail screen (Issue #381, `docs/booking-ux-flows.md`
 * sections 4.3 and 11.5): what a staff member sees on the order of a booked
 * reservation and which cancellation controls to offer.
 *
 * Read-only, tenant-scoped and customer-free (finding X7): Booking's facts
 * through the link, the server-computed quote while the reservation can still be
 * cancelled (a read - nothing is written by rendering the page), the recorded
 * decision once it was, and the state of its refund legs. The controls are
 * decided by what the viewer may do; the routes decide again.
 */
import { composedBookingPort } from "../../../lib/composition/booking-port";
import {
  computeCancellationQuote,
  fetchDecisionForLink,
  fetchDecisionReturn,
  type CancellationQuote,
  type DecisionView
} from "./booking-cancellation";
import {
  buildReservationView,
  type BookingReservationView
} from "./booking-hold-to-order";
import type { ReservationLinkSummary } from "./booking-reservation-links";

export type BookingOrderPanel = {
  reservation: BookingReservationView;
  /** The quote, while the reservation can still be cancelled; `null` otherwise. */
  quote: CancellationQuote | null;
  /** Why there is no quote (`already_decided`, `released`, `completed`, ...), or `null`. */
  noQuoteReason: string | null;
  decision: DecisionView | null;
  legs: { id: string; tenderType: string; amount: string; status: string }[];
  canCancel: boolean;
  canOverride: boolean;
};

type LinkRow = {
  id: string;
  order_id: string;
  order_item_id: string;
  reservation_id: string;
  offering_link_id: string;
  status: ReservationLinkSummary["status"];
};

/**
 * The panel for `orderId`, or `null` when the order is not a booking (no link
 * ever named it). `caps` says what the viewer may do: cancelling needs BOTH the
 * cancel and the decision-create keys; the override needs its own.
 */
export async function loadBookingOrderPanel(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  caps: {
    canCancel: boolean;
    canOverride: boolean;
    /** `commerce.booking_refund_decisions.read`: without it the recorded figures stay hidden. */
    canReadDecision: boolean;
  },
  now: Date = new Date()
): Promise<BookingOrderPanel | null> {
  const rows = (await tx`
    SELECT id, order_id, order_item_id, reservation_id, offering_link_id, status
    FROM awcms_commerce_booking_reservation_links
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
    ORDER BY (status = 'active') DESC, created_at DESC, id DESC
    LIMIT 1
  `) as LinkRow[];
  const link = rows[0];
  if (!link) return null;

  const reservation = await buildReservationView(tx, tenantId, {
    id: link.id,
    orderId: link.order_id,
    reservationId: link.reservation_id,
    status: link.status
  });
  if (!reservation) return null;

  const recorded = await fetchDecisionForLink(tx, tenantId, link.id);
  const decision = caps.canReadDecision ? recorded : null;
  const carried = decision
    ? await fetchDecisionReturn(tx, tenantId, decision)
    : null;

  let quote: CancellationQuote | null = null;
  let noQuoteReason: string | null = null;
  if (recorded === null) {
    const outcome = await computeCancellationQuote(
      tx,
      tenantId,
      {
        id: link.id,
        orderId: link.order_id,
        reservationId: link.reservation_id,
        status: link.status
      },
      await composedBookingPort(),
      { now, staff: true }
    );
    if (outcome.ok) quote = outcome.value.quote;
    else
      noQuoteReason =
        outcome.refusal.code === "INVALID_STATE"
          ? outcome.refusal.reason
          : outcome.refusal.code;
  } else {
    noQuoteReason = "already_decided";
  }

  return {
    reservation,
    quote,
    noQuoteReason,
    decision,
    legs: (carried?.refunds ?? []).map((leg) => ({
      id: leg.id,
      tenderType: leg.tenderType,
      amount: leg.amount,
      status: leg.status
    })),
    canCancel: caps.canCancel && quote !== null,
    // Nothing paid means nothing to override (UX 11.5: the control is absent).
    canOverride:
      caps.canCancel &&
      caps.canOverride &&
      quote !== null &&
      quote.amountPaid !== "0.00"
  };
}
