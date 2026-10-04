/**
 * Settling ONE refund leg - the single place a refund becomes a fact (Issue
 * #287, ADR-0033 D5-D7). Everything here runs in the CALLER's transaction and
 * makes no network call: the gateway adapter is called by
 * `refund-execution.ts` BEFORE this file runs, and this file is told the
 * outcome.
 *
 * ## What "settled" means, atomically
 *
 * In one transaction, under the order-row lock:
 *
 *   1. the payment ledger gets a compensating `reversal` row along the
 *      payment this leg refunds (`recordPaymentReversal` - capped at what the
 *      payment can still give back, stamped to the paying drawer for a cash
 *      leg, returning value to the account for a gift-card leg);
 *   2. for a store-credit destination, value is loaded onto (or a new account
 *      is issued with) the customer's store credit - the closed-loop ledger of
 *      ADR-0030, still without cash-out;
 *   3. the refund row moves to `succeeded` and says HOW (`ledger` / `provider`
 *      / `offline` / `store_credit`);
 *   4. the proportional compensations run, each recorded in the append-only
 *      `refund_compensations` log: the loyalty earn is partly reversed, the
 *      affiliate commission partly given back;
 *   5. the return completes when its last leg settles;
 *   6. one audit row and one `refund.settled` domain event.
 *
 * All of it commits or none of it does. Every refusal the caller could cause
 * (a drawer that is not open, a card that cannot take value back, a store
 * credit program that is off, a payment already reversed by hand) is decided
 * BEFORE the first write and returned as an outcome - a route that returns a
 * response commits its transaction (`tenant-route.ts`), so a refusal must
 * leave nothing behind. A failure AFTER the first write is an invariant
 * violation and throws {@link RefundInvariantError}, which nothing maps to a
 * response: the transaction rolls back and the request is a 500.
 *
 * ## Why a refund does not move the order's lifecycle
 *
 * ADR-0025 D3: a reversal lowers settlement and re-derives `payment_status`;
 * it never moves the order backwards. Whether the order is also cancelled is
 * a human decision, exactly as for a hand-recorded reversal.
 */
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_REFUND_SETTLED_EVENT_TYPE,
  COMMERCE_RETURN_AGGREGATE_TYPE
} from "../domain/commerce-events";
import { fromCents, toCents } from "../domain/price-calculation";
import {
  isStoredValueTender,
  storedValueSourceKeys
} from "../domain/stored-value";
import { POS_WALK_IN_CUSTOMER_SENTINEL_PHONE } from "../domain/phone-normalisation";
import type { RefundSettledVia } from "../domain/returns";
import { fetchCommerceFeatures } from "./commerce-feature-gate";
import { adjustAffiliateCommissionForRefund } from "./affiliate-directory";
import { reverseEarnForRefund } from "./loyalty-ledger";
import {
  lockOrderForSettlement,
  recordPaymentReversal,
  type AllocationActor
} from "./payment-allocation-directory";
import {
  REFUND_COLUMNS,
  toRefundRecord,
  type RefundRecord,
  type RefundRow
} from "./return-records";
import { checkReversalRegisterSession } from "./register-session-stamp";
import {
  appendStoredValueEntry,
  checkStoredValueLoadable,
  checkStoredValueRefundable,
  type StoredValueLoadRefusal,
  type StoredValueRefundRefusal
} from "./stored-value-ledger";
import { issueStoredValueAccount } from "./stored-value-directory";

const AUDIT_MODULE_KEY = "commerce";
const PRODUCER_MODULE = "commerce";

/** An impossible state reached AFTER the first write; unmapped on purpose so the transaction rolls back. */
export class RefundInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundInvariantError";
  }
}

export type SettleRefundParams = {
  refundId: string;
  /** The staff user performing the settlement. */
  actorTenantUserId: string;
  /**
   * How it settled. `auto` = decide from the leg: `store_credit` for a
   * store-credit destination, else `ledger` (cash handed back, a manual refund
   * booked, value returned to a card).
   */
  via: "auto" | "provider" | "offline";
  providerRefundId?: string | null;
  /** `via: "offline"` only: why the refund was made outside the system. */
  offlineReason?: string | null;
  /** A cash leg is paid out of THIS open drawer session of the actor (ADR-0028 D2). */
  registerSessionId?: string | null;
  /** A store-credit leg loads THIS account; `null`/omitted issues a new one. */
  storeCreditAccountId?: string | null;
  /**
   * Store credit only: the total that the whole request credits across all its
   * legs (the first leg issues the account, the rest load it), so the program's
   * balance ceiling is checked against the sum. Defaults to this leg's amount.
   */
  creditTotalCents?: bigint;
  now: Date;
  correlationId?: string;
};

