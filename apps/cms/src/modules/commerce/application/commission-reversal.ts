/**
 * The commission reverser (Issue #391 second half, ADR-0046 D9 and D12): the
 * side effect of the `commerce.order_cancelled_commission_reverser` and
 * `commerce.refund_settled_commission_reverser` consumers. When a counter sale
 * is cancelled, or refunded in full for a line, it SUBMITS a void to
 * `hr_commission`'s intake queue (`CommissionIntakePort.submitVoid`) for exactly
 * the lines commerce submitted an accrual for, keyed by the SAME source identity
 * `(source type, order id, order-line id)` - and does nothing else.
 *
 * ## What this function guarantees
 *
 *   * **Only what was submitted.** The lines, employments and source type come
 *     from commerce's OWN record of its submissions
 *     (`awcms_commerce_commission_submissions`), never from a guess over the
 *     staff links. A sale that was never reported (storefront order, a tenant
 *     that had the adapter off, a line below the threshold, a never-paid order)
 *     has no submission and is skipped (`no_submissions`) without queueing
 *     anything - a blind void would be refused LATER and fill the tenant's
 *     intake exceptions list with `not_found` noise.
 *   * **A void is eventually consistent.** `queued` means recorded, not voided.
 *     The poster voids the accrual on its next tick; one still `pending` or
 *     `approved` is voidable, a `payable` or `paid` one is refused `period_closed`
 *     and a void arriving before its accrual waits up to 24 hours. Every such
 *     refusal appears ONLY in the intake exceptions list for a person; this
 *     function never sees it and never reads a commission table.
 *   * **The actor is the person who cancelled or refunded.** A void stamps a
 *     PERSON on the status edge. The event envelope does not reach a handler, so
 *     the reverser reads its own delivered event's `actor_tenant_user_id` (the
 *     producer stamps it in the fact's transaction). A system-driven reversal has
 *     none: the intake answers `actor_required`, which is counted and recorded in
 *     ONE warning audit row (`reversal_needs_attention`) that a person works from
 *     (void the accrual in `hr_commission`). It is deterministic, so it is never
 *     retried; it is also never silent.
 *   * **Fail safe on an unavailable intake.** `disabled` and `full` write nothing
 *     and THROW (retry with back-off, then dead-letter, replayable), exactly as the
 *     attributor does; `input_invalid` is audited and the delivery completes.
 *   * **Partial returns do nothing.** The ledger voids a whole accrual and a
 *     voided accrual is never resurrected, so a line is reversed by a refund only
 *     when every unit of it has been returned (`isLineFullyReturned`, summed over
 *     all completed returns of the order). A partly returned line is counted as
 *     `partial`, left alone, and surfaced in the same warning row.
 *   * **It does not depend on the switch.** A tenant that turned the adapter OFF
 *     after submitting still gets the cancelled and refunded sales reversed; the
 *     precondition is that `hr_commission` is on (otherwise the skip is audited
 *     for a person, because a submitted accrual may still stand).
 */
import type { CommissionIntakePort } from "../../_shared/ports/commission-intake-port";
import { resolveModuleEnabled } from "../../identity-access/application/auth-context";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  COMMISSION_VOID_REASON_LINE_RETURNED,
  COMMISSION_VOID_REASON_ORDER_CANCELLED,
  CommissionIntakeUnavailableError,
  commissionSourceIdentity,
  emptyVoidTally,
  intakeUnavailableReason,
  isLineFullyReturned,
  tallyVoidOutcome,
  voidNeedsAttention,
  type CommissionSkipReason,
  type VoidTally
} from "../domain/commission-attribution";
import {
  fetchEventActor,
  listSubmissionsForOrder,
  lockCommissionOrder,
  type CommissionSubmission
} from "./commission-attribution-directory";
import { commerceCommissionIntakePort } from "./commission-attribution-port";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_order";
const HR_COMMISSION_MODULE_KEY = "hr_commission";

export type CommissionReversalCause = "order_cancelled" | "refund_settled";

