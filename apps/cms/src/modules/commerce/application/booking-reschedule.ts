/**
 * Rescheduling a booking reservation: the order reference moves in one guarded
 * transaction and the price difference is carried by the existing order and
 * refund paths (Issue #382, ADR-0045 D7 as amended for #382, G2, G5; contracts
 * section 3.7; threat controls C-37, C-38, C-39).
 *
 * ## What moves, and what never does
 *
 * The order is NOT moved: it stays the order of the booking. What moves is the
 * REFERENCE between the order line and the Booking reservation. The old
 * reservation link becomes `superseded` and a new link for the replacement
 * points at the SAME order and order line (`supersedes_link_id` set), while
 * Booking carries its own `externalRef` to the replacement inside the port's
 * reschedule. Both references change in this one transaction and the new one is
 * verified before it commits, so the order is left with two references or - if
 * anything fails - with the original two, never with one (C-38; the C-09
 * reconciliation lists the drift of a path outside the adapter).
 *
 * No order, no order line and no payment allocation is ever edited: a reschedule
 * adds rows (a link, a reschedule record, and a supplementary order or a
 * return), it changes none of the finalised ones (ADR-0025, ADR-0033).
 *
 * ## The server prices the difference (C-39)
 *
 * Price is the product's price times the nights, so the difference exists only
 * when the stay changes LENGTH (`domain/booking-reschedule.ts`):
 *
 *   - same length: only the reference moves;
 *   - more nights: a supplementary ORDER, created by the ordinary order path
 *     (the cart quote prices it, so tax and the tenant's price rules are the
 *     ordinary ones), owned by the same customer and paid by the ordinary
 *     payment paths - the balance the customer or staff then pays. It carries no
 *     link: it is an ordinary order that the booking panel shows;
 *   - fewer nights: the value of the removed nights (a cumulative share of the
 *     order total) judged by the cancellation policy of the ORIGINAL booking from
 *     the ORIGINAL start, capped at what each payment can still give back, is
 *     planned as pending legs of a return of kind `cancellation` by the existing
 *     refund planner. Only a fully paid order can be reduced.
 *
 * ## The window is the original's (C-37)
 *
 * The policy version and the start the reduction is judged by are the root of
 * the reschedule chain's (`readOriginalBooking`, shared with the cancel), so a
 * chain of reschedules can neither extend a window nor change the version.
 *
 * ## One transaction, refusals as values (ADR-0045 G2)
 *
 * Order of work: the client key (namespaced by the acting party) is locked and a
 * replay answers the stored record; the ORDER row is locked (the lock every
 * ledger writer and the cancel take, so a concurrent reschedule and cancel of one
 * booking queue and the second finds the first's result); the link is re-read
 * under it; every refusal that can be decided by READING is returned before the
 * first write; then the writes run inside one savepoint, so a refusal that only
 * Booking can give (the new slot is taken) rolls back to the untouched original
 * on both sides and is still returned as a value.
 */
import { computeRequestHash } from "../../_shared/idempotency";
import type {
  BookingPort,
  BookingReservationRecord
} from "../../_shared/ports/booking-port";
import type { MediaLibraryPort } from "../../_shared/ports/media-library-port";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  actorNamespace,
  type BookingRequestActor,
  type HoldRefusal
} from "../domain/booking-hold-to-order";
import {
  computeCancellationRefund,
  basisPointsToPercent
} from "../domain/booking-cancellation";
import {
  differenceDirection,
  nightsValueCents,
  reductionRoom,
  requestedNights,
  rescheduleRequestFingerprint,
  type DifferenceDirection,
  type RescheduleRefusal,
  type RescheduleRequest
} from "../domain/booking-reschedule";
import {
  BOOKING_RESERVATION_ORDER_REFERENCE_TYPE,
  type RefundPolicySource
} from "../domain/booking-adapter";
import {
  COMMERCE_BOOKING_RESERVATION_RESCHEDULED_EVENT_TYPE,
  COMMERCE_EVENT_VERSION,
  COMMERCE_ORDER_AGGREGATE_TYPE
} from "../domain/commerce-events";
import type { CreateOrderInput } from "../domain/order-request-validation";
import {
  fromCents,
  normalizeMoney,
  toCents
} from "../domain/price-calculation";
import {
  planRefundLegs,
  refundableOf,
  type PlannedRefundLeg
} from "../domain/returns";
import { fetchBookingServiceActor } from "./booking-adapter-settings";
import {
  findRootLink,
  nightsOf,
  readOriginalBooking
} from "./booking-cancellation";
import { recordCancellationReturn } from "./booking-cancellation-refund";
import {
  resolvePolicyForLink,
  rulesOf,
  type ResolvedPolicy
} from "./booking-cancellation-policies";
import {
  buildReservationView,
  derivedUuid,
  type BookingReservationView
} from "./booking-hold-to-order";
import type { ReservationLinkSummary } from "./booking-reservation-links";
import { buildCartQuote } from "./cart-quote-service";
import { fetchCustomerById } from "./customer-directory";
import { createBookingOrderFromCart } from "./order-directory";
import { lockOrderForSettlement } from "./payment-allocation-directory";
import { loadRefundablePayments } from "./return-directory";
import { fetchStoreSettings } from "./store-settings-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_booking_reservation_link";
const PRODUCER_MODULE = "commerce";
const EXTERNAL_REF_TYPE = BOOKING_RESERVATION_ORDER_REFERENCE_TYPE;

