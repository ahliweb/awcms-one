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
import { nightsOf } from "./booking-cancellation";
import { computeNoShowPreview, type NoShowPreview } from "./booking-no-show";
import {
  fetchSupplementOrder,
  listReschedulesForOrder,
  type RescheduleRecord,
  type SupplementOrderSummary
} from "./booking-reschedule";
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

/** One reschedule of the booking as the panel lists it (Issue #382). */
export type PanelReschedule = RescheduleRecord & {
  /** The supplementary order of a reschedule that added nights, with its payment state. */
  supplementOrder: SupplementOrderSummary | null;
};

export type BookingOrderPanel = {
  reservation: BookingReservationView;
  /** What Booking holds now (Issue #382): the nights, and the stay's dates for the reschedule dialog (`null` for a slot). */
  nights: number;
  stay: { checkInDate: string; checkOutDate: string } | null;
  reschedules: PanelReschedule[];
  /** What a no-show would retain, while the reservation is confirmed and its arrival has passed; `null` otherwise. */
  noShow: NoShowPreview | null;
  canReschedule: boolean;
  canNoShow: boolean;
  /** The server's clock, for the reschedule dialog's earliest date (never the browser's). */
  serverNow: string;
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
    /** `commerce.booking_reservation_links.update` (Issue #382). */
    canReschedule?: boolean;
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

  const port = await composedBookingPort();
  const held = await port.get(tx, {
    tenantId,
    reservationId: link.reservation_id
  });
  const current = held.ok ? held.reservation : null;
  const stay = current?.stays[0]
    ? {
        checkInDate: current.stays[0].checkInDate,
        checkOutDate: current.stays[0].checkOutDate
      }
    : null;
  const reschedules: PanelReschedule[] = [];
  for (const record of await listReschedulesForOrder(tx, tenantId, orderId)) {
    reschedules.push({
      ...record,
      supplementOrder: record.supplementOrderId
        ? await fetchSupplementOrder(tx, tenantId, record.supplementOrderId)
        : null
    });
  }

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

  // A no-show: the reservation is confirmed and its ORIGINAL arrival has passed
  // (Booking decides the grace on the server; the control is only offered).
  let noShow: NoShowPreview | null = null;
  const confirmed = link.status === "active" && current?.status === "confirmed";
  if (confirmed && recorded === null && caps.canCancel) {
    const previewed = await computeNoShowPreview(
      tx,
      tenantId,
      {
        id: link.id,
        orderId: link.order_id,
        reservationId: link.reservation_id,
        status: link.status
      },
      port,
      { now, expectStatus: "confirmed" }
    );
    if (previewed.ok && previewed.value.preview.hoursBeforeStart < 0) {
      noShow = previewed.value.preview;
    }
  }

  return {
    reservation,
    nights: current ? nightsOf(current) : 1,
    stay,
    reschedules,
    noShow,
    canReschedule:
      Boolean(caps.canReschedule) && confirmed && recorded === null,
    canNoShow: caps.canCancel && noShow !== null,
    serverNow: now.toISOString(),
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
