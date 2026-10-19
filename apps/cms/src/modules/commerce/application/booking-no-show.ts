/**
 * Marking a booking reservation no-show: the retention the ORIGINAL policy
 * version prescribes, the audit record, and no refund (Issue #382, ADR-0045 D15,
 * contracts section 3.8; threat control C-41).
 *
 * ## Staff only, and money never leaves
 *
 * The route is staff-only (the same two keys as a cancel: the cancel key and the
 * decision key; a cashier holds neither, a customer has no route at all). The
 * only other caller is the `commerce.booking_no_show_decision_recorder` consumer,
 * which records the decision of a no-show a person marked in Booking's own
 * screen - as the SYSTEM, with the reservation already `no_show`.
 *
 * A no-show decision (`trigger_kind = 'no_show'`) records what the policy
 * RETAINS (`retained_amount`) and refunds nothing: the computed and final refund
 * are zero by a CHECK, and a trigger refuses to give the decision a return, so no
 * refund leg can exist for it (sql/1045). The paid order is not edited: the
 * retained money stays as settled revenue exactly as after a late cancel.
 *
 * ## What it retains
 *
 * The `no_show_retention` rule of the policy version in force WHEN THE BOOKING
 * WAS MADE - the root of a reschedule chain, resolved like a cancel's - applied
 * by `domain/booking-no-show.ts`. A booking made while no policy applied keeps
 * everything paid (the fail-closed D6 answer). The audit event records the
 * retained amount, the amount paid, the rule and the policy version.
 *
 * ## One transaction, refusals as values (ADR-0045 G2)
 *
 * Client key (namespaced by the acting party) locked and replayed; the ORDER row
 * locked (the lock a cancel and a reschedule take, so the three queue); the link
 * re-read under it; Booking asked to mark the no-show (a refusal -
 * `NO_SHOW_TOO_EARLY` before arrival plus the grace - writes nothing); then the
 * link goes `released`, the decision, the audit rows and the event are written.
 */
import { computeRequestHash } from "../../_shared/idempotency";
import type {
  BookingPort,
  BookingReservationRecord
} from "../../_shared/ports/booking-port";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  basisPointsToPercent,
  computeCancellationRefund,
  decisionSourceKey,
  hoursBeforeStart
} from "../domain/booking-cancellation";
import {
  computeNoShowRetention,
  type NoShowRetentionRule
} from "../domain/booking-no-show";
import type { RescheduleRefusal } from "../domain/booking-reschedule";
import type { RefundPolicySource } from "../domain/booking-adapter";
import {
  COMMERCE_BOOKING_REFUND_DECIDED_EVENT_TYPE,
  COMMERCE_EVENT_VERSION,
  COMMERCE_ORDER_AGGREGATE_TYPE
} from "../domain/commerce-events";
import { releaseThresholdCents } from "../domain/payment-allocation";
import { fromCents, normalizeMoney } from "../domain/price-calculation";
import { refundableOf } from "../domain/returns";
import {
  fetchDecisionForLink,
  nightsOf,
  readOriginalBooking,
  type DecisionView
} from "./booking-cancellation";
import { resolvePolicyForLink, rulesOf } from "./booking-cancellation-policies";
import type { ReservationLinkSummary } from "./booking-reservation-links";
import { lockOrderForSettlement } from "./payment-allocation-directory";
import { loadRefundablePayments } from "./return-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_booking_reservation_link";
const PRODUCER_MODULE = "commerce";

/** A refusal of a no-show. The reschedule's union covers every code (a no-show shares them), so the routes map both with one function. */
export type NoShowRefusal = RescheduleRefusal;

export type NoShowActor =
  | { kind: "staff"; tenantUserId: string }
  /** The consumer that records a no-show a person marked in Booking itself. */
  | { kind: "system"; initiatedBy: string };

export type NoShowPreview = {
  linkId: string;
  orderId: string;
  reservationId: string;
  /** Booking's status of the reservation now. */
  reservationStatus: string;
  /** Whole hours after the ORIGINAL arrival are negative. */
  hoursBeforeStart: number;
  policySource: RefundPolicySource;
  policyId: string | null;
  policyVersion: number | null;
  retentionRule: NoShowRetentionRule;
  amountPaid: string;
  /** What the policy keeps. */
  retainedAmount: string;
  /** Paid and not kept: NOT refunded by the no-show (the ordinary refund path, if staff decide so). */
  notRetainedAmount: string;
};