/** The payment methods a supplementary order may name, in the order they are tried: never `dp` (the deposit rule is off, full payment is due). */
const SUPPLEMENT_PAYMENT_METHODS = [
  "manual_bank",
  "manual_qris",
  "gateway"
] as const;

// ---------------------------------------------------------------------------
// The quote (reads only)
// ---------------------------------------------------------------------------

/** How the difference is carried: a new order, a refund return, or not at all. */
export type DifferenceVehicle = "supplementary_order" | "refund_return" | null;

export type RescheduleQuote = {
  linkId: string;
  orderId: string;
  reservationId: string;
  currentNights: number;
  newNights: number;
  direction: DifferenceDirection;
  vehicle: DifferenceVehicle;
  /**
   * `numeric(14,2)` text. A charge: the supplementary order's total. A refund:
   * the value of the removed nights. None: `0.00`.
   */
  pricedAmount: string;
  /** What the policy gives back (a refund only, else `0.00`); never above `pricedAmount` or what was paid. */
  refundAmount: string;
  /** A refund only: the original booking's policy and the notice it was judged by. */
  policySource: RefundPolicySource | null;
  policyId: string | null;
  policyVersion: number | null;
  hoursBeforeStart: number | null;
  refundablePercent: string | null;
  /**
   * Booking's own answer for the asked dates on the asked resource, ONLY when the
   * request names a `resourceId`; otherwise `null` (the port does not reveal
   * which resource a reservation holds, and the reschedule itself decides). A
   * hint, never a promise: the reservation's own current nights count as taken,
   * so overlapping dates can read as unavailable although the move would succeed.
   */
  availability: { available: boolean; freeUnits: number } | null;
};

type QuoteInternals = {
  quote: RescheduleQuote;
  current: BookingReservationRecord;
  primary: PrimaryFacts;
  pricedCents: bigint;
  refundCents: bigint;
  legs: PlannedRefundLeg[];
  policy: ResolvedPolicy | null;
  removedNights: number;
};

export type QuoteOutcome =
  | { ok: true; value: QuoteInternals }
  | { ok: false; refusal: RescheduleRefusal };

type PrimaryFacts = {
  orderId: string;
  orderCode: string;
  orderStatus: string;
  totalCents: bigint;
  customerId: string;
  paymentMethod: string;
  orderItemId: string;
  itemQuantity: number;
  productId: string;
  offeringId: string;
  quantityBasis: "nights" | "booking";
};

async function loadPrimary(
  tx: Bun.SQL,
  tenantId: string,
  link: Pick<
    ReservationLinkSummary,
    "orderId" | "orderItemId" | "offeringLinkId"
  >
): Promise<PrimaryFacts | null> {
  const rows = (await tx`
    SELECT o.id, o.order_code, o.status, o.total, o.customer_id, o.payment_method,
           i.id AS item_id, i.quantity, g.product_id, g.offering_id, g.quantity_basis
    FROM awcms_commerce_orders o
    JOIN awcms_commerce_order_items i
      ON i.tenant_id = o.tenant_id AND i.order_id = o.id AND i.id = ${link.orderItemId}
    JOIN awcms_commerce_booking_offering_links g
      ON g.tenant_id = o.tenant_id AND g.id = ${link.offeringLinkId}
    WHERE o.tenant_id = ${tenantId} AND o.id = ${link.orderId}
      AND o.deleted_at IS NULL
  `) as {
    id: string;
    order_code: string;
    status: string;
    total: string;
    customer_id: string;
    payment_method: string;
    item_id: string;
    quantity: number;
    product_id: string;
    offering_id: string;
    quantity_basis: "nights" | "booking";
  }[];
  const row = rows[0];
  if (!row) return null;
  return {
    orderId: row.id,
    orderCode: row.order_code,
    orderStatus: row.status,
    totalCents: toCents(normalizeMoney(String(row.total))),
    customerId: row.customer_id,
    paymentMethod: row.payment_method,
    orderItemId: row.item_id,
    itemQuantity: Number(row.quantity),
    productId: row.product_id,
    offeringId: row.offering_id,
    quantityBasis: row.quantity_basis
  };
}

