/**
 * Domain-event consumers of the booking-commerce adapter (ADR-0045 D15),
 * declared once here and spread into `module.ts`'s `domainEventConsumers`. Later
 * adapter issues (#381 and on) append their descriptors HERE, never to
 * `module.ts`.
 *
 * Issue #380 declares five:
 *
 *   - `commerce.booking_order_paid_confirmer` - `awcms.commerce.order.paid` ->
 *     confirm the held reservation (the release threshold was reached).
 *   - `commerce.booking_expired_order_canceller` -
 *     `awcms.booking.reservation.expired` -> expire the unpaid order; an order
 *     holding money is flagged, never cancelled (C-08).
 *   - `commerce.booking_cancelled_order_canceller` -
 *     `awcms.booking.reservation.cancelled` -> cancel the unpaid order; one
 *     holding money is flagged `cancelled_externally_paid`.
 *   - `commerce.booking_order_cancelled_hold_releaser` (G11) -
 *     `awcms.commerce.order.cancelled` / `.expired` -> release the hold of an
 *     unpaid booking order closed through the generic path.
 *   - `commerce.booking_late_payment_flagger` - `awcms.commerce.payment.recorded`
 *     -> raise `deposit_after_expiry` when money lands on an order whose
 *     reservation is already dead (an addition to the six frozen names of D15:
 *     adding one is additive, ADR-0134; it covers the gateway callback that
 *     arrives after the order was closed, which no other event announces).
 *
 * Issue #382 adds two of the three remaining D15 names:
 *
 *   - `commerce.booking_rescheduled_link_reconciler` -
 *     `awcms.booking.reservation.rescheduled` -> when a person rescheduled in
 *     Booking's own screen, restore the order's two references (the old link is
 *     superseded, a link for the replacement points at the same order) and flag
 *     it `rescheduled_externally`. A reschedule made through the adapter already
 *     moved its link, so the handler finds nothing to do (C-38).
 *   - `commerce.booking_no_show_decision_recorder` -
 *     `awcms.booking.reservation.no_show` -> record the retention decision of a
 *     no-show a person marked in Booking, as the system, under the original
 *     policy version; it creates no refund leg (C-41).
 *
 * The last D15 name (`booking_cancelled_refund_coordinator`) stays reserved: a
 * cancel through the adapter plans its legs itself, in its own transaction
 * (D8, D9), so no event-driven coordinator is needed.
 *
 * A consumer's name is permanent (it keys delivery rows and the effect ledger;
 * `domain-events:consumers:check` rejects a rename), keeps the default
 * `runtime_effect_once` idempotency, loads its implementation with a lazy
 * `import()` and never calls `applyConsumerEffectOnce` itself. The names are in
 * `apps/cms/tests/domain-event-consumer-declarations.test.ts`.
 */
import type { ModuleDomainEventConsumer } from "../../_shared/domain-event-consumer-contract";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_ORDER_CANCELLED_EVENT_TYPE,
  COMMERCE_ORDER_EXPIRED_EVENT_TYPE,
  COMMERCE_ORDER_PAID_EVENT_TYPE,
  COMMERCE_PAYMENT_RECORDED_EVENT_TYPE
} from "../domain/commerce-events";

/** Booking's published reservation events (`booking/domain/booking-reservation-events.ts`); string literals because `commerce` imports nothing from `booking`. */
export const BOOKING_RESERVATION_EXPIRED_EVENT_TYPE =
  "awcms.booking.reservation.expired";
export const BOOKING_RESERVATION_CANCELLED_EVENT_TYPE =
  "awcms.booking.reservation.cancelled";
export const BOOKING_RESERVATION_RESCHEDULED_EVENT_TYPE =
  "awcms.booking.reservation.rescheduled";
export const BOOKING_RESERVATION_NO_SHOW_EVENT_TYPE =
  "awcms.booking.reservation.no_show";
const BOOKING_EVENT_VERSION = "1.0";

