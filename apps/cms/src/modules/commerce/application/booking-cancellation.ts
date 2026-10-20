/**
 * Cancelling a booking reservation: the refund quote, the refund decision and
 * the refund legs (Issue #381, ADR-0045 D4/D6/D8/D9/G5/G6; contracts section
 * 3.5; threat controls C-10, C-11, C-32, C-37, C-40).
 *
 * ## The server decides the money
 *
 * The refund is NEVER a field of a request. The quote is computed from four
 * server facts - the amount paid that can still be given back (the payment
 * ledger), the ORIGINAL arrival of the booking (the root of a reschedule chain,
 * read from Booking through the port), the instant of the decision (the server
 * clock) and the cancellation policy version in force WHEN THE BOOKING WAS MADE
 * (`booking-cancellation-policies.ts`). A guest or customer acknowledges the
 * figure they were shown (`QUOTE_CHANGED` when it moved); only a staff cancel
 * carrying a pre-authorised {@link AuthorizedOverride} may differ from it, and
 * never above the amount paid (`REFUND_EXCEEDS_PAID`).
 *
 * ## One transaction, refusals as values (ADR-0045 G2)
 *
 * Every refusal is decided BEFORE the first write and returned as a value; the
 * route maps it to its HTTP code afterwards, so a `4xx` never rides out of the
 * transaction with a half-written decision. Order of work:
 *
 *   1. the client key (namespaced by the acting party) is locked and a replay
 *      answers the stored decision (a different request is a conflict);
 *   2. the ORDER row is locked (the lock order every ledger writer uses,
 *      ADR-0025 D4), the link is re-read under it, so two cancels of one
 *      reservation queue and the second finds it already decided;
 *   3. the quote, the acknowledgement, the override cap and the refund plan are
 *      checked - all reads;
 *   4. Booking is asked to cancel (a refusal writes nothing); a reservation that
 *      is already `expired` or `cancelled` (money held behind a dead reservation)
 *      skips this step, for staff only;
 *   5. the writes: the link goes `released`, the decision row, then - for a
 *      positive refund - the return (kind `cancellation`), its one line, its
 *      pending refund legs, and the decision's one-time `return_id`; an unpaid
 *      order is cancelled; audit rows and the event.
 *
 * ## The legs are planned, never settled here
 *
 * The legs run through the existing refund tables (ADR-0033) as `pending`, under
 * the tenant's service-account user (G3) - never a customer's or a cashier's
 * permission. Settling a leg - the provider call, cash handed back, an offline
 * attestation (`commerce.refunds_offline.approve`, control C-11) - stays with the
 * existing execute and offline routes. The legs are bounded three times: by the
 * plan (`planRefundLegs` over what each payment can still give back), by the
 * `refunds` cap trigger, and by the decision's `final_refund <= amount_paid`
 * CHECK.
 *
 * ## What happens to the order
 *
 * A paid order is NOT edited or cancelled: the retained part stays as settled
 * revenue and the return nets the refund in the sales projections (PRD 4.2 step
 * 6). An order that holds no money and is still `pending_payment` is cancelled
 * (it never became a sale). Booking's `lateCancellation` is ignored (G6).
 */
import { computeRequestHash } from "../../_shared/idempotency";
import type {
  BookingGetResult,
  BookingPort
} from "../../_shared/ports/booking-port";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  actorNamespace,
  type BookingRequestActor
} from "../domain/booking-hold-to-order";
import {
  basisPointsToPercent,
  computeCancellationRefund,
  decisionSourceKey,
  triggerKindFor,
  type CancelRefusal
} from "../domain/booking-cancellation";
import type { RefundPolicySource } from "../domain/booking-adapter";
import {
  COMMERCE_BOOKING_REFUND_DECIDED_EVENT_TYPE,
  COMMERCE_EVENT_VERSION,
  COMMERCE_ORDER_AGGREGATE_TYPE
} from "../domain/commerce-events";
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
import { recordCancellationReturn } from "./booking-cancellation-refund";
import {
  resolvePolicyForLink,
  rulesOf,
  type ResolvedPolicy
} from "./booking-cancellation-policies";
import type { ReservationLinkSummary } from "./booking-reservation-links";
import { cancelUnpaidOrderForBooking } from "./order-directory";
import { lockOrderForSettlement } from "./payment-allocation-directory";
import { loadRefundablePayments } from "./return-directory";
import { fetchReturn, type ReturnRecord } from "./return-records";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_booking_reservation_link";
const PRODUCER_MODULE = "commerce";