export type SettleRefundRefusal =
  | { reason: "not_refundable"; reversible: string }
  | { reason: "register_session_not_found" }
  | { reason: "register_session_not_open"; status: string }
  | { reason: "register_session_not_cashier" }
  | { reason: StoredValueRefundRefusal }
  | {
      reason: "store_credit_unavailable";
      detail:
        | StoredValueLoadRefusal
        | "FEATURE_DISABLED"
        | "NO_PROGRAM"
        | "CUSTOMER_REQUIRED";
    };

export type IssuedStoreCredit = {
  accountId: string;
  /** The plaintext code, shown ONCE in the response of the request that issued it. */
  code: string | null;
  codeRevealed: boolean;
};

export type SettleRefundOutcome =
  | { kind: "not_found" }
  | { kind: "refused"; refusal: SettleRefundRefusal }
  | { kind: "already_settled"; refund: RefundRecord }
  | {
      kind: "settled";
      refund: RefundRecord;
      storeCredit: IssuedStoreCredit | null;
    };

type RefundLockRow = RefundRow & {
  actor_tenant_user_id: string;
};

type AllocationRow = {
  amount: string;
  tender_type: string;
  stored_value_account_id: string | null;
};

async function insertCompensation(
  tx: Bun.SQL,
  tenantId: string,
  refundId: string,
  kind:
    | "loyalty_reversal"
    | "affiliate_adjustment"
    | "store_credit_issue"
    | "store_credit_load",
  value: { points: number } | { amount: string },
  refId: string | null
): Promise<void> {
  await tx`
    INSERT INTO awcms_commerce_refund_compensations
      (tenant_id, refund_id, kind, points, amount, ref_id)
    VALUES (
      ${tenantId}, ${refundId}, ${kind},
      ${"points" in value ? value.points : null},
      ${"amount" in value ? value.amount : null},
      ${refId}
    )
    ON CONFLICT (tenant_id, refund_id, kind) DO NOTHING
  `;
}

export type RefundSettlementCheckInput = {
  orderId: string;
  allocationId: string;
  amountCents: bigint;
  destination: "original_tender" | "store_credit";
  actorTenantUserId: string;
  registerSessionId: string | null;
  storeCreditAccountId: string | null;
  /** Store credit: what the whole request credits (ceiling check). */
  creditTotalCents: bigint;
};

export type RefundSettlementCheck =
  | {
      ok: true;
      /** The open drawer a CASH leg is stamped with, else `null`. */
      registerSessionId: string | null;
      /** The customer a NEW store-credit account is issued to, else `null`. */
      creditCustomerId: string | null;
    }
  | { ok: false; refusal: SettleRefundRefusal };

/**
 * Every refusal a settlement can hit, decided WITHOUT writing the settlement
 * (it may lock - the payment's reversibility is read under the order lock the
 * caller holds, a gift card or a drawer is locked - and that is the point:
 * what it approves cannot change before the writes). Used by the settlement
 * itself and, for every leg up front, by `createReturn`, so a return is either
 * recorded with all its immediate legs or refused with nothing written.
 */