export const COMMERCE_BOOKING_ORDER_PAID_CONFIRMER_CONSUMER_NAME =
  "commerce.booking_order_paid_confirmer";
export const COMMERCE_BOOKING_EXPIRED_ORDER_CANCELLER_CONSUMER_NAME =
  "commerce.booking_expired_order_canceller";
export const COMMERCE_BOOKING_CANCELLED_ORDER_CANCELLER_CONSUMER_NAME =
  "commerce.booking_cancelled_order_canceller";
export const COMMERCE_BOOKING_ORDER_CANCELLED_HOLD_RELEASER_CONSUMER_NAME =
  "commerce.booking_order_cancelled_hold_releaser";
export const COMMERCE_BOOKING_LATE_PAYMENT_FLAGGER_CONSUMER_NAME =
  "commerce.booking_late_payment_flagger";
export const COMMERCE_BOOKING_RESCHEDULED_LINK_RECONCILER_CONSUMER_NAME =
  "commerce.booking_rescheduled_link_reconciler";
export const COMMERCE_BOOKING_NO_SHOW_DECISION_RECORDER_CONSUMER_NAME =
  "commerce.booking_no_show_decision_recorder";

export const BOOKING_ADAPTER_CONSUMERS: ModuleDomainEventConsumer[] = [
  {
    name: COMMERCE_BOOKING_ORDER_PAID_CONFIRMER_CONSUMER_NAME,
    description:
      "commerce module consumer - confirms the held Booking reservation of an order the moment it reaches its release threshold (the deposit of a down-payment order, the total of a whole-total one). A hold that already lapsed raises the deposit_after_expiry attention flag instead; the order is never auto-cancelled (Issue #380, ADR-0045 D15, C-08).",
    eventTypes: [COMMERCE_ORDER_PAID_EVENT_TYPE],
    eventVersions: [COMMERCE_EVENT_VERSION],
    handle: async (tx, event, ctx) => {
      const { confirmReservationForPaidOrder } =
        await import("./booking-order-consumers");
      await confirmReservationForPaidOrder(
        tx,
        ctx.tenantId,
        event.aggregateId,
        ctx.correlationId
      );
    }
  },
  {
    name: COMMERCE_BOOKING_EXPIRED_ORDER_CANCELLER_CONSUMER_NAME,
    description:
      "commerce module consumer - expires the unpaid order of a Booking reservation whose hold lapsed. An order that holds settled money is never cancelled by the event: the deposit_after_expiry attention flag is raised instead (Issue #380, ADR-0045 D15, C-08). The order is found through the reservation link, never from the event payload.",
    eventTypes: [BOOKING_RESERVATION_EXPIRED_EVENT_TYPE],
    eventVersions: [BOOKING_EVENT_VERSION],
    handle: async (tx, event, ctx) => {
      const { closeOrderForEndedReservation } =
        await import("./booking-order-consumers");
      await closeOrderForEndedReservation(
        tx as Bun.TransactionSQL,
        ctx.tenantId,
        event.aggregateId,
        "expired",
        ctx.correlationId
      );
    }
  },
  {
    name: COMMERCE_BOOKING_CANCELLED_ORDER_CANCELLER_CONSUMER_NAME,
    description:
      "commerce module consumer - cancels the unpaid order of a Booking reservation that was cancelled in Booking. An order that holds settled money is never cancelled by the event: the cancelled_externally_paid attention flag is raised instead; Booking's lateCancellation fact is ignored (G6) (Issue #380, ADR-0045 D15).",
    eventTypes: [BOOKING_RESERVATION_CANCELLED_EVENT_TYPE],
    eventVersions: [BOOKING_EVENT_VERSION],
    handle: async (tx, event, ctx) => {
      const { closeOrderForEndedReservation } =
        await import("./booking-order-consumers");
      await closeOrderForEndedReservation(
        tx as Bun.TransactionSQL,
        ctx.tenantId,
        event.aggregateId,
        "cancelled",
        ctx.correlationId
      );
    }
  },
  {
    name: COMMERCE_BOOKING_ORDER_CANCELLED_HOLD_RELEASER_CONSUMER_NAME,
    description:
      "commerce module consumer - releases the Booking hold of an unpaid booking order that was cancelled or expired through the generic order path, so the capacity is free at once instead of at the hold's expiry (Issue #380, ADR-0045 G11).",
    eventTypes: [
      COMMERCE_ORDER_CANCELLED_EVENT_TYPE,
      COMMERCE_ORDER_EXPIRED_EVENT_TYPE
    ],
    eventVersions: [COMMERCE_EVENT_VERSION],
    handle: async (tx, event, ctx) => {
      const { releaseHoldForClosedOrder } =
        await import("./booking-order-consumers");
      await releaseHoldForClosedOrder(
        tx,
        ctx.tenantId,
        event.aggregateId,
        ctx.correlationId
      );
    }
  },
  {
    name: COMMERCE_BOOKING_LATE_PAYMENT_FLAGGER_CONSUMER_NAME,
    description:
      "commerce module consumer - raises the deposit_after_expiry attention flag when a payment lands on a booking order whose reservation already expired or was cancelled, e.g. a gateway callback after the order closed. Records the fact for an operator; moves no money and cancels nothing (Issue #380, ADR-0045 G7, C-08).",
    eventTypes: [COMMERCE_PAYMENT_RECORDED_EVENT_TYPE],
    eventVersions: [COMMERCE_EVENT_VERSION],
    handle: async (tx, event, ctx) => {
      const { flagPaymentOnDeadReservation } =
        await import("./booking-order-consumers");
      await flagPaymentOnDeadReservation(
        tx,
        ctx.tenantId,
        event.aggregateId,
        ctx.correlationId
      );
    }
  },
  {
    name: COMMERCE_BOOKING_RESCHEDULED_LINK_RECONCILER_CONSUMER_NAME,
    description:
      "commerce module consumer - when a person reschedules a reservation in Booking's own screen, restores the order's two references: the old reservation link is superseded and a link for the replacement points at the same order and line, flagged rescheduled_externally for an operator. A reschedule made through the adapter has already moved its link, so this finds nothing to do. The order is found through the reservation link, never from the event payload (Issue #382, ADR-0045 D15, C-38).",
    eventTypes: [BOOKING_RESERVATION_RESCHEDULED_EVENT_TYPE],
    eventVersions: [BOOKING_EVENT_VERSION],
    handle: async (tx, event, ctx) => {
      const { reconcileRescheduledReservation } =
        await import("./booking-reschedule-consumers");
      const superseded = event.payload.supersededById;
      await reconcileRescheduledReservation(
        tx as Bun.TransactionSQL,
        ctx.tenantId,
        event.aggregateId,
        typeof superseded === "string" ? superseded : null,
        ctx.correlationId
      );
    }
  },
  {
    name: COMMERCE_BOOKING_NO_SHOW_DECISION_RECORDER_CONSUMER_NAME,
    description:
      "commerce module consumer - records the retention decision of a no-show a person marked in Booking's own screen, as the system, under the policy version in force when the booking was made. It retains by the policy and creates no refund leg; a no-show marked through the adapter has already released its link, so this finds nothing to do (Issue #382, ADR-0045 D15, C-41).",
    eventTypes: [BOOKING_RESERVATION_NO_SHOW_EVENT_TYPE],
    eventVersions: [BOOKING_EVENT_VERSION],
    handle: async (tx, event, ctx) => {
      const { recordNoShowForReservation } =
        await import("./booking-reschedule-consumers");
      await recordNoShowForReservation(
        tx as Bun.TransactionSQL,
        ctx.tenantId,
        event.aggregateId,
        ctx.correlationId
      );
    }
  }
];
