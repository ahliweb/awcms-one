/**
 * The order-paid commission attributor (Issue #391, ADR-0046 D12): the side
 * effect of the `commerce.order_paid_commission_attributor` consumer. When a POS
 * sale is paid it SUBMITS each of its lines to `hr_commission`'s intake queue
 * through `CommissionIntakePort` (upstream ADR-0147) - and does nothing else.
 *
 * ## What this function guarantees
 *
 *   * **Off by default.** A tenant that has not switched it on (settings row
 *     absent or `enabled = false`), or that has switched `hr_commission` off,
 *     gets a no-op and no read of any order.
 *   * **Facts come from the database, never from the event.** The event payload
 *     is not read at all; the order, its channel, the cashier stamp, its lines
 *     and its discounts are read here, in the consumer's own transaction. A
 *     storefront order, an order with no cashier stamp and a cashier with no LIVE
 *     staff link report nothing - there is no fallback beneficiary.
 *   * **Exactly once per line.** The source identity is
 *     `(settings.sourceType, order id, order-line id)`; the intake's unique key
 *     adds the employment and the request digest, so a replayed event, a
 *     redelivery after a crash and a re-run are the SAME intake record
 *     (`duplicate`) and the poster posts ONE accrual. The runtime's
 *     `runtime_effect_once` guard sits on top; this function never calls it.
 *   * **`queued` is not `accrued`.** The intake is eventually consistent: the
 *     accrual appears after the poster's next tick and every business refusal
 *     (no rule in force, ineligible employment, a conflicting earlier request, a
 *     closed period) is discovered ONLY in the tenant's intake exceptions list
 *     (`hr_commission.intake.read`), never here. Commerce keeps
 *     its own record of what it submitted (`awcms_commerce_commission_submissions`,
 *     written in the SAME transaction) and one audit row; it never reads a
 *     commission or payroll table to find out more.
 *   * **Fail safe on an unavailable intake.** `disabled` (the tenant has not
 *     switched commission intake on) and `full` (10,000 live rows) write nothing
 *     and THROW: the delivery rolls back, is retried with the runtime's back-off
 *     and, still failing, is dead-lettered where an operator replays it once the
 *     intake is on or drained. An attributed sale is never dropped silently and
 *     never retried forever. `input_invalid` is deterministic (a retry cannot
 *     change it): it is audited as `attribution_rejected` and the delivery
 *     completes. Only a genuine failure (the database) also throws.
 *   * **The caller authorizes and audits.** There is no acting user: the
 *     authorization to pay commission was given, by a holder of
 *     `commerce.commission_settings.manage`, when the tenant switched this on,
 *     and by a holder of `commerce.commission_staff_links.manage` when the login
 *     was linked, and by a holder of `hr_commission.intake.configure` when the
 *     tenant switched the intake on - all audited. The submission carries no
 *     actor, and every attempt is audited here with the order as the resource
 *     and no amount, base or rate.
 *
 * ## Who earned it, and what is already returned (issue #449, ADR-0046 D11)
 *
 *   * **The beneficiary is the employment linked WHEN THE SALE WAS PAID**
 *     (`paid_at`), not when this delivery happens to run, so a delayed delivery
 *     cannot drop the sale (link retired meanwhile) or hand it to a new employment
 *     (link re-pointed meanwhile).
 *   * **A line already fully returned is not submitted.** If this delivery is
 *     delayed past a completed refund, the refund reverser has already run and
 *     would never void what is queued now. The per-order advisory lock the
 *     reversers also take makes the two orders of arrival equivalent.
 *
 * ## What it does not do
 *
 * It never reads a commission table, a rate or an accrual, and it never voids
 * anything: reversal is `commission-reversal.ts`, through
 * `CommissionIntakePort.submitVoid`.
 */