export async function checkRefundSettlement(
  tx: Bun.SQL,
  tenantId: string,
  input: RefundSettlementCheckInput
): Promise<RefundSettlementCheck> {
  const allocations = (await tx`
    SELECT amount, tender_type, stored_value_account_id
    FROM awcms_commerce_payment_allocations
    WHERE tenant_id = ${tenantId} AND id = ${input.allocationId}
      AND order_id = ${input.orderId} AND kind = 'payment' AND status = 'succeeded'
  `) as AllocationRow[];
  const allocation = allocations[0];
  if (!allocation) {
    return {
      ok: false,
      refusal: { reason: "not_refundable", reversible: "0.00" }
    };
  }

  const reversedRows = (await tx`
    SELECT COALESCE(SUM(amount), 0) AS reversed
    FROM awcms_commerce_payment_allocations
    WHERE tenant_id = ${tenantId} AND reverses_allocation_id = ${input.allocationId}
      AND status = 'succeeded'
  `) as { reversed: string }[];
  const reversibleCents =
    toCents(String(allocation.amount)) -
    toCents(String(reversedRows[0]!.reversed));
  if (reversibleCents < input.amountCents) {
    return {
      ok: false,
      refusal: {
        reason: "not_refundable",
        reversible: fromCents(reversibleCents > 0n ? reversibleCents : 0n)
      }
    };
  }

  const tender = allocation.tender_type;
  if (isStoredValueTender(tender) && allocation.stored_value_account_id) {
    const verdict = await checkStoredValueRefundable(tx, tenantId, {
      accountId: allocation.stored_value_account_id
    });
    if (!verdict.ok) {
      return { ok: false, refusal: { reason: verdict.refusal } };
    }
  }

  let registerSessionId: string | null = null;
  if (tender === "cash" && input.registerSessionId) {
    const session = await checkReversalRegisterSession(
      tx,
      tenantId,
      input.registerSessionId,
      input.actorTenantUserId
    );
    if (session.kind === "not_found") {
      return {
        ok: false,
        refusal: { reason: "register_session_not_found" }
      };
    }
    if (session.kind === "not_open") {
      return {
        ok: false,
        refusal: { reason: "register_session_not_open", status: session.status }
      };
    }
    if (session.kind === "not_session_cashier") {
      return {
        ok: false,
        refusal: { reason: "register_session_not_cashier" }
      };
    }
    registerSessionId = session.sessionId;
  }

  let creditCustomerId: string | null = null;
  if (input.destination === "store_credit") {
    const features = await fetchCommerceFeatures(tx, tenantId);
    if (!features.storedValue) {
      return {
        ok: false,
        refusal: {
          reason: "store_credit_unavailable",
          detail: "FEATURE_DISABLED"
        }
      };
    }
    if (input.storeCreditAccountId) {
      const verdict = await checkStoredValueLoadable(tx, tenantId, {
        accountId: input.storeCreditAccountId,
        kind: "store_credit",
        amount: fromCents(input.amountCents)
      });
      if (!verdict.ok) {
        return {
          ok: false,
          refusal: {
            reason: "store_credit_unavailable",
            detail: verdict.refusal
          }
        };
      }
    } else {
      const programs = (await tx`
        SELECT enabled, max_balance FROM awcms_commerce_stored_value_programs
        WHERE tenant_id = ${tenantId} AND kind = 'store_credit' AND deleted_at IS NULL
      `) as { enabled: boolean; max_balance: string | null }[];
      const program = programs[0];
      if (!program || !program.enabled) {
        return {
          ok: false,
          refusal: { reason: "store_credit_unavailable", detail: "NO_PROGRAM" }
        };
      }
      if (
        program.max_balance !== null &&
        input.creditTotalCents > toCents(String(program.max_balance))
      ) {
        return {
          ok: false,
          refusal: {
            reason: "store_credit_unavailable",
            detail: "BALANCE_CEILING"
          }
        };
      }
      const customers = (await tx`
        SELECT c.id, c.phone
        FROM awcms_commerce_orders o
        JOIN awcms_commerce_customers c
          ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
        WHERE o.tenant_id = ${tenantId} AND o.id = ${input.orderId}
      `) as { id: string; phone: string }[];
      const customer = customers[0];
      // A walk-in sale has no customer to own the credit: the operator must
      // name an existing account instead (the credit is a bearer code).
      if (!customer || customer.phone === POS_WALK_IN_CUSTOMER_SENTINEL_PHONE) {
        return {
          ok: false,
          refusal: {
            reason: "store_credit_unavailable",
            detail: "CUSTOMER_REQUIRED"
          }
        };
      }
      creditCustomerId = customer.id;
    }
  }

  return { ok: true, registerSessionId, creditCustomerId };
}

/**
 * Settles the refund leg `params.refundId`. The caller holds (or this call
 * takes) the order-row lock; the leg row is locked `FOR UPDATE` so a replay or
 * a concurrent settlement serialises and the second finds it settled.
 */