/** Reservation states a cancellation still has something to cancel in. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["held", "confirmed"]);
/** States where the reservation is already dead but money may be held behind it (STAFF may settle that, never a guest). */
const DEAD_STATUSES: ReadonlySet<string> = new Set(["expired", "cancelled"]);

// ---------------------------------------------------------------------------
// The quote
// ---------------------------------------------------------------------------

export type CancellationQuote = {
  linkId: string;
  orderId: string;
  reservationId: string;
  /** Booking's status of the reservation now. */
  reservationStatus: string;
  quotedAt: string;
  /** The ORIGINAL arrival (the root of a reschedule chain). */
  startsAt: string;
  /** Whole hours, floored; negative after arrival. */
  hoursBeforeStart: number;
  policySource: RefundPolicySource;
  policyId: string | null;
  policyVersion: number | null;
  refundBasis: "whole_stay" | "per_night";
  /** `numeric(5,2)` text: the share the window(s) allowed (effective share for per-night). */
  refundablePercent: string;
  /** Paid and not yet refunded or promised: the ceiling of any refund. */
  amountPaid: string;
  computedRefund: string;
};

export type QuoteInternals = {
  quote: CancellationQuote;
  amountPaidCents: bigint;
  computedCents: bigint;
  policy: ResolvedPolicy;
  /** The product the booking was sold as (for the audit row). */
  productId: string;
};

export type QuoteOutcome =
  { ok: true; value: QuoteInternals } | { ok: false; refusal: CancelRefusal };

/** The chain of reschedules ends at the ORIGINAL link; a booking that was never moved is its own root. */
async function findRootLink(
  tx: Bun.SQL,
  tenantId: string,
  linkId: string
): Promise<{ id: string; reservationId: string; productId: string } | null> {
  const rows = (await tx`
    WITH RECURSIVE chain AS (
      SELECT id, supersedes_link_id, reservation_id, offering_link_id, 0 AS depth
      FROM awcms_commerce_booking_reservation_links
      WHERE tenant_id = ${tenantId} AND id = ${linkId}
      UNION ALL
      SELECT l.id, l.supersedes_link_id, l.reservation_id, l.offering_link_id, c.depth + 1
      FROM awcms_commerce_booking_reservation_links l
      JOIN chain c ON l.id = c.supersedes_link_id
      WHERE l.tenant_id = ${tenantId} AND c.depth < 50
    )
    SELECT c.id, c.reservation_id, o.product_id
    FROM chain c
    JOIN awcms_commerce_booking_offering_links o
      ON o.tenant_id = ${tenantId} AND o.id = c.offering_link_id
    ORDER BY c.depth DESC
    LIMIT 1
  `) as { id: string; reservation_id: string; product_id: string }[];
  const row = rows[0];
  return row
    ? {
        id: row.id,
        reservationId: row.reservation_id,
        productId: row.product_id
      }
    : null;
}

/**
 * Computes the refund quote of an ACTIVE reservation link. Reads only. A
 * decision already recorded for the link, a link that is not active, or a
 * reservation Booking has already moved on (`checked_in`, `completed`,
 * `no_show`, `rescheduled`) is `INVALID_STATE`. `staff` additionally admits an
 * already `expired` or `cancelled` reservation - money held behind a dead
 * reservation is a staff settlement (the attention queue).
 */