import type { CommissionAccrualRequest } from "../../_shared/ports/commission-accrual-port";
import type { CommissionIntakePort } from "../../_shared/ports/commission-intake-port";
import { resolveModuleEnabled } from "../../identity-access/application/auth-context";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  allocateLineBases,
  classifyIntakeOutcome,
  COMMISSION_CURRENCY_CODE,
  CommissionIntakeUnavailableError,
  commissionOccurredOn,
  commissionSourceIdentity,
  decideAttributableLogin,
  emptyTally,
  intakeUnavailableReason,
  tallyOutcome,
  type CommissionSkipReason,
  type OutcomeTally
} from "../domain/commission-attribution";
import { fromCents, toCents } from "../domain/price-calculation";
import { SALES_REPORT_TIME_ZONE } from "../domain/sales-report-deltas";
import {
  fetchCommissionSettings,
  findEmploymentLinkedAt,
  readReturnedLines,
  lockCommissionOrder,
  lockCommissionSettings,
  recordAttributedSource,
  recordSubmission
} from "./commission-attribution-directory";
import { commerceCommissionIntakePort } from "./commission-attribution-port";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_order";
/** The module key of the ledger's owner, for the tenant's enablement check. */
const HR_COMMISSION_MODULE_KEY = "hr_commission";

export type CommissionAttributionResult =
  | { kind: "skipped"; reason: CommissionSkipReason }
  | { kind: "submitted"; linkId: string; tally: OutcomeTally };

type OrderRow = {
  id: string;
  status: string;
  payment_status: string;
  channel: string;
  pos_cashier_tenant_user_id: string | null;
  paid_at: Date | string | null;
  discount: string;
  loyalty_discount: string;
};

type LineRow = { id: string; line_total: string };

export async function attributeCommissionForPaidOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  correlationId?: string,
  options: {
    port?: CommissionIntakePort;
    now?: Date;
  } = {}
): Promise<CommissionAttributionResult> {
  // Shared, held to the end of this transaction: a settings update (exclusive)
  // waits for us, so the identity we accrue under is the one it will see locked.
  await lockCommissionSettings(tx, tenantId, false);
  const settings = await fetchCommissionSettings(tx, tenantId);
  if (!settings.enabled || settings.ruleKey === null) {
    return { kind: "skipped", reason: "disabled" };
  }

  if (!(await resolveModuleEnabled(tx, tenantId, HR_COMMISSION_MODULE_KEY))) {
    return { kind: "skipped", reason: "hr_commission_disabled" };
  }

  // Serialises this attribution against the reversers of the SAME order, so a
  // delayed delivery either sees a refund that has already completed (and skips
  // the fully returned line) or finishes first (and the reverser then voids it).
  await lockCommissionOrder(tx, tenantId, orderId);

  const orderRows = (await tx`
    SELECT id, status, payment_status, channel, pos_cashier_tenant_user_id, paid_at,
           discount, loyalty_discount
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${orderId} AND deleted_at IS NULL
  `) as OrderRow[];
  const order = orderRows[0];
  if (!order) return { kind: "skipped", reason: "order_not_found" };

  const login = decideAttributableLogin({
    status: order.status,
    paymentStatus: order.payment_status,
    channel: order.channel,
    posCashierTenantUserId: order.pos_cashier_tenant_user_id
  });
  if (login.kind === "skip" || order.paid_at === null) {
    return {
      kind: "skipped",
      reason: login.kind === "skip" ? login.reason : "order_not_commissionable"
    };
  }

  // The employment linked WHEN THE SALE WAS PAID, not when this delivery runs
  // (ADR-0046 D11): a delayed delivery must not change who earned the sale.
  const paidAt = new Date(order.paid_at);
  const link = await findEmploymentLinkedAt(
    tx,
    tenantId,
    login.tenantUserId,
    paidAt
  );
  if (!link) return { kind: "skipped", reason: "no_staff_link" };

  // `ORDER BY created_at, id`: the discount allocation depends on line order, and
  // a redelivery must reproduce the request exactly.
  const lineRows = (await tx`
    SELECT id, line_total
    FROM awcms_commerce_order_items
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND deleted_at IS NULL
    ORDER BY created_at, id
  `) as LineRow[];

  const orderDiscount = fromCents(
    toCents(String(order.discount)) + toCents(String(order.loyalty_discount))
  );
  // The discount is allocated over EVERY line first and the fully returned ones
  // dropped afterwards, so each remaining line keeps the figure the reverser's
  // allocation maps to (ADR-0046 D4).
  const { fullyReturned, partiallyReturned } = await readReturnedLines(
    tx,
    tenantId,
    orderId
  );
  const positive = allocateLineBases(
    lineRows.map((line) => ({
      id: line.id,
      lineTotal: String(line.line_total)
    })),
    orderDiscount
  ).filter((line) => toCents(line.baseAmount) > 0n);
  const bases = positive.filter((line) => !fullyReturned.has(line.id));
  const skippedReturned = positive.length - bases.length;
  if (bases.length === 0) {
    return { kind: "skipped", reason: "no_commissionable_lines" };
  }

  const occurredOn = commissionOccurredOn(
    paidAt,
    await fetchTenantTimeZone(tx, tenantId)
  );
  const port = options.port ?? commerceCommissionIntakePort();
  const tally = emptyTally();

  for (const line of bases) {
    const request: CommissionAccrualRequest = {
      employmentId: link.employmentId,
      ruleKey: settings.ruleKey,
      source: commissionSourceIdentity(settings.sourceType, orderId, line.id),
      baseAmount: line.baseAmount,
      currencyCode: COMMISSION_CURRENCY_CODE,
      occurredAt: paidAt,
      occurredOn,
      correlationId
    };
    const outcome = await port.submitAccrual(tx, tenantId, null, request);
    const unavailable = intakeUnavailableReason(outcome);
    // Nothing was written for this line. Throwing rolls back the lines already
    // submitted in THIS delivery too, so a retry starts clean and a dead letter
    // holds the whole sale (see the header).
    if (unavailable !== null) {
      throw new CommissionIntakeUnavailableError(unavailable);
    }
    tallyOutcome(tally, outcome);
    if (classifyIntakeOutcome(outcome) === "accepted") {
      // Commerce's own record of what it reported: the reversers void exactly
      // these, in the same transaction as the intake record they describe.
      await recordSubmission(tx, tenantId, {
        orderId,
        orderItemId: line.id,
        employmentId: link.employmentId,
        sourceType: settings.sourceType,
        ruleKey: settings.ruleKey
      });
    }
  }

  // Freeze the source identity (settings update refuses to change it) in the
  // SAME transaction as the submission it protects. A duplicate also proves one
  // exists.
  if (tally.queued > 0 || tally.duplicate > 0) {
    await recordAttributedSource(
      tx,
      tenantId,
      settings.sourceType,
      settings.ruleKey
    );
  }

  await auditAttempt(
    tx,
    tenantId,
    orderId,
    link.linkId,
    tally,
    { skippedReturned, partiallyReturned },
    correlationId
  );

  return { kind: "submitted", linkId: link.linkId, tally };
}

