/**
 * Executing a gateway refund leg, and settling one by an authorised operator's
 * attestation (Issue #287, ADR-0033 D6).
 *
 * ## The provider call is outside every transaction
 *
 * ADR-0006/0010/0017 D1: an external provider call never runs inside an open
 * DB transaction. `executeGatewayRefund` follows the three-step shape
 * `payment-gateway-directory.ts` established:
 *
 *   1. a SHORT transaction: lock the order, read the leg, mark it
 *      `processing` (attempt counter, provider reference), commit;
 *   2. the provider call, with NO transaction open;
 *   3. a SECOND short transaction: lock the order again, re-read the leg, and
 *      either settle it (`refund-settlement.ts`) or record the failure.
 *
 * Both transactions take the raw pool client, never a caller's open `tx`. The
 * route's own transaction is the authorisation chokepoint (it is read-only and
 * idle while the provider is called - the `payment-gateway/reconcile` route's
 * precedent).
 *
 * ## Idempotent, replayable, and honest about the unknown
 *
 * The provider is given the refund row's id as its idempotency key on EVERY
 * attempt, so a retry after a timeout or a crash between steps 1 and 3 asks
 * the provider again and gets the same answer instead of refunding twice. A
 * leg left `processing` (the process died, or the provider answered
 * "accepted, pending") is simply executed again; a leg that finds itself
 * already `succeeded` when step 3 takes the lock reports that and writes
 * nothing. A transport error is recorded as `failed` with a short machine code
 * and is retryable - never as "refunded".
 *
 * ## The offline path
 *
 * When there is no adapter, the adapter has no `refund`, or the provider
 * refuses, the refund can still be made outside the system (a bank transfer
 * from the provider's dashboard). `settleRefundOffline` books that fact; it
 * needs its OWN permission (`commerce.refunds_offline.approve`, a high-risk
 * verb a tenant can put under separation-of-duties rules) and a stated reason,
 * both stored on the leg. It is the operator's attestation that the money has
 * gone back - and, for a leg whose provider call may still be in flight, their
 * responsibility not to refund twice.
 */
import { withTenantOrThrow } from "../../../lib/database/tenant-context";
import type { PaymentGatewayProvider } from "../domain/payment-gateway-provider";
import { fetchCommerceFeatures } from "./commerce-feature-gate";
import { lockOrderForSettlement } from "./payment-allocation-directory";
import {
  fetchRefundForReturn,
  REFUND_COLUMNS,
  toRefundRecord,
  type RefundRecord,
  type RefundRow
} from "./return-records";
import {
  settleRefundLeg,
  type IssuedStoreCredit,
  type SettleRefundRefusal
} from "./refund-settlement";

export type ExecuteRefundDeps = {
  provider: PaymentGatewayProvider | null;
  now?: () => Date;
};

export type ExecuteRefundOutcome =
  | { kind: "feature_disabled" }
  | { kind: "not_found" }
  | { kind: "refused"; refusal: SettleRefundRefusal }
  | { kind: "already_settled"; refund: RefundRecord }
  /** No gateway adapter is configured, or it cannot refund: settle the leg offline. */
  | { kind: "provider_unavailable"; refund: RefundRecord }
  /** The provider accepted the refund and will settle it later; execute again to ask. */
  | { kind: "processing"; refund: RefundRecord }
  | { kind: "failed"; refund: RefundRecord; failureCode: string }
  | {
      kind: "settled";
      refund: RefundRecord;
      storeCredit: IssuedStoreCredit | null;
    };

type LegRow = RefundRow & {
  provider: string | null;
  provider_reference: string | null;
};

type AllocationFacts = {
  provider: string | null;
  provider_reference: string | null;
};

/** Marks the leg `failed` with a short code (retryable). */
async function markFailed(
  tx: Bun.SQL,
  tenantId: string,
  refundId: string,
  failureCode: string
): Promise<RefundRecord> {
  const rows = (await tx`
    UPDATE awcms_commerce_refunds
    SET status = 'failed', failure_code = ${failureCode.slice(0, 80)}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${refundId} AND status <> 'succeeded'
    RETURNING ${tx.unsafe(REFUND_COLUMNS)}
  `) as RefundRow[];
  return toRefundRecord(rows[0]!);
}

