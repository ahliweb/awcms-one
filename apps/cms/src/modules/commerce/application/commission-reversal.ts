/**
 * The commission reverser (Issue #391 second half, ADR-0046 D9): the side effect
 * of the `commerce.order_cancelled_commission_reverser` and
 * `commerce.refund_settled_commission_reverser` consumers. When a counter sale
 * is cancelled, or refunded in full for a line, it reverses the accrual that
 * `commission-attribution.ts` reported - through `CommissionAccrualPort.void`,
 * keyed by the SAME source identity `(settings.sourceType, order id, order-line
 * id)` - and does nothing else.
 *
 * ## What this function guarantees
 *
 *   * **Same facts, same identity.** The beneficiary is re-derived from the
 *     database exactly as the accrue derived it (the order's cashier stamp, then
 *     the staff link) - except that every employment the login was EVER linked
 *     to is tried, live or retired, because the link may have changed between the
 *     sale and its refund. A void for an employment that never earned the line is
 *     `not_found`, which is a no-op. The event payload is never read.
 *   * **A void with nothing to void is normal.** A sale that was never reported
 *     (storefront order, tenant that had the adapter off, a line below the
 *     threshold, a refused accrual) answers `not_found`: counted, not audited,
 *     not an error. A replay answers `already_voided`: nothing is written.
 *   * **A refusal is an outcome, never an exception, and is never retried.**
 *     `period_closed` (the accrual is `payable` or `paid`: payroll may hold it),
 *     `actor_required` and `input_invalid` are returned by the port, tallied and
 *     recorded in ONE warning audit row (`reversal_needs_attention`) that a human
 *     works from; a delivery that threw would be retried eight times and then
 *     dead-lettered for something no retry can change. Only a genuine failure
 *     (the database) throws.
 *   * **Partial returns do nothing.** The port voids a whole accrual and a voided
 *     accrual is never resurrected, so a line is reversed by a refund only when
 *     every unit of it has been returned (`isLineFullyReturned`, summed over all
 *     completed returns of the order). A partly returned line is counted as
 *     `partial`, left alone, and surfaced in the same warning row.
 *   * **The actor.** `void` stamps a PERSON on the status edge; an event consumer
 *     has none, and the event envelope does not reach a handler. The voider is
 *     the tenant user who last saved the commission settings - the person who
 *     authorised commission to be paid (ADR-0046 D6) - and the commerce audit row
 *     says it was automatic. If there is none, the port answers `actor_required`.
 *   * **It does not depend on the switch.** A tenant that turned the adapter OFF
 *     after accruing still gets the accruals of cancelled and refunded sales
 *     reversed; the only precondition is that `hr_commission` is on and that the
 *     adapter was configured once.
 *
 * It never reads a commission table, a rate or an accrual: it sees only the
 * port's answers.
 */
import type {
  CommissionAccrualPort,
  CommissionVoidOutcome
} from "../../_shared/ports/commission-accrual-port";
import { resolveModuleEnabled } from "../../identity-access/application/auth-context";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  COMMISSION_VOID_REASON_LINE_RETURNED,
  COMMISSION_VOID_REASON_ORDER_CANCELLED,
  commissionSourceIdentity,
  emptyVoidTally,
  isLineFullyReturned,
  tallyVoidOutcome,
  voidNeedsAttention,
  type CommissionSkipReason,
  type VoidTally
} from "../domain/commission-attribution";
import {
  fetchCommissionReversalContext,
  listEmploymentsEverLinkedToLogin
} from "./commission-attribution-directory";
import { commerceCommissionAccrualPort } from "./commission-attribution-port";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_order";
const HR_COMMISSION_MODULE_KEY = "hr_commission";

export type CommissionReversalCause = "order_cancelled" | "refund_settled";

export type CommissionReversalResult =
  | { kind: "skipped"; reason: CommissionSkipReason }
  | { kind: "reversed"; tally: VoidTally };

type ReversalOptions = { port?: CommissionAccrualPort };

/** A cancelled order: every line of it is reversed. */
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
    async () => {
      const lines = (await tx`
        SELECT id FROM awcms_commerce_order_items
        WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
        ORDER BY created_at, id
      `) as { id: string }[];
      return { lineIds: lines.map((line) => line.id), partial: 0 };
    },
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
        lineIds: full.map((line) => line.id),
        partial: lines.length - full.length
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
  pickLines: () => Promise<{ lineIds: string[]; partial: number }>,
  correlationId: string | undefined,
  options: ReversalOptions
): Promise<CommissionReversalResult> {
  const context = await fetchCommissionReversalContext(tx, tenantId);
  // Never configured: nothing was ever reported.
  if (!context) return { kind: "skipped", reason: "disabled" };

  if (!(await resolveModuleEnabled(tx, tenantId, HR_COMMISSION_MODULE_KEY))) {
    return { kind: "skipped", reason: "hr_commission_disabled" };
  }

  const orders = (await tx`
    SELECT pos_cashier_tenant_user_id
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${orderId}
  `) as { pos_cashier_tenant_user_id: string | null }[];
  const order = orders[0];
  if (!order) return { kind: "skipped", reason: "order_not_found" };
  if (order.pos_cashier_tenant_user_id === null) {
    return { kind: "skipped", reason: "no_cashier_stamp" };
  }

  const employments = await listEmploymentsEverLinkedToLogin(
    tx,
    tenantId,
    order.pos_cashier_tenant_user_id
  );
  if (employments.length === 0) {
    return { kind: "skipped", reason: "no_staff_link" };
  }

  const { lineIds, partial } = await pickLines();
  const tally = emptyVoidTally();
  tally.partial = partial;
  const port = options.port ?? commerceCommissionAccrualPort();

  for (const lineId of lineIds) {
    for (const employmentId of employments) {
      const outcome: CommissionVoidOutcome = await port.void(
        tx,
        tenantId,
        context.actorTenantUserId,
        {
          employmentId,
          source: commissionSourceIdentity(context.sourceType, orderId, lineId),
          reason: reasonCode,
          correlationId
        }
      );
      tallyVoidOutcome(tally, outcome);
    }
  }

  await auditReversal(tx, tenantId, orderId, cause, tally, correlationId);
  return { kind: "reversed", tally };
}

/**
 * Two audit rows at most, with the order as the resource and counts only (no
 * amount, rate, source reference, accrual or employment id - ADR-0046 D6):
 * `commerce.commission.reversed` (info) when anything was newly voided, and
 * `commerce.commission.reversal_needs_attention` (warning) when a human has to
 * act - the closed-period accruals a refund could not reverse, a partly returned
 * line, a reversal with no person to stamp. A pure replay writes nothing.
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

  if (tally.voided > 0) {
    await recordAuditEvent(tx, {
      ...base,
      action: "commerce.commission.reversed",
      severity: "info",
      message:
        "The commission accrued on a counter sale was voided because the sale was cancelled or refunded.",
      attributes: { cause, linesVoided: tally.voided }
    });
  }

  if (voidNeedsAttention(tally)) {
    await recordAuditEvent(tx, {
      ...base,
      action: "commerce.commission.reversal_needs_attention",
      severity: "warning",
      message:
        "A cancelled or refunded counter sale left commission that the ledger did not reverse; a person must decide.",
      attributes: {
        cause,
        periodClosedPayable: tally.periodClosed.payable,
        periodClosedPaid: tally.periodClosed.paid,
        partiallyReturnedLines: tally.partial,
        actorRequired: tally.actorRequired,
        invalid: tally.invalid
      }
    });
  }
}
