/**
 * The order-paid commission attributor (Issue #391, ADR-0046): the side effect
 * of the `commerce.order_paid_commission_attributor` consumer. When a POS sale
 * is paid it reports each of its lines to the `hr_commission` accrual ledger
 * through `CommissionAccrualPort` - and does nothing else.
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
 *     `(settings.sourceType, order id, order-line id)` and the ledger's unique
 *     key adds the employment, so a replayed event, a redelivery after a crash
 *     and a re-run are the SAME accrual (`replayed`). The runtime's
 *     `runtime_effect_once` guard sits on top of that; this function never calls
 *     it.
 *   * **A refusal is an outcome, not an exception.** `no_effective_rule`,
 *     `employment_not_eligible` and the rest are returned by the port and
 *     recorded in one audit row per kind; they do not throw, because a delivery
 *     that throws is retried eight times and then dead-lettered for a
 *     configuration problem no retry can fix. Only a genuine failure (the
 *     database) throws, rolling back this delivery's transaction - marker
 *     included - for a retry.
 *   * **The caller authorizes and audits (the port's contract).** There is no
 *     acting user: the authorization to pay commission was given, by a holder of
 *     `commerce.commission_settings.manage`, when the tenant switched this on,
 *     and by a holder of `commerce.commission_staff_links.manage` when the login
 *     was linked - both audited. The accrual's `created_by` is therefore `null`
 *     (the system), and every attempt is audited here with the order as the
 *     resource and no amount, base or rate.
 *
 * ## What it does not do
 *
 * It never reads a commission table, a rate or an accrual, and it never voids
 * anything: a refund, return or cancellation does NOT reverse a commission
 * today, because `CommissionAccrualPort` exposes no void or reversal (a gap
 * recorded in ADR-0046 with the upstream extension it needs). Voiding by
 * writing to `hr_commission`'s tables, or by calling its application code
 * directly, would be a boundary violation and is not done.
 */
import type {
  CommissionAccrualPort,
  CommissionAccrualRequest
} from "../../_shared/ports/commission-accrual-port";
import { resolveModuleEnabled } from "../../identity-access/application/auth-context";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  allocateLineBases,
  COMMISSION_CURRENCY_CODE,
  commissionOccurredOn,
  commissionSourceIdentity,
  decideAttributableLogin,
  emptyTally,
  isOrderWideRefusal,
  tallyOutcome,
  type CommissionSkipReason,
  type OutcomeTally
} from "../domain/commission-attribution";
import { fromCents, toCents } from "../domain/price-calculation";
import { SALES_REPORT_TIME_ZONE } from "../domain/sales-report-deltas";
import {
  fetchCommissionSettings,
  findLiveEmploymentForLogin
} from "./commission-attribution-directory";
import { commerceCommissionAccrualPort } from "./commission-attribution-port";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_order";
/** The module key of the ledger's owner, for the tenant's enablement check. */
const HR_COMMISSION_MODULE_KEY = "hr_commission";

export type CommissionAttributionResult =
  | { kind: "skipped"; reason: CommissionSkipReason }
  | { kind: "reported"; linkId: string; tally: OutcomeTally };

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
    port?: CommissionAccrualPort;
    now?: Date;
  } = {}
): Promise<CommissionAttributionResult> {
  const settings = await fetchCommissionSettings(tx, tenantId);
  if (!settings.enabled || settings.ruleKey === null) {
    return { kind: "skipped", reason: "disabled" };
  }

  if (!(await resolveModuleEnabled(tx, tenantId, HR_COMMISSION_MODULE_KEY))) {
    return { kind: "skipped", reason: "hr_commission_disabled" };
  }

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

  const link = await findLiveEmploymentForLogin(
    tx,
    tenantId,
    login.tenantUserId
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
  const bases = allocateLineBases(
    lineRows.map((line) => ({
      id: line.id,
      lineTotal: String(line.line_total)
    })),
    orderDiscount
  ).filter((line) => toCents(line.baseAmount) > 0n);
  if (bases.length === 0) {
    return { kind: "skipped", reason: "no_commissionable_lines" };
  }

  const paidAt = new Date(order.paid_at);
  const occurredOn = commissionOccurredOn(
    paidAt,
    await fetchTenantTimeZone(tx, tenantId)
  );
  const port = options.port ?? commerceCommissionAccrualPort();
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
    const outcome = await port.accrue(tx, tenantId, null, request);
    tallyOutcome(tally, outcome);
    // The same refusal would come back for every remaining line.
    if (isOrderWideRefusal(outcome)) break;
  }

  await auditAttempt(tx, tenantId, orderId, link.linkId, tally, correlationId);

  return { kind: "reported", linkId: link.linkId, tally };
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
 * One audit row per outcome class: `attributed` (info) when anything was newly
 * accrued, `attribution_refused` (warning) per distinct refusal, and
 * `attribution_rejected` (warning) for source conflicts and invalid requests. A
 * pure replay writes nothing. No amount, base, rate, source reference or
 * employment id is recorded - the order is the resource and the link joins it to
 * the ledger row through the correlation id.
 */
async function auditAttempt(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  linkId: string,
  tally: OutcomeTally,
  correlationId?: string
): Promise<void> {
  const base = {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: orderId,
    correlationId
  };

  if (tally.accrued > 0) {
    await recordAuditEvent(tx, {
      ...base,
      action: "commerce.commission.attributed",
      severity: "info",
      message: "A paid counter sale was reported to the commission ledger.",
      attributes: {
        linkId,
        linesAccrued: tally.accrued,
        linesReplayed: tally.replayed
      }
    });
  }

  for (const [reason, lines] of Object.entries(tally.refused)) {
    await recordAuditEvent(tx, {
      ...base,
      action: "commerce.commission.attribution_refused",
      severity: "warning",
      message: "The commission ledger refused a paid counter sale.",
      attributes: { linkId, reason, lines }
    });
  }

  if (tally.conflicts > 0 || tally.invalid > 0) {
    await recordAuditEvent(tx, {
      ...base,
      action: "commerce.commission.attribution_rejected",
      severity: "warning",
      message:
        "The commission ledger rejected a line of a paid counter sale as a conflict or invalid.",
      attributes: {
        linkId,
        conflicts: tally.conflicts,
        invalid: tally.invalid
      }
    });
  }
}