export async function computeCancellationQuote(
  tx: Bun.SQL,
  tenantId: string,
  link: Pick<
    ReservationLinkSummary,
    "id" | "orderId" | "reservationId" | "status"
  >,
  port: BookingPort,
  options: { now: Date; staff: boolean }
): Promise<QuoteOutcome> {
  if (link.status !== "active") {
    return {
      ok: false,
      refusal: { code: "INVALID_STATE", reason: link.status }
    };
  }
  const decided = (await tx`
    SELECT 1 AS present FROM awcms_commerce_booking_refund_decisions
    WHERE tenant_id = ${tenantId} AND reservation_link_id = ${link.id}
  `) as unknown[];
  if (decided.length > 0) {
    return {
      ok: false,
      refusal: { code: "INVALID_STATE", reason: "already_decided" }
    };
  }

  const current: BookingGetResult = await port.get(tx, {
    tenantId,
    reservationId: link.reservationId
  });
  if (!current.ok) {
    return { ok: false, refusal: { code: "RESERVATION_NOT_FOUND" } };
  }
  const status = current.reservation.status;
  if (
    !LIVE_STATUSES.has(status) &&
    !(options.staff && DEAD_STATUSES.has(status))
  ) {
    return { ok: false, refusal: { code: "INVALID_STATE", reason: status } };
  }

  const root = await findRootLink(tx, tenantId, link.id);
  if (!root) return { ok: false, refusal: { code: "RESERVATION_NOT_FOUND" } };
  let originalStartsAt = current.reservation.startsAt;
  if (root.reservationId !== link.reservationId) {
    const original = await port.get(tx, {
      tenantId,
      reservationId: root.reservationId
    });
    if (!original.ok) {
      return { ok: false, refusal: { code: "RESERVATION_NOT_FOUND" } };
    }
    originalStartsAt = original.reservation.startsAt;
  }
  const startsAtMs = Date.parse(originalStartsAt);
  const nights = Math.max(
    1,
    current.reservation.stays.reduce((sum, stay) => sum + stay.nights, 0)
  );

  const policy = await resolvePolicyForLink(
    tx,
    tenantId,
    root.id,
    root.productId
  );
  const payments = await loadRefundablePayments(tx, tenantId, link.orderId);
  const amountPaidCents = payments.reduce(
    (sum, payment) => sum + refundableOf(payment),
    0n
  );
  const figures = computeCancellationRefund({
    amountPaidCents,
    startsAtMs,
    nowMs: options.now.getTime(),
    rules: policy.policy ? rulesOf(policy.policy) : null,
    nights
  });

  return {
    ok: true,
    value: {
      quote: {
        linkId: link.id,
        orderId: link.orderId,
        reservationId: link.reservationId,
        reservationStatus: status,
        quotedAt: options.now.toISOString(),
        startsAt: new Date(startsAtMs).toISOString(),
        hoursBeforeStart: figures.hoursBeforeStart,
        policySource: policy.source,
        policyId: policy.policy?.id ?? null,
        policyVersion: policy.policy?.version ?? null,
        refundBasis: policy.policy?.refundBasis ?? "whole_stay",
        refundablePercent: basisPointsToPercent(figures.refundableBp),
        amountPaid: fromCents(amountPaidCents),
        computedRefund: fromCents(figures.computedCents)
      },
      amountPaidCents,
      computedCents: figures.computedCents,
      policy,
      productId: root.productId
    }
  };
}

// ---------------------------------------------------------------------------
// The decision (read model)
// ---------------------------------------------------------------------------

export type DecisionView = {
  id: string;
  orderId: string;
  reservationLinkId: string;
  triggerKind: "customer_cancel" | "staff_cancel" | "no_show";
  actorKind: "customer" | "staff" | "system";
  policySource: RefundPolicySource;
  policyId: string | null;
  policyVersion: number | null;
  hoursBeforeStart: number;
  refundablePercent: string;
  amountPaid: string;
  computedRefund: string;
  finalRefund: string;
  overridden: boolean;
  returnId: string | null;
  createdAt: string;
};

type DecisionRow = {
  id: string;
  order_id: string;
  reservation_link_id: string;
  trigger_kind: DecisionView["triggerKind"];
  actor_kind: DecisionView["actorKind"];
  policy_source: RefundPolicySource;
  policy_id: string | null;
  policy_version: number | null;
  hours_before_start: number;
  refundable_percent: string | number;
  amount_paid: string;
  computed_refund: string;
  final_refund: string;
  override_reason: string | null;
  return_id: string | null;
  request_hash: string | null;
  created_at: Date | string;
};