/**
 * Executes the refund leg `refundId` of return `returnId`: a gateway leg goes
 * to the provider (outside any transaction); any other still-open leg is
 * settled in the ledger straight away. `sql` is the pool client.
 */
export async function executeRefund(
  sql: Bun.SQL,
  tenantId: string,
  params: {
    returnId: string;
    refundId: string;
    actorTenantUserId: string;
    registerSessionId: string | null;
    correlationId?: string;
  },
  deps: ExecuteRefundDeps
): Promise<ExecuteRefundOutcome> {
  const now = deps.now ?? (() => new Date());

  // --- 1: claim -------------------------------------------------------------
  type Claim =
    | { kind: "done"; outcome: ExecuteRefundOutcome }
    | {
        kind: "call";
        providerRef: string;
        amount: string;
        refund: RefundRecord;
      };
  const claim = await withTenantOrThrow<Claim>(sql, tenantId, async (tx) => {
    const features = await fetchCommerceFeatures(tx, tenantId);
    if (!features.returns) {
      return { kind: "done", outcome: { kind: "feature_disabled" } };
    }
    const existing = await fetchRefundForReturn(
      tx,
      tenantId,
      params.returnId,
      params.refundId
    );
    if (!existing) return { kind: "done", outcome: { kind: "not_found" } };
    const header = await lockOrderForSettlement(tx, tenantId, existing.orderId);
    if (!header) return { kind: "done", outcome: { kind: "not_found" } };

    const rows = (await tx`
      SELECT ${tx.unsafe(REFUND_COLUMNS)}, provider, provider_reference
      FROM awcms_commerce_refunds
      WHERE tenant_id = ${tenantId} AND id = ${params.refundId}
      FOR UPDATE
    `) as LegRow[];
    const leg = rows[0]!;
    if (leg.status === "succeeded") {
      return {
        kind: "done",
        outcome: { kind: "already_settled", refund: toRefundRecord(leg) }
      };
    }

    // A leg that is not a gateway payment has nothing to ask a provider.
    if (leg.tender_type !== "gateway") {
      const settled = await settleRefundLeg(tx, tenantId, {
        refundId: params.refundId,
        actorTenantUserId: params.actorTenantUserId,
        via: "auto",
        registerSessionId: params.registerSessionId,
        now: now(),
        correlationId: params.correlationId
      });
      return { kind: "done", outcome: settledToOutcome(settled) };
    }

    if (!deps.provider || typeof deps.provider.refund !== "function") {
      return {
        kind: "done",
        outcome: { kind: "provider_unavailable", refund: toRefundRecord(leg) }
      };
    }

    const facts = (await tx`
      SELECT provider, provider_reference
      FROM awcms_commerce_payment_allocations
      WHERE tenant_id = ${tenantId} AND id = ${leg.allocation_id}
    `) as AllocationFacts[];
    const reference = facts[0]?.provider_reference ?? null;
    if (!reference) {
      // A gateway leg with no provider reference cannot be refunded through
      // the API at all; say so and leave the offline path open.
      const failed = await markFailed(
        tx,
        tenantId,
        params.refundId,
        "NO_PROVIDER_REFERENCE"
      );
      return {
        kind: "done",
        outcome: {
          kind: "failed",
          refund: failed,
          failureCode: "NO_PROVIDER_REFERENCE"
        }
      };
    }

    const updated = (await tx`
      UPDATE awcms_commerce_refunds
      SET status = 'processing', attempts = attempts + 1,
          provider = ${facts[0]?.provider ?? null}, provider_reference = ${reference},
          failure_code = NULL, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${params.refundId}
      RETURNING ${tx.unsafe(REFUND_COLUMNS)}
    `) as RefundRow[];
    return {
      kind: "call",
      providerRef: reference,
      amount: toRefundRecord(updated[0]!).amount,
      refund: toRefundRecord(updated[0]!)
    };
  });
  if (claim.kind === "done") return claim.outcome;

  // --- 2: the provider, NO transaction open ----------------------------------
  let result: Awaited<
    ReturnType<NonNullable<PaymentGatewayProvider["refund"]>>
  > | null = null;
  let transportFailure: string | null = null;
  try {
    result = await deps.provider!.refund!({
      providerRef: claim.providerRef,
      amount: claim.amount,
      refundKey: params.refundId,
      reason: "Order refund"
    });
  } catch {
    // Timeout, circuit open, unparseable body: the outcome is UNKNOWN. Record
    // a retryable failure - the provider key makes the retry safe.
    transportFailure = "PROVIDER_ERROR";
  }

  // --- 3: record the outcome --------------------------------------------------
  return withTenantOrThrow<ExecuteRefundOutcome>(sql, tenantId, async (tx) => {
    const header = await lockOrderForSettlement(
      tx,
      tenantId,
      claim.refund.orderId
    );
    if (!header) return { kind: "not_found" };
    const rows = (await tx`
      SELECT ${tx.unsafe(REFUND_COLUMNS)}
      FROM awcms_commerce_refunds
      WHERE tenant_id = ${tenantId} AND id = ${params.refundId}
      FOR UPDATE
    `) as RefundRow[];
    const leg = rows[0]!;
    if (leg.status === "succeeded") {
      return { kind: "already_settled", refund: toRefundRecord(leg) };
    }

    if (result && result.status === "succeeded") {
      const settled = await settleRefundLeg(tx, tenantId, {
        refundId: params.refundId,
        actorTenantUserId: params.actorTenantUserId,
        via: "provider",
        providerRefundId: result.providerRefundId,
        now: now(),
        correlationId: params.correlationId
      });
      if (settled.kind === "refused") {
        // The provider has the money moving but the ledger will not book it
        // (the payment was reversed by hand in the meantime). Surface it as a
        // failure an operator must resolve; never swallow it.
        const failed = await markFailed(
          tx,
          tenantId,
          params.refundId,
          "PROVIDER_REFUNDED_LEDGER_REFUSED"
        );
        return {
          kind: "failed",
          refund: failed,
          failureCode: "PROVIDER_REFUNDED_LEDGER_REFUSED"
        };
      }
      return settledToOutcome(settled);
    }
    if (result && result.status === "pending") {
      return { kind: "processing", refund: toRefundRecord(leg) };
    }
    const code = transportFailure ?? result?.failureCode ?? "PROVIDER_REFUSED";
    const failed = await markFailed(tx, tenantId, params.refundId, code);
    return { kind: "failed", refund: failed, failureCode: code };
  });
}