export type CommissionReversalResult =
  | { kind: "skipped"; reason: CommissionSkipReason }
  | { kind: "reversed"; tally: VoidTally };

/**
 * `port`: the intake (tests inject one). `eventId`: the delivered event whose
 * actor is the voider. `actorTenantUserId`: an explicit voider (`null` = a system
 * action), which wins over `eventId`.
 */
type ReversalOptions = {
  port?: CommissionIntakePort;
  eventId?: string;
  actorTenantUserId?: string | null;
};

/** A cancelled order: every submitted line of it is reversed. */
export async function reverseCommissionForCancelledOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  correlationId?: string,
  options: ReversalOptions = {}
): Promise<CommissionReversalResult> {
  return reverse(
    tx,
    tenantId,
    orderId,
    "order_cancelled",
    COMMISSION_VOID_REASON_ORDER_CANCELLED,
    async () => ({ fullLineIds: null, partialLineIds: [] }),
    correlationId,
    options
  );
}

/**
 * A settled refund leg of return `returnId`: the lines of that return that are
 * now fully returned are reversed; the others are left (see the header).
 */
export async function reverseCommissionForSettledRefund(
  tx: Bun.SQL,
  tenantId: string,
  returnId: string,
  correlationId?: string,
  options: ReversalOptions = {}
): Promise<CommissionReversalResult> {
  const head = (await tx`
    SELECT order_id, status
    FROM awcms_commerce_returns
    WHERE tenant_id = ${tenantId} AND id = ${returnId}
  `) as { order_id: string; status: string }[];
  const ret = head[0];
  if (!ret) return { kind: "skipped", reason: "return_not_found" };
  // `completed` = every refund leg has settled. An earlier leg's event arrives
  // while the return is still open and does nothing: money is still outstanding.
  if (ret.status !== "completed") {
    return { kind: "skipped", reason: "return_not_settled" };
  }

  return reverse(
    tx,
    tenantId,
    ret.order_id,
    "refund_settled",
    COMMISSION_VOID_REASON_LINE_RETURNED,
    async () => {
      const lines = (await tx`
        SELECT oi.id,
               oi.quantity::int AS ordered,
               COALESCE(SUM(rl.quantity), 0)::int AS returned
        FROM (
          SELECT DISTINCT tenant_id, order_item_id
          FROM awcms_commerce_return_lines
          WHERE tenant_id = ${tenantId} AND return_id = ${returnId}
        ) this_rl
        JOIN awcms_commerce_order_items oi
          ON oi.tenant_id = this_rl.tenant_id AND oi.id = this_rl.order_item_id
        JOIN awcms_commerce_return_lines rl
          ON rl.tenant_id = oi.tenant_id AND rl.order_item_id = oi.id
        JOIN awcms_commerce_returns r
          ON r.tenant_id = rl.tenant_id AND r.id = rl.return_id
             AND r.status = 'completed'
        GROUP BY oi.id, oi.quantity, oi.created_at
        ORDER BY oi.created_at, oi.id
      `) as { id: string; ordered: number; returned: number }[];
      const full = lines.filter((line) =>
        isLineFullyReturned(Number(line.ordered), Number(line.returned))
      );
      return {
        fullLineIds: new Set(full.map((line) => line.id)),
        partialLineIds: lines
          .filter((line) => !full.includes(line))
          .map((line) => line.id)
      };
    },
    correlationId,
    options
  );
}