type PreviewInternals = {
  preview: NoShowPreview;
  amountPaidCents: bigint;
  retainedCents: bigint;
  current: BookingReservationRecord;
};

export type NoShowPreviewOutcome =
  { ok: true; value: PreviewInternals } | { ok: false; refusal: NoShowRefusal };

/**
 * What a no-show would retain, without writing anything. `expectStatus` is the
 * Booking status the reservation must be in: `confirmed` for the staff act,
 * `no_show` for the consumer that records what a person already marked.
 */
export async function computeNoShowPreview(
  tx: Bun.SQL,
  tenantId: string,
  link: Pick<
    ReservationLinkSummary,
    "id" | "orderId" | "reservationId" | "status"
  >,
  port: BookingPort,
  options: { now: Date; expectStatus: "confirmed" | "no_show" }
): Promise<NoShowPreviewOutcome> {
  if (link.status !== "active") {
    return {
      ok: false,
      refusal: { code: "INVALID_STATE", reason: link.status }
    };
  }
  const decided = await fetchDecisionForLink(tx, tenantId, link.id);
  if (decided) {
    return {
      ok: false,
      refusal: { code: "INVALID_STATE", reason: "already_decided" }
    };
  }

  const got = await port.get(tx, {
    tenantId,
    reservationId: link.reservationId
  });
  if (!got.ok) return { ok: false, refusal: { code: "RESERVATION_NOT_FOUND" } };
  const current = got.reservation;
  if (current.status !== options.expectStatus) {
    return {
      ok: false,
      refusal: { code: "INVALID_STATE", reason: current.status }
    };
  }

  const original = await readOriginalBooking(tx, tenantId, port, link, current);
  if (!original) {
    return { ok: false, refusal: { code: "RESERVATION_NOT_FOUND" } };
  }
  const policy = await resolvePolicyForLink(
    tx,
    tenantId,
    original.root.id,
    original.root.productId
  );
  const rule: NoShowRetentionRule = policy.policy
    ? policy.policy.noShowRetention
    : "none";

  const payments = await loadRefundablePayments(tx, tenantId, link.orderId);
  const amountPaidCents = payments.reduce(
    (sum, payment) => sum + refundableOf(payment),
    0n
  );
  const order = (await tx`
    SELECT total, payment_method, dp_amount
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${link.orderId} AND deleted_at IS NULL
  `) as { total: string; payment_method: string; dp_amount: string | null }[];
  if (!order[0]) {
    return { ok: false, refusal: { code: "RESERVATION_NOT_FOUND" } };
  }
  const thresholdCents = releaseThresholdCents({
    total: normalizeMoney(String(order[0].total)),
    paymentMethod: order[0].payment_method,
    dpAmount:
      order[0].dp_amount === null
        ? null
        : normalizeMoney(String(order[0].dp_amount))
  });

  const rules = policy.policy ? rulesOf(policy.policy) : null;
  const nowMs = options.now.getTime();
  // `refund_per_windows` evaluates the windows at the no-show instant, which is
  // after arrival: the windows themselves answer "nothing" there. Evaluated for
  // real, not assumed.
  const windowRefundCents =
    rule === "refund_per_windows"
      ? computeCancellationRefund({
          amountPaidCents,
          startsAtMs: original.startsAtMs,
          nowMs,
          rules,
          nights: nightsOf(current)
        }).computedCents
      : 0n;
  const retention = computeNoShowRetention({
    rule,
    amountPaidCents,
    thresholdCents,
    windowRefundCents
  });

  return {
    ok: true,
    value: {
      preview: {
        linkId: link.id,
        orderId: link.orderId,
        reservationId: link.reservationId,
        reservationStatus: current.status,
        hoursBeforeStart: hoursBeforeStart(original.startsAtMs, nowMs),
        policySource: policy.source,
        policyId: policy.policy?.id ?? null,
        policyVersion: policy.policy?.version ?? null,
        retentionRule: rule,
        amountPaid: fromCents(amountPaidCents),
        retainedAmount: fromCents(retention.retainedCents),
        notRetainedAmount: fromCents(retention.notRetainedCents)
      },
      amountPaidCents,
      retainedCents: retention.retainedCents,
      current
    }
  };
}