function settledToOutcome(
  settled: Awaited<ReturnType<typeof settleRefundLeg>>
): ExecuteRefundOutcome {
  if (settled.kind === "settled") {
    return {
      kind: "settled",
      refund: settled.refund,
      storeCredit: settled.storeCredit
    };
  }
  if (settled.kind === "already_settled") {
    return { kind: "already_settled", refund: settled.refund };
  }
  if (settled.kind === "refused") {
    return { kind: "refused", refusal: settled.refusal };
  }
  return { kind: "not_found" };
}

export type OfflineRefundOutcome =
  | { kind: "feature_disabled" }
  | { kind: "not_found" }
  | { kind: "refused"; refusal: SettleRefundRefusal }
  | { kind: "already_settled"; refund: RefundRecord }
  | { kind: "settled"; refund: RefundRecord };

/**
 * Settles the leg as a refund made OUTSIDE the system, on the authority of the
 * caller (who the route has already authorised for
 * `commerce.refunds_offline.approve` and `commerce.payments.revoke`). Runs in
 * the caller's transaction: it makes no network call.
 */
export async function settleRefundOffline(
  tx: Bun.SQL,
  tenantId: string,
  params: {
    returnId: string;
    refundId: string;
    actorTenantUserId: string;
    reason: string;
    now: Date;
    correlationId?: string;
  }
): Promise<OfflineRefundOutcome> {
  const features = await fetchCommerceFeatures(tx, tenantId);
  if (!features.returns) return { kind: "feature_disabled" };
  const existing = await fetchRefundForReturn(
    tx,
    tenantId,
    params.returnId,
    params.refundId
  );
  if (!existing) return { kind: "not_found" };

  const settled = await settleRefundLeg(tx, tenantId, {
    refundId: params.refundId,
    actorTenantUserId: params.actorTenantUserId,
    via: "offline",
    offlineReason: params.reason,
    now: params.now,
    correlationId: params.correlationId
  });
  if (settled.kind === "settled") {
    return { kind: "settled", refund: settled.refund };
  }
  if (settled.kind === "already_settled") {
    return { kind: "already_settled", refund: settled.refund };
  }
  if (settled.kind === "refused") {
    return { kind: "refused", refusal: settled.refusal };
  }
  return { kind: "not_found" };
}