const DECISION_SELECT = `d.id, d.order_id, d.reservation_link_id, d.trigger_kind,
  d.actor_kind, d.policy_source, d.policy_id, p.version AS policy_version,
  d.hours_before_start, d.refundable_percent, d.amount_paid, d.computed_refund,
  d.final_refund, d.override_reason, d.return_id, d.request_hash, d.created_at`;

function toDecisionView(row: DecisionRow): DecisionView {
  return {
    id: row.id,
    orderId: row.order_id,
    reservationLinkId: row.reservation_link_id,
    triggerKind: row.trigger_kind,
    actorKind: row.actor_kind,
    policySource: row.policy_source,
    policyId: row.policy_id,
    policyVersion:
      row.policy_version === null ? null : Number(row.policy_version),
    hoursBeforeStart: Number(row.hours_before_start),
    refundablePercent: basisPointsToPercent(
      Math.round(Number(row.refundable_percent) * 100)
    ),
    amountPaid: normalizeMoney(String(row.amount_paid)),
    computedRefund: normalizeMoney(String(row.computed_refund)),
    finalRefund: normalizeMoney(String(row.final_refund)),
    overridden: row.override_reason !== null,
    returnId: row.return_id,
    createdAt: new Date(row.created_at).toISOString()
  };
}

/** The decision of a reservation link, or `null`. Tenant-scoped; an unknown and a foreign id are the same `null`. */
export async function fetchDecisionForLink(
  tx: Bun.SQL,
  tenantId: string,
  linkId: string
): Promise<DecisionView | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(DECISION_SELECT)}
    FROM awcms_commerce_booking_refund_decisions d
    LEFT JOIN awcms_commerce_cancellation_policies p
      ON p.tenant_id = d.tenant_id AND p.id = d.policy_id
    WHERE d.tenant_id = ${tenantId} AND d.reservation_link_id = ${linkId}
  `) as DecisionRow[];
  return rows[0] ? toDecisionView(rows[0]) : null;
}

/** The decision of Booking's reservation `reservationId` (any of its links), or `null`. */
export async function fetchDecisionForReservation(
  tx: Bun.SQL,
  tenantId: string,
  reservationId: string
): Promise<DecisionView | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(DECISION_SELECT)}
    FROM awcms_commerce_booking_refund_decisions d
    JOIN awcms_commerce_booking_reservation_links l
      ON l.tenant_id = d.tenant_id AND l.id = d.reservation_link_id
    LEFT JOIN awcms_commerce_cancellation_policies p
      ON p.tenant_id = d.tenant_id AND p.id = d.policy_id
    WHERE d.tenant_id = ${tenantId} AND l.reservation_id = ${reservationId}
    ORDER BY d.created_at DESC
    LIMIT 1
  `) as DecisionRow[];
  return rows[0] ? toDecisionView(rows[0]) : null;
}

/** The return carrying a decision's refund legs, with the legs and their states. */
export async function fetchDecisionReturn(
  tx: Bun.SQL,
  tenantId: string,
  decision: Pick<DecisionView, "returnId">
): Promise<ReturnRecord | null> {
  return decision.returnId === null
    ? null
    : fetchReturn(tx, tenantId, decision.returnId);
}

// ---------------------------------------------------------------------------
// The cancel
// ---------------------------------------------------------------------------

/**
 * An override whose permission AND fresh step-up were already checked by
 * `authorizeRefundOverride` (`booking-refund-override.ts`). The service honours
 * only this type: a raw `{ finalRefund, reason }` cannot reach it.
 */
export type AuthorizedOverride = {
  readonly authorizedBy: "refund_override_permission_and_step_up";
  finalRefund: string;
  reason: string;
  actorTenantUserId: string;
  /** When the session's step-up proof was accepted; stored as `override_stepup_at`. */
  stepUpAt: Date;
};

export type CancelContext = {
  tenantId: string;
  actor: BookingRequestActor;
  correlationId: string;
  port: BookingPort;
  now?: Date;
};

export type CancelInput = {
  /** Resolved and OWNERSHIP-CHECKED by the route (the customer id / phone is never an input). */
  link: ReservationLinkSummary;
  idempotencyKey: string;
  reasonCode: string;
  /** The figure a guest or customer saw; required for them, absent for staff. */
  acknowledgedRefund: string | null;
  override: AuthorizedOverride | null;
};