/** Σ succeeded payments of the order, in cents: what was EVER paid (reversals and promised refunds are not subtracted - "fully paid" is a question about the past). */
async function grossPaidCents(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<bigint> {
  const rows = (await tx`
    SELECT COALESCE(SUM(amount), 0) AS paid
    FROM awcms_commerce_payment_allocations
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
      AND kind = 'payment' AND status = 'succeeded'
  `) as { paid: string }[];
  return toCents(normalizeMoney(String(rows[0]?.paid ?? "0")));
}

/** Nights already taken off the order by earlier reductions of its bookings (forfeited or refunded alike). */
async function nightsRemovedFromOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<number> {
  const rows = (await tx`
    SELECT COALESCE(SUM(from_nights - to_nights), 0)::int AS removed
    FROM awcms_commerce_booking_reschedules
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
      AND difference_direction = 'refund'
  `) as { removed: number }[];
  return Number(rows[0]?.removed ?? 0);
}

/** The cart quote of `nights` extra nights of the linked product, at the customer's own price level - the commerce price path. */
async function quoteSupplement(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  productId: string,
  nights: number,
  customerId: string,
  now: Date
) {
  const customer = await fetchCustomerById(tx, tenantId, customerId);
  const level =
    customer && customer.level >= 1 && customer.level <= 4
      ? (customer.level as 1 | 2 | 3 | 4)
      : null;
  return buildCartQuote(
    tx,
    tenantId,
    mediaPort,
    {
      lines: [
        {
          productId,
          variantId: null,
          quantity: nights,
          serviceFormValues: null
        }
      ],
      shipping: null,
      voucherCode: null,
      insurance: false,
      customerLevel: level,
      bookingSale: true
    },
    now
  );
}

/**
 * Booking's availability for the asked dates on the asked resource (Issue #382).
 * Anonymous by Booking's design (it reveals nothing of the tenant's policy), so
 * a refusal is just "not available". A slot is judged against the offering's
 * duration.
 */
async function availabilityHint(
  tx: Bun.SQL,
  tenantId: string,
  port: BookingPort,
  offeringId: string,
  request: Pick<RescheduleRequest, "startsAt" | "stay" | "resourceId">
): Promise<RescheduleQuote["availability"]> {
  if (request.resourceId === null) return null;
  if (request.stay) {
    const result = await port.availability(tx, {
      tenantId,
      offeringId,
      resourceId: request.resourceId,
      stay: request.stay
    });
    if (!result.ok || result.mode !== "stay") {
      return { available: false, freeUnits: 0 };
    }
    return { available: result.available, freeUnits: result.freeUnits };
  }
  if (request.startsAt === null) return null;
  const offering = await port.getOffering(tx, { tenantId, offeringId });
  if (!offering.ok || offering.offering.durationSeconds === null) return null;
  const startMs = Date.parse(request.startsAt);
  const result = await port.availability(tx, {
    tenantId,
    offeringId,
    resourceId: request.resourceId,
    from: new Date(startMs).toISOString(),
    to: new Date(
      startMs + offering.offering.durationSeconds * 1000
    ).toISOString(),
    limit: 500
  });
  if (!result.ok || result.mode !== "slot") {
    return { available: false, freeUnits: 0 };
  }
  const slot = result.slots.find((s) => Date.parse(s.startsAt) === startMs);
  return slot
    ? { available: slot.freeUnits > 0, freeUnits: slot.freeUnits }
    : { available: false, freeUnits: 0 };
}

function sameWhen(
  current: BookingReservationRecord,
  request: Pick<RescheduleRequest, "startsAt" | "stay">
): boolean {
  if (request.stay) {
    const stay = current.stays[0];
    return (
      current.stays.length === 1 &&
      stay !== undefined &&
      stay.checkInDate === request.stay.checkInDate &&
      stay.checkOutDate === request.stay.checkOutDate
    );
  }
  return (
    request.startsAt !== null &&
    Date.parse(request.startsAt) === Date.parse(current.startsAt)
  );
}

/**
 * Prices a reschedule without writing anything. Called by the quote route, by
 * the panel, and by the reschedule itself UNDER the order lock - so the figure
 * a staff member saw and the figure the write uses come from one function.
 */
export async function computeRescheduleQuote(
  tx: Bun.SQL,
  tenantId: string,
  link: Pick<
    ReservationLinkSummary,
    | "id"
    | "orderId"
    | "orderItemId"
    | "offeringLinkId"
    | "reservationId"
    | "status"
  >,
  port: BookingPort,
  mediaPort: MediaLibraryPort,
  request: Pick<RescheduleRequest, "startsAt" | "stay" | "resourceId">,
  now: Date
): Promise<QuoteOutcome> {
  const refuse = (refusal: RescheduleRefusal): QuoteOutcome => ({
    ok: false,
    refusal
  });
  if (link.status !== "active") {
    return refuse({ code: "INVALID_STATE", reason: link.status });
  }

  const got = await port.get(tx, {
    tenantId,
    reservationId: link.reservationId
  });
  if (!got.ok) return refuse({ code: "RESERVATION_NOT_FOUND" });
  const current = got.reservation;
  // Booking moves a CONFIRMED reservation only; a hold is not paid for yet.
  if (current.status !== "confirmed") {
    return refuse({ code: "INVALID_STATE", reason: current.status });
  }

  const primary = await loadPrimary(tx, tenantId, link);
  if (!primary) return refuse({ code: "RESERVATION_NOT_FOUND" });

  // The guard on the OLD reference (C-38): Booking's reservation must name this
  // very order, or an operator has to reconcile it before anything moves.
  if (
    current.externalRef?.type !== EXTERNAL_REF_TYPE ||
    current.externalRef.id !== primary.orderId
  ) {
    return refuse({ code: "REFERENCE_MISMATCH" });
  }

  const wantsStay = request.stay !== null;
  if ((primary.quantityBasis === "nights") !== wantsStay) {
    return refuse({ code: "QUANTITY_BASIS_MISMATCH" });
  }
  if (request.resourceId === null && sameWhen(current, request)) {
    return refuse({ code: "NOT_A_CHANGE" });
  }

  const currentNights = nightsOf(current);
  const newNights = requestedNights(request);
  if (newNights === null) return refuse({ code: "QUANTITY_BASIS_MISMATCH" });
  const direction = differenceDirection(currentNights, newNights);

  const base = {
    linkId: link.id,
    orderId: primary.orderId,
    reservationId: link.reservationId,
    currentNights,
    newNights,
    direction,
    availability: await availabilityHint(
      tx,
      tenantId,
      port,
      primary.offeringId,
      request
    )
  };
  const none = (): QuoteOutcome => ({
    ok: true,
    value: {
      quote: {
        ...base,
        vehicle: null,
        pricedAmount: "0.00",
        refundAmount: "0.00",
        policySource: null,
        policyId: null,
        policyVersion: null,
        hoursBeforeStart: null,
        refundablePercent: null
      },
      current,
      primary,
      pricedCents: 0n,
      refundCents: 0n,
      legs: [],
      policy: null,
      removedNights: 0
    }
  });
  if (direction === "none") return none();

  // -- MORE nights: a supplementary order, priced by the cart quote ------------
  if (direction === "charge") {
    const priced = await quoteSupplement(
      tx,
      tenantId,
      mediaPort,
      primary.productId,
      newNights - currentNights,
      primary.customerId,
      now
    );
    const totalCents = toCents(priced.total);
    if (!priced.canCheckout || totalCents <= 0n) {
      return refuse({ code: "SUPPLEMENT_UNAVAILABLE" });
    }
    return {
      ok: true,
      value: {
        quote: {
          ...base,
          vehicle: "supplementary_order",
          pricedAmount: fromCents(totalCents),
          refundAmount: "0.00",
          policySource: null,
          policyId: null,
          policyVersion: null,
          hoursBeforeStart: null,
          refundablePercent: null
        },
        current,
        primary,
        pricedCents: totalCents,
        refundCents: 0n,
        legs: [],
        policy: null,
        removedNights: 0
      }
    };
  }

  // -- FEWER nights: the removed nights' value, judged by the ORIGINAL policy ---
  const removing = currentNights - newNights;
  const paidGross = await grossPaidCents(tx, tenantId, primary.orderId);
  if (paidGross < primary.totalCents) {
    return refuse({
      code: "BALANCE_OUTSTANDING",
      outstanding: fromCents(primary.totalCents - paidGross)
    });
  }
  const alreadyRemoved = await nightsRemovedFromOrder(
    tx,
    tenantId,
    primary.orderId
  );
  const room = reductionRoom(primary.itemQuantity, alreadyRemoved);
  if (removing > room) {
    return refuse({ code: "REDUCTION_NOT_SUPPORTED", roomNights: room });
  }
  const valueCents = nightsValueCents(
    primary.totalCents,
    primary.itemQuantity,
    alreadyRemoved,
    removing
  );

  const original = await readOriginalBooking(tx, tenantId, port, link, current);
  if (!original) return refuse({ code: "RESERVATION_NOT_FOUND" });
  const policy = await resolvePolicyForLink(
    tx,
    tenantId,
    original.root.id,
    original.root.productId
  );
  const figures = computeCancellationRefund({
    amountPaidCents: valueCents,
    startsAtMs: original.startsAtMs,
    nowMs: now.getTime(),
    rules: policy.policy ? rulesOf(policy.policy) : null,
    nights: removing,
    firstNightOffset: newNights
  });

  const payments = await loadRefundablePayments(tx, tenantId, primary.orderId);
  const refundable = payments.reduce(
    (sum, payment) => sum + refundableOf(payment),
    0n
  );
  const refundCents =
    figures.computedCents > refundable ? refundable : figures.computedCents;
  let legs: PlannedRefundLeg[] = [];
  if (refundCents > 0n) {
    const plan = planRefundLegs(payments, refundCents);
    // Unreachable (the refund was capped at what is refundable); a defect, not a refusal.
    if (!plan.ok)
      throw new Error("A capped reschedule refund could not be planned.");
    legs = plan.legs;
  }

  return {
    ok: true,
    value: {
      quote: {
        ...base,
        vehicle: refundCents > 0n ? "refund_return" : null,
        pricedAmount: fromCents(valueCents),
        refundAmount: fromCents(refundCents),
        policySource: policy.source,
        policyId: policy.policy?.id ?? null,
        policyVersion: policy.policy?.version ?? null,
        hoursBeforeStart: figures.hoursBeforeStart,
        refundablePercent: basisPointsToPercent(figures.refundableBp)
      },
      current,
      primary,
      pricedCents: valueCents,
      refundCents,
      legs,
      policy,
      removedNights: removing
    }
  };
}

// ---------------------------------------------------------------------------
// The record (read model)
// ---------------------------------------------------------------------------

export type RescheduleRecord = {
  id: string;
  orderId: string;
  fromLinkId: string;
  toLinkId: string;
  fromNights: number;
  toNights: number;
  direction: DifferenceDirection;
  pricedAmount: string;
  refundAmount: string;
  supplementOrderId: string | null;
  returnId: string | null;
  policySource: RefundPolicySource | null;
  policyId: string | null;
  policyVersion: number | null;
  hoursBeforeStart: number | null;
  refundablePercent: string | null;
  createdAt: string;
};

type RecordRow = {
  id: string;
  order_id: string;
  from_link_id: string;
  to_link_id: string;
  from_nights: number;
  to_nights: number;
  difference_direction: DifferenceDirection;
  priced_amount: string;
  refund_amount: string;
  supplement_order_id: string | null;
  return_id: string | null;
  policy_source: RefundPolicySource | null;
  policy_id: string | null;
  policy_version: number | null;
  hours_before_start: number | null;
  refundable_percent: string | number | null;
  request_hash?: string;
  created_at: Date | string;
};

const RECORD_SELECT = `r.id, r.order_id, r.from_link_id, r.to_link_id,
  r.from_nights, r.to_nights, r.difference_direction, r.priced_amount,
  r.refund_amount, r.supplement_order_id, r.return_id, r.policy_source,
  r.policy_id, p.version AS policy_version, r.hours_before_start,
  r.refundable_percent, r.request_hash, r.created_at`;

function toRecord(row: RecordRow): RescheduleRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    fromLinkId: row.from_link_id,
    toLinkId: row.to_link_id,
    fromNights: Number(row.from_nights),
    toNights: Number(row.to_nights),
    direction: row.difference_direction,
    pricedAmount: normalizeMoney(String(row.priced_amount)),
    refundAmount: normalizeMoney(String(row.refund_amount)),
    supplementOrderId: row.supplement_order_id,
    returnId: row.return_id,
    policySource: row.policy_source,
    policyId: row.policy_id,
    policyVersion:
      row.policy_version === null ? null : Number(row.policy_version),
    hoursBeforeStart:
      row.hours_before_start === null ? null : Number(row.hours_before_start),
    refundablePercent:
      row.refundable_percent === null
        ? null
        : basisPointsToPercent(
            Math.round(Number(row.refundable_percent) * 100)
          ),
    createdAt: new Date(row.created_at).toISOString()
  };
}