export async function settleRefundLeg(
  tx: Bun.SQL,
  tenantId: string,
  params: SettleRefundParams
): Promise<SettleRefundOutcome> {
  // Order first, always (ADR-0025 D4): the leg's order id is read without a
  // lock to know which order to lock, then the leg is re-read under the lock.
  const peek = (await tx`
    SELECT order_id FROM awcms_commerce_refunds
    WHERE tenant_id = ${tenantId} AND id = ${params.refundId}
  `) as { order_id: string }[];
  if (!peek[0]) return { kind: "not_found" };
  const header = await lockOrderForSettlement(tx, tenantId, peek[0].order_id);
  if (!header) return { kind: "not_found" };

  const rows = (await tx`
    SELECT ${tx.unsafe(REFUND_COLUMNS)}, actor_tenant_user_id
    FROM awcms_commerce_refunds
    WHERE tenant_id = ${tenantId} AND id = ${params.refundId}
    FOR UPDATE
  `) as RefundLockRow[];
  const refundRow = rows[0];
  if (!refundRow) return { kind: "not_found" };
  if (refundRow.status === "succeeded") {
    return { kind: "already_settled", refund: toRefundRecord(refundRow) };
  }

  const refundCents = toCents(String(refundRow.amount));
  const destination = refundRow.destination as
    "original_tender" | "store_credit";

  // --- every refusal, before the first write ---------------------------------
  const check = await checkRefundSettlement(tx, tenantId, {
    orderId: header.id,
    allocationId: refundRow.allocation_id,
    amountCents: refundCents,
    destination,
    actorTenantUserId: params.actorTenantUserId,
    registerSessionId: params.registerSessionId ?? null,
    storeCreditAccountId: params.storeCreditAccountId ?? null,
    creditTotalCents: params.creditTotalCents ?? refundCents
  });
  if (!check.ok) return { kind: "refused", refusal: check.refusal };
  const registerSessionId = check.registerSessionId;
  const creditCustomerId = check.creditCustomerId;

  // --- writes -----------------------------------------------------------------
  const actor: AllocationActor = {
    kind: "tenant_user",
    tenantUserId: params.actorTenantUserId
  };
  const reversal = await recordPaymentReversal(tx, tenantId, {
    orderId: header.id,
    allocationId: refundRow.allocation_id,
    amount: fromCents(refundCents),
    note: `Refund ${params.refundId}`,
    sourceKey: `refund:${params.refundId}`,
    actor,
    registerSessionId,
    correlationId: params.correlationId
  });
  if (reversal.kind !== "recorded" && reversal.kind !== "deduplicated") {
    throw new RefundInvariantError(
      `The payment-ledger reversal of a refund was refused after the pre-checks (${reversal.kind}).`
    );
  }

  let storeCredit: IssuedStoreCredit | null = null;
  let storeCreditAccountId: string | null = null;
  if (destination === "store_credit") {
    if (params.storeCreditAccountId) {
      const loaded = await appendStoredValueEntry(tx, tenantId, {
        accountId: params.storeCreditAccountId,
        kind: "load",
        amount: fromCents(refundCents),
        reason: `Refund ${params.refundId}`,
        sourceKey: storedValueSourceKeys.load(
          params.storeCreditAccountId,
          `refund:${params.refundId}`
        ),
        actor,
        correlationId: params.correlationId
      });
      if (loaded.kind !== "recorded" && loaded.kind !== "deduplicated") {
        throw new RefundInvariantError(
          `Store credit could not be loaded after the pre-checks (${loaded.kind}).`
        );
      }
      storeCreditAccountId = params.storeCreditAccountId;
      await insertCompensation(
        tx,
        tenantId,
        params.refundId,
        "store_credit_load",
        { amount: fromCents(refundCents) },
        storeCreditAccountId
      );
      storeCredit = {
        accountId: storeCreditAccountId,
        code: null,
        codeRevealed: false
      };
    } else {
      const issued = await issueStoredValueAccount(
        tx,
        tenantId,
        params.actorTenantUserId,
        {
          idempotencyKey: `refund:${params.refundId}`,
          kind: "store_credit",
          amount: fromCents(refundCents),
          customerId: creditCustomerId,
          expiresAt: undefined,
          reason: `Refund ${params.refundId}`
        },
        params.now,
        params.correlationId
      );
      if (issued.kind !== "created" && issued.kind !== "replayed") {
        throw new RefundInvariantError(
          `Store credit could not be issued after the pre-checks (${issued.kind}).`
        );
      }
      storeCreditAccountId = issued.body.account.id;
      await insertCompensation(
        tx,
        tenantId,
        params.refundId,
        "store_credit_issue",
        { amount: fromCents(refundCents) },
        storeCreditAccountId
      );
      storeCredit = {
        accountId: storeCreditAccountId,
        code: issued.body.code,
        codeRevealed: issued.body.codeRevealed
      };
    }
  }

  const settledVia: RefundSettledVia =
    params.via === "provider"
      ? "provider"
      : params.via === "offline"
        ? "offline"
        : destination === "store_credit"
          ? "store_credit"
          : "ledger";

  const updated = (await tx`
    UPDATE awcms_commerce_refunds
    SET status = 'succeeded',
        settled_via = ${settledVia},
        reversal_allocation_id = ${reversal.allocation.id},
        store_credit_account_id = ${storeCreditAccountId},
        provider_refund_id = COALESCE(${params.providerRefundId ?? null}, provider_refund_id),
        offline_reason = ${settledVia === "offline" ? (params.offlineReason ?? null) : null},
        offline_by_tenant_user_id = ${settledVia === "offline" ? params.actorTenantUserId : null},
        failure_code = NULL,
        settled_at = now(),
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${params.refundId}
    RETURNING ${tx.unsafe(REFUND_COLUMNS)}
  `) as RefundRow[];
  const refund = toRefundRecord(updated[0]!);

  // --- proportional compensations --------------------------------------------
  const cumulativeRows = (await tx`
    SELECT COALESCE(SUM(amount), 0) AS refunded
    FROM awcms_commerce_refunds
    WHERE tenant_id = ${tenantId} AND order_id = ${header.id} AND status = 'succeeded'
  `) as { refunded: string }[];
  const cumulativeRefundedCents = toCents(String(cumulativeRows[0]!.refunded));
  const orderTotalCents = toCents(header.total);

  if (orderTotalCents > 0n) {
    const loyalty = await reverseEarnForRefund(tx, tenantId, {
      orderId: header.id,
      refundId: params.refundId,
      cumulativeRefundedCents,
      orderTotalCents,
      asOf: params.now,
      correlationId: params.correlationId
    });
    if (loyalty.kind === "reversed" || loyalty.kind === "already_reversed") {
      await insertCompensation(
        tx,
        tenantId,
        params.refundId,
        "loyalty_reversal",
        { points: loyalty.entry.points },
        loyalty.entry.id
      );
    }

    const affiliate = await adjustAffiliateCommissionForRefund(tx, tenantId, {
      orderId: header.id,
      cumulativeRefundedCents,
      orderTotalCents,
      correlationId: params.correlationId
    });
    if (affiliate) {
      await insertCompensation(
        tx,
        tenantId,
        params.refundId,
        "affiliate_adjustment",
        { amount: affiliate.delta },
        affiliate.commissionId
      );
    }
  }

  // --- the return completes when its last leg settles ------------------------
  const open = (await tx`
    SELECT count(*)::int AS open_legs
    FROM awcms_commerce_refunds
    WHERE tenant_id = ${tenantId} AND return_id = ${refund.returnId}
      AND status <> 'succeeded'
  `) as { open_legs: number }[];
  if (Number(open[0]!.open_legs) === 0) {
    await tx`
      UPDATE awcms_commerce_returns
      SET status = 'completed', completed_at = now(), updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${refund.returnId} AND status = 'open'
        AND refund_total = (
          SELECT COALESCE(SUM(amount), 0)
          FROM awcms_commerce_refunds
          WHERE tenant_id = ${tenantId} AND return_id = ${refund.returnId}
            AND status = 'succeeded'
        )
    `;
  }

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: params.actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "refund.settle",
    resourceType: "commerce_refund",
    resourceId: refund.id,
    message: `Refund of ${refund.amount} (${refund.tenderType}) settled (${settledVia}) against order ${header.orderCode}.`,
    // Ids, money and the way it settled only - never the customer, the
    // provider reference or the free-text offline reason.
    attributes: {
      returnId: refund.returnId,
      orderId: header.id,
      orderCode: header.orderCode,
      allocationId: refund.allocationId,
      reversalAllocationId: refund.reversalAllocationId,
      tenderType: refund.tenderType,
      destination: refund.destination,
      amount: refund.amount,
      settledVia
    },
    correlationId: params.correlationId
  });

  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_REFUND_SETTLED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_RETURN_AGGREGATE_TYPE,
    aggregateId: refund.returnId,
    producerModule: PRODUCER_MODULE,
    correlationId: params.correlationId,
    actorTenantUserId: params.actorTenantUserId,
    payload: {
      refundId: refund.id,
      returnId: refund.returnId,
      orderId: header.id,
      allocationId: refund.allocationId,
      reversalAllocationId: refund.reversalAllocationId,
      tenderType: refund.tenderType,
      destination: refund.destination,
      amount: refund.amount,
      settledVia
    }
  });

  return { kind: "settled", refund, storeCredit };
}