/** The tenant's own time zone; commerce's reporting zone when the tenant has no settings row. */
async function fetchTenantTimeZone(
  tx: Bun.SQL,
  tenantId: string
): Promise<string> {
  const rows = (await tx`
    SELECT timezone FROM awcms_tenant_settings WHERE tenant_id = ${tenantId}
  `) as { timezone: string }[];
  return rows[0]?.timezone ?? SALES_REPORT_TIME_ZONE;
}

/**
 * Two audit rows at most: `commerce.commission.submitted` (info) when anything
 * was newly queued, and `commerce.commission.attribution_rejected` (warning) when
 * the intake refused a line as malformed. A pure replay writes nothing. No
 * amount, base, rate, source reference or employment id is recorded - the order
 * is the resource and the link joins it to the intake record through the
 * correlation id. A business refusal is NOT audited here: it happens later, in
 * the poster, and is audited and listed by `hr_commission`.
 */
async function auditAttempt(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  linkId: string,
  tally: OutcomeTally,
  returned: { skippedReturned: number; partiallyReturned: number },
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
      action: "commerce.commission.submitted",
      severity: "info",
      message:
        "A paid counter sale was submitted to the commission intake queue.",
      attributes: {
        linkId,
        linesQueued: tally.queued,
        linesDuplicate: tally.duplicate,
        linesSkippedReturned: returned.skippedReturned,
        linesPartiallyReturned: returned.partiallyReturned
      }
    });
  }

  if (tally.invalid > 0) {
    await recordAuditEvent(tx, {
      ...base,
      action: "commerce.commission.attribution_rejected",
      severity: "warning",
      message:
        "The commission intake rejected a line of a paid counter sale as invalid; it will not be retried.",
      attributes: { linkId, invalid: tally.invalid }
    });
  }
}