/** The reschedules of one order, oldest first (the panel's history). */
export async function listReschedulesForOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<RescheduleRecord[]> {
  const rows = (await tx`
    SELECT ${tx.unsafe(RECORD_SELECT)}
    FROM awcms_commerce_booking_reschedules r
    LEFT JOIN awcms_commerce_cancellation_policies p
      ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
    WHERE r.tenant_id = ${tenantId} AND r.order_id = ${orderId}
    ORDER BY r.created_at, r.id
    LIMIT 100
  `) as RecordRow[];
  return rows.map(toRecord);
}

export type SupplementOrderSummary = {
  orderId: string;
  orderCode: string;
  status: string;
  total: string;
  paymentStatus: string;
};

export async function fetchSupplementOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<SupplementOrderSummary | null> {
  const rows = (await tx`
    SELECT id, order_code, status, total, payment_status
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${orderId} AND deleted_at IS NULL
  `) as {
    id: string;
    order_code: string;
    status: string;
    total: string;
    payment_status: string;
  }[];
  const row = rows[0];
  return row
    ? {
        orderId: row.id,
        orderCode: row.order_code,
        status: row.status,
        total: normalizeMoney(String(row.total)),
        paymentStatus: row.payment_status
      }
    : null;
}

// ---------------------------------------------------------------------------
// The reschedule
// ---------------------------------------------------------------------------