export type CancelResult =
  | { kind: "cancelled" | "replayed"; decision: DecisionView }
  | { kind: "refused"; refusal: CancelRefusal };

/**
 * `bc1:<keyed hash of the acting party>:<keyed hash of the key>` - 87 characters
 * whatever the client sent. Unlike the reservation link's key (`bk1:<actor>:...`),
 * the party is HASHED too: a decision names a customer nowhere (X7), and a
 * `cust:<customer id>` tag inside a text column would be a customer reference by
 * the back door.
 */
export function buildCancelClientKey(
  actor: BookingRequestActor,
  idempotencyKey: string
): string {
  const party = computeRequestHash({ party: actorNamespace(actor) }).slice(
    0,
    40
  );
  const digest = computeRequestHash({ key: idempotencyKey }).slice(0, 40);
  return `bc1:${party}:${digest}`;
}

async function lockClientKey(
  tx: Bun.SQL,
  tenantId: string,
  clientKey: string
): Promise<void> {
  // Two concurrent calls with one key queue here, so the second one finds the
  // first one's committed decision and replays it instead of colliding on the
  // unique index.
  await tx`
    SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:booking-cancel:${clientKey}`}, 0))
  `;
}

export async function cancelBookingReservation(
  tx: Bun.TransactionSQL,
  ctx: CancelContext,
  input: CancelInput
): Promise<CancelResult> {
  const { tenantId, actor } = ctx;
  const link = input.link;
  const now = ctx.now ?? new Date();
  const staffId = actor.kind === "staff" ? actor.tenantUserId : null;
  const staff = staffId !== null;
  const refuse = (refusal: CancelRefusal): CancelResult => ({
    kind: "refused",
    refusal
  });

  const clientKey = buildCancelClientKey(actor, input.idempotencyKey);
  const requestHash = computeRequestHash({
    scope: "commerce.booking_reservations.cancel",
    actor: actorNamespace(actor),
    linkId: link.id,
    reasonCode: input.reasonCode,
    acknowledgedRefund: input.acknowledgedRefund,
    override: input.override
      ? {
          finalRefund: input.override.finalRefund,
          reason: input.override.reason
        }
      : null
  });

  await lockClientKey(tx, tenantId, clientKey);

  // -- Replay (G5) -----------------------------------------------------------
  const prior = (await tx`
    SELECT ${tx.unsafe(DECISION_SELECT)}
    FROM awcms_commerce_booking_refund_decisions d
    LEFT JOIN awcms_commerce_cancellation_policies p
      ON p.tenant_id = d.tenant_id AND p.id = d.policy_id
    WHERE d.tenant_id = ${tenantId} AND d.client_key = ${clientKey}
  `) as DecisionRow[];
  if (prior[0]) {
    if (prior[0].request_hash !== requestHash) {
      return refuse({ code: "IDEMPOTENCY_CONFLICT" });
    }
    return { kind: "replayed", decision: toDecisionView(prior[0]) };
  }

  // -- Who Booking sees (G3) --------------------------------------------------
  const serviceActor = await fetchBookingServiceActor(tx, tenantId);
  const bookingActor = staffId ?? serviceActor;
  if (!bookingActor) return refuse({ code: "SERVICE_ACTOR_NOT_CONFIGURED" });

  // -- The order lock, then the link under it ---------------------------------
  const header = await lockOrderForSettlement(tx, tenantId, link.orderId);
  if (!header) return refuse({ code: "RESERVATION_NOT_FOUND" });
  const fresh = (await tx`
    SELECT id, order_id, order_item_id, reservation_id, status
    FROM awcms_commerce_booking_reservation_links
    WHERE tenant_id = ${tenantId} AND id = ${link.id}
  `) as {
    id: string;
    order_id: string;
    order_item_id: string;
    reservation_id: string;
    status: ReservationLinkSummary["status"];
  }[];
  if (!fresh[0]) return refuse({ code: "RESERVATION_NOT_FOUND" });

  // -- The quote ----------------------------------------------------------------
  const quoted = await computeCancellationQuote(
    tx,
    tenantId,
    {
      id: fresh[0].id,
      orderId: fresh[0].order_id,
      reservationId: fresh[0].reservation_id,
      status: fresh[0].status
    },
    ctx.port,
    { now, staff }
  );
  if (!quoted.ok) return refuse(quoted.refusal);
  const { quote, amountPaidCents, computedCents, policy } = quoted.value;

  // A guest or customer cancels against the figure they saw (C-10): compared,
  // never stored as the refund.
  if (!staff && input.acknowledgedRefund !== quote.computedRefund) {
    return refuse({
      code: "QUOTE_CHANGED",
      computedRefund: quote.computedRefund
    });
  }

  // -- The override and its cap (Q10, C-40) ------------------------------------
  let finalCents = computedCents;
  if (input.override) {
    if (!staff) throw new Error("An override is staff-only.");
    const requested = toCents(input.override.finalRefund);
    if (requested > amountPaidCents) {
      return refuse({
        code: "REFUND_EXCEEDS_PAID",
        amountPaid: quote.amountPaid
      });
    }
    if (requested === computedCents) {
      return refuse({
        code: "OVERRIDE_NOT_A_CHANGE",
        computedRefund: quote.computedRefund
      });
    }
    finalCents = requested;
  }

  // -- The refund plan (reads) ---------------------------------------------------
  let legs: PlannedRefundLeg[] = [];
  if (finalCents > 0n) {
    if (!serviceActor) return refuse({ code: "SERVICE_ACTOR_NOT_CONFIGURED" });
    const payments = await loadRefundablePayments(tx, tenantId, link.orderId);
    const plan = planRefundLegs(payments, finalCents);
    if (!plan.ok) {
      return refuse({
        code: "REFUND_EXCEEDS_PAID",
        amountPaid: quote.amountPaid
      });
    }
    legs = plan.legs;
  }

  // -- Booking cancels (a refusal writes nothing) --------------------------------
  if (LIVE_STATUSES.has(quote.reservationStatus)) {
    const cancelled = await ctx.port.cancel(tx, {
      tenantId,
      reservationId: quote.reservationId,
      // Derived from the LINK, never from client input (G5).
      idempotencyKey: `commerce-booking-cancel:${quote.linkId}`,
      correlationId: ctx.correlationId,
      actorTenantUserId: bookingActor,
      reasonCode: input.reasonCode
    });
    if (!cancelled.ok)
      return refuse({ code: "BOOKING", reason: cancelled.reason });
  }

  // =========================== WRITES ========================================
  // The link leaves `active` in THIS transaction, so the cancelled-event
  // canceller finds no active link and does not flag our own cancel.
  await tx`
    UPDATE awcms_commerce_booking_reservation_links
    SET status = 'released', updated_at = now(),
        attention_resolved_at = CASE
          WHEN attention_reason IS NOT NULL AND attention_resolved_at IS NULL
            THEN now() ELSE attention_resolved_at END
    WHERE tenant_id = ${tenantId} AND id = ${link.id} AND status = 'active'
  `;

  const overridden = input.override !== null;
  const decisionRows = (await tx`
    INSERT INTO awcms_commerce_booking_refund_decisions (
      tenant_id, order_id, reservation_link_id, trigger_kind, actor_kind,
      actor_tenant_user_id, policy_id, policy_source, hours_before_start,
      refundable_percent, amount_paid, computed_refund, final_refund,
      override_reason, override_actor_tenant_user_id, override_stepup_at,
      source_key, client_key, request_hash
    )
    VALUES (
      ${tenantId}, ${link.orderId}, ${link.id},
      ${triggerKindFor(staff ? "staff" : "customer")},
      ${staff ? "staff" : "customer"},
      ${staffId},
      ${quote.policyId}, ${quote.policySource}, ${quote.hoursBeforeStart},
      ${quote.refundablePercent}, ${fromCents(amountPaidCents)},
      ${fromCents(computedCents)}, ${fromCents(finalCents)},
      ${input.override?.reason ?? null},
      ${input.override?.actorTenantUserId ?? null},
      ${input.override?.stepUpAt ?? null},
      ${decisionSourceKey(quote.reservationId)}, ${clientKey}, ${requestHash}
    )
    RETURNING id
  `) as { id: string }[];
  const decisionId = decisionRows[0]!.id;

  let returnId: string | null = null;
  if (legs.length > 0) {
    returnId = await recordCancellationReturn(tx, tenantId, {
      orderId: link.orderId,
      orderItemId: fresh[0].order_item_id,
      orderStatus: header.status,
      sourceKey: decisionSourceKey(quote.reservationId),
      finalCents,
      legs,
      actorTenantUserId: serviceActor!,
      correlationId: ctx.correlationId
    });
    await tx`
      UPDATE awcms_commerce_booking_refund_decisions
      SET return_id = ${returnId}
      WHERE tenant_id = ${tenantId} AND id = ${decisionId}
    `;
  }

  // An order that never held money and is still unpaid never became a sale.
  let orderCancelled = false;
  if (amountPaidCents === 0n && header.status === "pending_payment") {
    orderCancelled =
      (await cancelUnpaidOrderForBooking(
        tx,
        tenantId,
        link.orderId,
        ctx.correlationId
      )) === "cancelled";
  }

  // -- Audit + event ----------------------------------------------------------------
  const initiatedBy = staff ? "staff" : "customer";
  const auditActor = staffId ?? undefined;
  const base = {
    tenantId,
    actorTenantUserId: auditActor,
    moduleKey: AUDIT_MODULE_KEY,
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: link.id,
    correlationId: ctx.correlationId
  } as const;
  await recordAuditEvent(tx, {
    ...base,
    action: "commerce.booking_reservation.cancelled",
    message: `Booking reservation cancelled by ${initiatedBy}.`,
    attributes: {
      orderId: link.orderId,
      reservationId: quote.reservationId,
      decisionId,
      // X7: a customer is never named; the system acts, `initiatedBy` says for whom.
      actorKind: staff ? "staff" : "system",
      initiatedBy,
      reasonCode: input.reasonCode,
      orderCancelled
    }
  });
  await recordAuditEvent(tx, {
    ...base,
    action: "commerce.booking_refund_decision.recorded",
    message: "Booking refund decision recorded.",
    attributes: {
      decisionId,
      orderId: link.orderId,
      policySource: quote.policySource,
      policyId: quote.policyId,
      policyVersion: quote.policyVersion,
      hoursBeforeStart: quote.hoursBeforeStart,
      amountPaid: fromCents(amountPaidCents),
      computedRefund: fromCents(computedCents),
      finalRefund: fromCents(finalCents),
      returnId
    }
  });
  if (input.override) {
    await recordAuditEvent(tx, {
      ...base,
      actorTenantUserId: input.override.actorTenantUserId,
      action: "commerce.booking_refund_decision.overridden",
      severity: "critical",
      message:
        "Booking refund overridden by a manager or finance holder after a fresh step-up.",
      // The staff-authored reason lives in the decision row (a redacted
      // column); the tamper-evident log carries who, which decision and the
      // two figures.
      attributes: {
        decisionId,
        orderId: link.orderId,
        computedRefund: fromCents(computedCents),
        finalRefund: fromCents(finalCents),
        amountPaid: fromCents(amountPaidCents),
        stepUpAt: input.override.stepUpAt.toISOString(),
        reasonLength: input.override.reason.length
      }
    });
  }
  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_BOOKING_REFUND_DECIDED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_ORDER_AGGREGATE_TYPE,
    aggregateId: link.orderId,
    producerModule: PRODUCER_MODULE,
    correlationId: ctx.correlationId,
    actorTenantUserId: auditActor,
    payload: {
      decisionId,
      orderId: link.orderId,
      reservationId: quote.reservationId,
      triggerKind: triggerKindFor(staff ? "staff" : "customer"),
      policySource: policy.source,
      amountPaid: fromCents(amountPaidCents),
      computedRefund: fromCents(computedCents),
      finalRefund: fromCents(finalCents),
      overridden
    }
  });

  const decision = await fetchDecisionForLink(tx, tenantId, link.id);
  if (!decision) throw new Error("A recorded decision could not be read back.");
  return { kind: "cancelled", decision };
}