async function reverse(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  cause: CommissionReversalCause,
  reasonCode: string,
  pickLines: () => Promise<{
    /** `null` = every submitted line (a cancellation). */
    fullLineIds: Set<string> | null;
    partialLineIds: string[];
  }>,
  correlationId: string | undefined,
  options: ReversalOptions
): Promise<CommissionReversalResult> {
  // Serialises this reversal against the attributor of the SAME order (issue
  // #449, ADR-0046 D11): a delayed attributor either finishes first, so the
  // submission below is found, or runs after and sees the completed return.
  await lockCommissionOrder(tx, tenantId, orderId);

  const submissions = await listSubmissionsForOrder(tx, tenantId, orderId);
  // Nothing was ever submitted for this order: nothing can stand in the ledger.
  if (submissions.length === 0) {
    return { kind: "skipped", reason: "no_submissions" };
  }

  if (!(await resolveModuleEnabled(tx, tenantId, HR_COMMISSION_MODULE_KEY))) {
    // A submitted accrual may still stand and the module that could void it is
    // off: say so for a person instead of dropping the reversal silently.
    await auditHrCommissionDisabled(
      tx,
      tenantId,
      orderId,
      cause,
      correlationId
    );
    return { kind: "skipped", reason: "hr_commission_disabled" };
  }

  const { fullLineIds, partialLineIds } = await pickLines();
  const tally = emptyVoidTally();
  const submittedLines = new Set(submissions.map((row) => row.orderItemId));
  tally.partial = partialLineIds.filter((id) => submittedLines.has(id)).length;
  const toVoid: CommissionSubmission[] = submissions.filter(
    (row) => fullLineIds === null || fullLineIds.has(row.orderItemId)
  );
  if (toVoid.length === 0) {
    await auditReversal(tx, tenantId, orderId, cause, tally, correlationId);
    return { kind: "reversed", tally };
  }

  const actor =
    options.actorTenantUserId !== undefined
      ? options.actorTenantUserId
      : options.eventId !== undefined
        ? await fetchEventActor(tx, tenantId, options.eventId)
        : null;
  const port = options.port ?? commerceCommissionIntakePort();

  for (const submission of toVoid) {
    const outcome = await port.submitVoid(tx, tenantId, actor, {
      employmentId: submission.employmentId,
      source: commissionSourceIdentity(
        submission.sourceType,
        orderId,
        submission.orderItemId
      ),
      reason: reasonCode,
      correlationId
    });
    const unavailable = intakeUnavailableReason(outcome);
    if (unavailable !== null) {
      throw new CommissionIntakeUnavailableError(unavailable);
    }
    tallyVoidOutcome(tally, outcome);
  }

  await auditReversal(tx, tenantId, orderId, cause, tally, correlationId);
  return { kind: "reversed", tally };
}

async function auditHrCommissionDisabled(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  cause: CommissionReversalCause,
  correlationId?: string
): Promise<void> {
  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: orderId,
    correlationId,
    action: "commerce.commission.reversal_needs_attention",
    severity: "warning",
    message:
      "A cancelled or refunded counter sale could not be reversed because the hr_commission module is off for the tenant; a person must decide.",
    attributes: { cause, hrCommissionDisabled: true }
  });
}

/**
 * Two audit rows at most, with the order as the resource and counts only (no
 * amount, rate, source reference, accrual or employment id - ADR-0046 D6):
 * `commerce.commission.reversal_submitted` (info) when anything was newly
 * queued, and `commerce.commission.reversal_needs_attention` (warning) when a
 * human has to act - a partly returned line, a reversal with no person to stamp,
 * a malformed one. A pure replay writes nothing. A closed period or a missing
 * accrual is decided later by the poster and listed by `hr_commission`.
 */
async function auditReversal(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  cause: CommissionReversalCause,
  tally: VoidTally,
  correlationId?: string
): Promise<void> {
  const base = {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: orderId,
    correlationId
  };

  if (tally.queued > 0) {
    await recordAuditEvent(tx, {
      ...base,
      action: "commerce.commission.reversal_submitted",
      severity: "info",
      message:
        "A void of the commission on a counter sale was submitted to the commission intake queue because the sale was cancelled or refunded.",
      attributes: { cause, linesQueued: tally.queued }
    });
  }

  if (voidNeedsAttention(tally)) {
    await recordAuditEvent(tx, {
      ...base,
      action: "commerce.commission.reversal_needs_attention",
      severity: "warning",
      message:
        "A cancelled or refunded counter sale left commission that could not be submitted for reversal; a person must decide.",
      attributes: {
        cause,
        partiallyReturnedLines: tally.partial,
        actorRequired: tally.actorRequired,
        invalid: tally.invalid
      }
    });
  }
}