export type RescheduleView = {
  record: RescheduleRecord;
  /** The replacement reservation as the booking views carry it, on the same order. */
  reservation: BookingReservationView;
  supersededReservationId: string;
  supplementOrder: SupplementOrderSummary | null;
};

export type RescheduleResult =
  | { kind: "rescheduled" | "replayed"; view: RescheduleView }
  | { kind: "refused"; refusal: RescheduleRefusal };

export type RescheduleContext = {
  tenantId: string;
  /** Staff only: a customer has no reschedule route (ADR-0045 D18, access matrix). */
  actor: Extract<BookingRequestActor, { kind: "staff" }>;
  correlationId: string;
  port: BookingPort;
  mediaPort: MediaLibraryPort;
  /**
   * Whether the actor also holds `commerce.booking_refund_decisions.create`
   * (Issue #448), asked lazily. A shorter stay plans pending refund legs - the
   * refund authority of the access matrix - so a reschedule that would plan any
   * is refused `REFUND_PLANNING_FORBIDDEN` (before the first write) when this
   * answers false. REQUIRED, never defaulted: a caller must state it.
   */
  canPlanRefund: () => Promise<boolean>;
  now?: Date;
};

export type RescheduleInput = {
  /** Resolved by the route from the reservation id in the path. */
  link: ReservationLinkSummary;
  idempotencyKey: string;
  request: RescheduleRequest;
};

/**
 * `br1:<keyed hash of the acting party>:<keyed hash of the key>` - 87
 * characters whatever the client sent. The party is hashed too (a record names a
 * customer nowhere, X7, and a staff id inside a text column would still be a
 * stamp the record has its own column for).
 */
export function buildRescheduleClientKey(
  actor: BookingRequestActor,
  idempotencyKey: string
): string {
  const party = computeRequestHash({ party: actorNamespace(actor) }).slice(
    0,
    40
  );
  const digest = computeRequestHash({ key: idempotencyKey }).slice(0, 40);
  return `br1:${party}:${digest}`;
}