export type NoShowContext = {
  tenantId: string;
  actor: NoShowActor;
  correlationId: string;
  port: BookingPort;
  now?: Date;
};

export type NoShowInput = {
  /** Resolved and tenant-scoped by the route (or the consumer). */
  link: ReservationLinkSummary;
  /** The caller's `Idempotency-Key`; absent only for the consumer (its key is the link). */
  idempotencyKey: string | null;
  reasonCode: string;
};

export type NoShowResult =
  | { kind: "marked" | "replayed"; decision: DecisionView }
  | { kind: "refused"; refusal: NoShowRefusal };

/** `bn1:<keyed hash of the acting party>:<keyed hash of the key>` - 87 characters whatever the client sent. */
export function buildNoShowClientKey(
  actorTag: string,
  idempotencyKey: string
): string {
  const party = computeRequestHash({ party: actorTag }).slice(0, 40);
  const digest = computeRequestHash({ key: idempotencyKey }).slice(0, 40);
  return `bn1:${party}:${digest}`;
}

async function lockClientKey(
  tx: Bun.SQL,
  tenantId: string,
  clientKey: string
): Promise<void> {
  await tx`
    SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:booking-no-show:${clientKey}`}, 0))
  `;
}

export async function recordBookingNoShow(
  tx: Bun.TransactionSQL,
  ctx: NoShowContext,
  input: NoShowInput
): Promise<NoShowResult> {
  const { tenantId, actor } = ctx;
  const link = input.link;
  const now = ctx.now ?? new Date();
  const staffId = actor.kind === "staff" ? actor.tenantUserId : null;
  const refuse = (refusal: NoShowRefusal): NoShowResult => ({
    kind: "refused",
    refusal
  });

  const actorTag =
    actor.kind === "staff"
      ? `staff:${actor.tenantUserId}`
      : `system:${actor.initiatedBy}`;
  const clientKey = buildNoShowClientKey(
    actorTag,
    input.idempotencyKey ?? `link:${link.id}`
  );
  const requestHash = computeRequestHash({
    scope: "commerce.booking_reservations.no_show",
    actor: actorTag,
    linkId: link.id,
    reasonCode: input.reasonCode
  });

  await lockClientKey(tx, tenantId, clientKey);

  // -- Replay (G5) -----------------------------------------------------------
  const prior = (await tx`
    SELECT request_hash, reservation_link_id
    FROM awcms_commerce_booking_refund_decisions
    WHERE tenant_id = ${tenantId} AND client_key = ${clientKey}
  `) as { request_hash: string; reservation_link_id: string }[];
  if (prior[0]) {
    if (prior[0].request_hash !== requestHash) {
      return refuse({ code: "IDEMPOTENCY_CONFLICT" });
    }
    const replayed = await fetchDecisionForLink(
      tx,
      tenantId,
      prior[0].reservation_link_id
    );
    if (!replayed)
      throw new Error("A recorded no-show could not be read back.");
    return { kind: "replayed", decision: replayed };
  }

  // -- The order lock, then the link under it -------------------------------------
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
  if (!fresh[0]) return refuse({ code: "RESERVATION_NOT_FOUND" });

  // -- What the policy retains ---------------------------------------------------------
  const previewed = await computeNoShowPreview(
    tx,
    tenantId,
    {
      id: fresh[0].id,
      orderId: fresh[0].order_id,
      reservationId: fresh[0].reservation_id,
      status: fresh[0].status
    },
    ctx.port,
    { now, expectStatus: staffId ? "confirmed" : "no_show" }
  );
  if (!previewed.ok) return refuse(previewed.refusal);
  const { preview, amountPaidCents, retainedCents } = previewed.value;

  // -- Booking marks the no-show (a refusal writes nothing) -----------------------------
  if (staffId) {
    const marked = await ctx.port.markNoShow(tx, {
      tenantId,
      reservationId: preview.reservationId,
      // Derived from the LINK, never from client input (G5).
      idempotencyKey: `commerce-booking-no-show:${preview.linkId}`,
      correlationId: ctx.correlationId,
      // Booking sees the staff member who marked it (the system actor never reaches here).
      actorTenantUserId: staffId
    });
    if (!marked.ok) return refuse({ code: "BOOKING", reason: marked.reason });
  }

  // =========================== WRITES ========================================
  await tx`
    UPDATE awcms_commerce_booking_reservation_links
    SET status = 'released', updated_at = now(),
        attention_resolved_at = CASE
          WHEN attention_reason IS NOT NULL AND attention_resolved_at IS NULL
            THEN now() ELSE attention_resolved_at END
    WHERE tenant_id = ${tenantId} AND id = ${link.id} AND status = 'active'
  `;

  const decisionRows = (await tx`
    INSERT INTO awcms_commerce_booking_refund_decisions (
      tenant_id, order_id, reservation_link_id, trigger_kind, actor_kind,
      actor_tenant_user_id, policy_id, policy_source, hours_before_start,
      refundable_percent, amount_paid, computed_refund, final_refund,
      retained_amount, source_key, client_key, request_hash
    )
    VALUES (
      ${tenantId}, ${link.orderId}, ${link.id}, 'no_show',
      ${staffId ? "staff" : "system"}, ${staffId},
      ${preview.policyId}, ${preview.policySource}, ${preview.hoursBeforeStart},
      ${basisPointsToPercent(0)}, ${fromCents(amountPaidCents)}, 0, 0,
      ${fromCents(retainedCents)}, ${decisionSourceKey(preview.reservationId)},
      ${clientKey}, ${requestHash}
    )
    RETURNING id
  `) as { id: string }[];
  const decisionId = decisionRows[0]!.id;

  // -- Audit + event ------------------------------------------------------------------
  const initiatedBy = staffId
    ? "staff"
    : actor.kind === "system"
      ? actor.initiatedBy
      : "staff";
  const base = {
    tenantId,
    actorTenantUserId: staffId ?? undefined,
    moduleKey: AUDIT_MODULE_KEY,
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: link.id,
    correlationId: ctx.correlationId
  } as const;
  await recordAuditEvent(tx, {
    ...base,
    action: "commerce.booking_reservation.no_show",
    severity: "warning",
    message: `Booking reservation marked no-show; the policy retains ${fromCents(retainedCents)} and refunds nothing.`,
    attributes: {
      orderId: link.orderId,
      reservationId: preview.reservationId,
      decisionId,
      actorKind: staffId ? "staff" : "system",
      initiatedBy,
      reasonCode: input.reasonCode,
      // The retention evidence (C-41): the amount, the rule, the policy version.
      amountPaid: fromCents(amountPaidCents),
      retainedAmount: fromCents(retainedCents),
      notRetainedAmount: preview.notRetainedAmount,
      retentionRule: preview.retentionRule,
      policySource: preview.policySource,
      policyId: preview.policyId,
      policyVersion: preview.policyVersion,
      hoursBeforeStart: preview.hoursBeforeStart,
      refundAmount: "0.00"
    }
  });
  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_BOOKING_REFUND_DECIDED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_ORDER_AGGREGATE_TYPE,
    aggregateId: link.orderId,
    producerModule: PRODUCER_MODULE,
    correlationId: ctx.correlationId,
    actorTenantUserId: staffId ?? undefined,
    payload: {
      decisionId,
      orderId: link.orderId,
      reservationId: preview.reservationId,
      triggerKind: "no_show",
      policySource: preview.policySource,
      amountPaid: fromCents(amountPaidCents),
      computedRefund: "0.00",
      finalRefund: "0.00",
      overridden: false,
      retainedAmount: fromCents(retainedCents)
    }
  });

  const decision = await fetchDecisionForLink(tx, tenantId, link.id);
  if (!decision) throw new Error("A recorded no-show could not be read back.");
  return { kind: "marked", decision };
}