async function lockClientKey(
  tx: Bun.SQL,
  tenantId: string,
  clientKey: string
): Promise<void> {
  // Two concurrent calls with one key queue here, so the second one finds the
  // first one's committed record and replays it instead of colliding on the
  // unique index.
  await tx`
    SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:booking-reschedule:${clientKey}`}, 0))
  `;
}

/** A refusal only the writes can find (Booking's own, a supplement that cannot be sold): thrown INSIDE the savepoint so everything rolls back, then returned. */
class RescheduleAbort extends Error {
  constructor(readonly refusal: RescheduleRefusal) {
    super(`reschedule refused: ${refusal.code}`);
    this.name = "RescheduleAbort";
  }
}

async function readView(
  tx: Bun.SQL,
  tenantId: string,
  record: RescheduleRecord
): Promise<RescheduleView> {
  const rows = (await tx`
    SELECT l.id, l.order_id, l.reservation_id, l.status,
           f.reservation_id AS from_reservation_id
    FROM awcms_commerce_booking_reservation_links l
    JOIN awcms_commerce_booking_reservation_links f
      ON f.tenant_id = l.tenant_id AND f.id = ${record.fromLinkId}
    WHERE l.tenant_id = ${tenantId} AND l.id = ${record.toLinkId}
  `) as {
    id: string;
    order_id: string;
    reservation_id: string;
    status: string;
    from_reservation_id: string;
  }[];
  const row = rows[0];
  if (!row) throw new Error("A reschedule record lost its reservation link.");
  const reservation = await buildReservationView(tx, tenantId, {
    id: row.id,
    orderId: row.order_id,
    reservationId: row.reservation_id,
    status: row.status
  });
  if (!reservation) {
    throw new Error("A reschedule record lost its order or reservation.");
  }
  return {
    record,
    reservation,
    supersededReservationId: row.from_reservation_id,
    supplementOrder: record.supplementOrderId
      ? await fetchSupplementOrder(tx, tenantId, record.supplementOrderId)
      : null
  };
}

type Written = {
  recordId: string;
  newLinkId: string;
  replacementReservationId: string;
  supplement: SupplementOrderSummary | null;
  returnId: string | null;
  toNights: number;
};

export async function rescheduleBookingReservation(
  tx: Bun.TransactionSQL,
  ctx: RescheduleContext,
  input: RescheduleInput
): Promise<RescheduleResult> {
  const { tenantId, actor } = ctx;
  const link = input.link;
  const request = input.request;
  const now = ctx.now ?? new Date();
  const refuse = (refusal: RescheduleRefusal): RescheduleResult => ({
    kind: "refused",
    refusal
  });

  const clientKey = buildRescheduleClientKey(actor, input.idempotencyKey);
  const requestHash = computeRequestHash(
    rescheduleRequestFingerprint(actorNamespace(actor), link.id, request)
  );

  await lockClientKey(tx, tenantId, clientKey);

  // -- Replay (G5) -----------------------------------------------------------
  const prior = (await tx`
    SELECT ${tx.unsafe(RECORD_SELECT)}
    FROM awcms_commerce_booking_reschedules r
    LEFT JOIN awcms_commerce_cancellation_policies p
      ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
    WHERE r.tenant_id = ${tenantId} AND r.client_key = ${clientKey}
  `) as RecordRow[];
  if (prior[0]) {
    if (prior[0].request_hash !== requestHash) {
      return refuse({ code: "IDEMPOTENCY_CONFLICT" });
    }
    return {
      kind: "replayed",
      view: await readView(tx, tenantId, toRecord(prior[0]))
    };
  }

  // -- The order lock, then the link under it (the cancel's lock order) ------------
  const header = await lockOrderForSettlement(tx, tenantId, link.orderId);
  if (!header) return refuse({ code: "RESERVATION_NOT_FOUND" });
  const fresh = (await tx`
    SELECT id, order_id, order_item_id, reservation_id, offering_link_id, status
    FROM awcms_commerce_booking_reservation_links
    WHERE tenant_id = ${tenantId} AND id = ${link.id}
  `) as {
    id: string;
    order_id: string;
    order_item_id: string;
    reservation_id: string;
    offering_link_id: string;
    status: ReservationLinkSummary["status"];
  }[];
  const current = fresh[0];
  if (!current) return refuse({ code: "RESERVATION_NOT_FOUND" });
  const freshLink = {
    id: current.id,
    orderId: current.order_id,
    orderItemId: current.order_item_id,
    reservationId: current.reservation_id,
    offeringLinkId: current.offering_link_id,
    status: current.status
  };

  // -- Everything that can be decided by reading ------------------------------------
  const quoted = await computeRescheduleQuote(
    tx,
    tenantId,
    freshLink,
    ctx.port,
    ctx.mediaPort,
    request,
    now
  );
  if (!quoted.ok) return refuse(quoted.refusal);
  const figures = quoted.value;
  const quote = figures.quote;

  let serviceActor: string | null = null;
  if (figures.refundCents > 0n) {
    if (!(await ctx.canPlanRefund()))
      return refuse({ code: "REFUND_PLANNING_FORBIDDEN" });
    serviceActor = await fetchBookingServiceActor(tx, tenantId);
    if (!serviceActor) return refuse({ code: "SERVICE_ACTOR_NOT_CONFIGURED" });
  }

  const newLinkId = derivedUuid(
    `booking-reschedule-link:${tenantId}:${clientKey}`
  );
  const supplementOrderId = derivedUuid(
    `booking-supplement-order:${tenantId}:${clientKey}`
  );

  // =========================== WRITES ========================================
  // One savepoint: a refusal only Booking can give (the new slot is taken, ...)
  // or a supplement that cannot be sold rolls back the port's reschedule AND
  // every row below, and is returned as a value after the savepoint.
  let written: Written;
  try {
    written = await tx.savepoint(async (sp): Promise<Written> => {
      const moved = await ctx.port.reschedule(sp, {
        tenantId,
        reservationId: freshLink.reservationId,
        // Derived from the LINK, never from client input (G5).
        idempotencyKey: `commerce-booking-reschedule:${freshLink.id}`,
        correlationId: ctx.correlationId,
        actorTenantUserId: actor.tenantUserId,
        ...(request.stay
          ? { stay: request.stay }
          : { startsAt: request.startsAt! }),
        ...(request.resourceId ? { resourceId: request.resourceId } : {})
      });
      if (!moved.ok) {
        throw new RescheduleAbort({ code: "BOOKING", reason: moved.reason });
      }

      // The second reference (C-38): Booking carried the order reference to the
      // replacement. Verified before the link is moved, so a defect rolls back.
      const replacement = await ctx.port.get(sp, {
        tenantId,
        reservationId: moved.reservationId
      });
      if (
        !replacement.ok ||
        replacement.reservation.externalRef?.type !== EXTERNAL_REF_TYPE ||
        replacement.reservation.externalRef.id !== freshLink.orderId
      ) {
        throw new RescheduleAbort({ code: "REFERENCE_MISMATCH" });
      }
      const toNights = nightsOf(replacement.reservation);
      if (toNights !== quote.newNights) {
        // The price was computed for another stay length than Booking made.
        throw new Error(
          `Booking rescheduled to ${toNights} night(s), the quote priced ${quote.newNights}.`
        );
      }

      // -- Move the order reference ------------------------------------------------
      const superseded = (await sp`
        UPDATE awcms_commerce_booking_reservation_links
        SET status = 'superseded', updated_at = now(),
            attention_resolved_at = CASE
              WHEN attention_reason IS NOT NULL AND attention_resolved_at IS NULL
                THEN now() ELSE attention_resolved_at END
        WHERE tenant_id = ${tenantId} AND id = ${freshLink.id} AND status = 'active'
        RETURNING id
      `) as { id: string }[];
      if (superseded.length === 0) {
        throw new RescheduleAbort({
          code: "INVALID_STATE",
          reason: "superseded"
        });
      }
      await sp`
        INSERT INTO awcms_commerce_booking_reservation_links (
          id, tenant_id, order_id, order_item_id, reservation_id,
          offering_link_id, supersedes_link_id, client_key, request_hash
        )
        VALUES (
          ${newLinkId}, ${tenantId}, ${freshLink.orderId}, ${freshLink.orderItemId},
          ${moved.reservationId}, ${freshLink.offeringLinkId}, ${freshLink.id},
          ${clientKey}, ${requestHash}
        )
      `;

      // -- The price difference ------------------------------------------------------
      let supplement: SupplementOrderSummary | null = null;
      let returnId: string | null = null;
      if (quote.direction === "charge") {
        // A savepoint handle accepts everything a transaction handle does,
        // including a nested `.savepoint(...)` (the inventory ledger's cast).
        supplement = await createSupplementOrder(
          sp as Bun.TransactionSQL,
          ctx,
          {
            tenantId,
            orderId: supplementOrderId,
            productId: figures.primary.productId,
            customerId: figures.primary.customerId,
            preferredMethod: figures.primary.paymentMethod,
            nights: quote.newNights - quote.currentNights,
            expectedTotalCents: figures.pricedCents,
            now
          }
        );
      } else if (figures.legs.length > 0) {
        returnId = await recordCancellationReturn(sp, tenantId, {
          orderId: freshLink.orderId,
          orderItemId: freshLink.orderItemId,
          orderStatus: header.status,
          sourceKey: `booking-reschedule:${newLinkId}`,
          finalCents: figures.refundCents,
          legs: figures.legs,
          actorTenantUserId: serviceActor!,
          quantity: figures.removedNights,
          eventLabel: "Booking reschedule refund",
          correlationId: ctx.correlationId
        });
      }

      // -- The evidence ----------------------------------------------------------------
      const policy = figures.policy;
      const recordRows = (await sp`
        INSERT INTO awcms_commerce_booking_reschedules (
          tenant_id, order_id, from_link_id, to_link_id, from_nights, to_nights,
          difference_direction, priced_amount, refund_amount, supplement_order_id,
          return_id, policy_id, policy_source, hours_before_start,
          refundable_percent, actor_tenant_user_id, client_key, request_hash
        )
        VALUES (
          ${tenantId}, ${freshLink.orderId}, ${freshLink.id}, ${newLinkId},
          ${quote.currentNights}, ${toNights}, ${quote.direction},
          ${fromCents(figures.pricedCents)}, ${fromCents(figures.refundCents)},
          ${supplement?.orderId ?? null}, ${returnId},
          ${policy?.policy?.id ?? null}, ${quote.policySource},
          ${quote.hoursBeforeStart}, ${quote.refundablePercent},
          ${actor.tenantUserId}, ${clientKey}, ${requestHash}
        )
        RETURNING id
      `) as { id: string }[];

      await recordAuditEvent(sp, {
        tenantId,
        actorTenantUserId: actor.tenantUserId,
        moduleKey: AUDIT_MODULE_KEY,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: newLinkId,
        correlationId: ctx.correlationId,
        action: "commerce.booking_reservation.rescheduled",
        severity: "warning",
        message: "Booking reservation rescheduled by staff.",
        attributes: {
          orderId: freshLink.orderId,
          fromReservationId: freshLink.reservationId,
          toReservationId: moved.reservationId,
          fromLinkId: freshLink.id,
          toLinkId: newLinkId,
          rescheduleId: recordRows[0]!.id,
          fromNights: quote.currentNights,
          toNights,
          direction: quote.direction,
          pricedAmount: fromCents(figures.pricedCents),
          refundAmount: fromCents(figures.refundCents),
          supplementOrderId: supplement?.orderId ?? null,
          returnId,
          policySource: quote.policySource,
          policyId: policy?.policy?.id ?? null,
          policyVersion: quote.policyVersion,
          hoursBeforeStart: quote.hoursBeforeStart,
          reasonCode: request.reasonCode,
          actorKind: "staff"
        }
      });

      await appendDomainEvent(sp, tenantId, {
        eventType: COMMERCE_BOOKING_RESERVATION_RESCHEDULED_EVENT_TYPE,
        eventVersion: COMMERCE_EVENT_VERSION,
        aggregateType: COMMERCE_ORDER_AGGREGATE_TYPE,
        aggregateId: freshLink.orderId,
        producerModule: PRODUCER_MODULE,
        correlationId: ctx.correlationId,
        actorTenantUserId: actor.tenantUserId,
        payload: {
          rescheduleId: recordRows[0]!.id,
          orderId: freshLink.orderId,
          fromReservationId: freshLink.reservationId,
          toReservationId: moved.reservationId,
          fromNights: quote.currentNights,
          toNights,
          direction: quote.direction,
          pricedAmount: fromCents(figures.pricedCents),
          refundAmount: fromCents(figures.refundCents),
          supplementOrderId: supplement?.orderId ?? null,
          returnId
        }
      });

      return {
        recordId: recordRows[0]!.id,
        newLinkId,
        replacementReservationId: moved.reservationId,
        supplement,
        returnId,
        toNights
      };
    });
  } catch (error) {
    if (error instanceof RescheduleAbort) return refuse(error.refusal);
    throw error;
  }

  const record = (await tx`
    SELECT ${tx.unsafe(RECORD_SELECT)}
    FROM awcms_commerce_booking_reschedules r
    LEFT JOIN awcms_commerce_cancellation_policies p
      ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
    WHERE r.tenant_id = ${tenantId} AND r.id = ${written.recordId}
  `) as RecordRow[];
  return {
    kind: "rescheduled",
    view: await readView(tx, tenantId, toRecord(record[0]!))
  };
}

// ---------------------------------------------------------------------------
// The supplementary order
// ---------------------------------------------------------------------------

/**
 * Creates the supplementary order of a reschedule that added nights: an ordinary
 * order of the booking's customer for the extra nights of the linked product,
 * written by the ordinary order path (`createBookingOrderFromCart`: the cart
 * re-quote, tax, the customer, the audit row, `order.created`). It moves no
 * stock (capacity is Booking's), carries no link and no deposit - full payment
 * is due - and it expires like any unpaid order. Throws a
 * {@link RescheduleAbort} (rolling the whole reschedule back) when it cannot be
 * sold or when the price it came out at is not the one the staff member was
 * quoted a moment ago under the same lock.
 */
async function createSupplementOrder(
  sp: Bun.TransactionSQL,
  ctx: RescheduleContext,
  params: {
    tenantId: string;
    orderId: string;
    productId: string;
    customerId: string;
    preferredMethod: string;
    nights: number;
    expectedTotalCents: bigint;
    now: Date;
  }
): Promise<SupplementOrderSummary> {
  const customer = await fetchCustomerById(
    sp,
    params.tenantId,
    params.customerId
  );
  if (!customer) throw new RescheduleAbort({ code: "SUPPLEMENT_UNAVAILABLE" });

  const settings = await fetchStoreSettings(sp, params.tenantId);
  const expiresAt = new Date(
    params.now.getTime() + settings.orders.expiryHours * 60 * 60 * 1000
  );

  const preferred = (SUPPLEMENT_PAYMENT_METHODS as readonly string[]).includes(
    params.preferredMethod
  )
    ? [params.preferredMethod]
    : [];
  const methods = [
    ...preferred,
    ...SUPPLEMENT_PAYMENT_METHODS.filter(
      (method) => !preferred.includes(method)
    )
  ];

  for (const method of methods) {
    const input: CreateOrderInput = {
      // Unused by the booking path (the reschedule's client key is the idempotency).
      idempotencyKey: params.orderId,
      customer: {
        name: customer.name,
        phone: customer.phone,
        email: customer.email
      },
      address: null,
      lines: [
        {
          productId: params.productId,
          variantId: null,
          quantity: params.nights,
          serviceFormValues: null
        }
      ],
      shipping: null,
      payment: { method: method as CreateOrderInput["payment"]["method"] },
      voucherCode: null,
      insurance: false,
      notes: null,
      affiliateCode: null
    };
    let priceMoved = false;
    const outcome = await createBookingOrderFromCart(
      sp,
      params.tenantId,
      ctx.mediaPort,
      input,
      {
        orderId: params.orderId,
        hold: async (
          quote
        ): Promise<
          { ok: true; expiresAt: Date } | { ok: false; refusal: HoldRefusal }
        > => {
          // The figure quoted under the lock is the figure charged: the cart
          // re-quote inside the order writer must agree to the cent.
          if (toCents(quote.total) !== params.expectedTotalCents) {
            priceMoved = true;
            return { ok: false, refusal: { code: "CART_CHANGED" } };
          }
          return { ok: true, expiresAt };
        },
        // No link: the supplement is an ordinary order the booking panel shows.
        onItemsWritten: async () => {}
      },
      params.now,
      ctx.correlationId,
      params.customerId
    );
    if (outcome.kind === "created") {
      const summary = await fetchSupplementOrder(
        sp,
        params.tenantId,
        params.orderId
      );
      if (!summary)
        throw new Error("A created supplementary order is unreadable.");
      return summary;
    }
    // `cart_changed` is found before the first row: try the next method, unless
    // the PRICE moved (then nothing else will help).
    if (priceMoved) break;
    if (outcome.kind !== "cart_changed") break;
  }
  throw new RescheduleAbort({ code: "SUPPLEMENT_UNAVAILABLE" });
}

/** Re-exported so the routes and tests import the root finder from one place. */
export { findRootLink };
