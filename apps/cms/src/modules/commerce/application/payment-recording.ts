/**
 * Owner-side payment recording (Issue #285, ADR-0025): the two idempotent
 * mutations behind `POST /api/v1/commerce/orders/{id}/payments` and
 * `POST .../payments/{paymentId}/reversals`. This file composes the ledger
 * primitives (`payment-allocation-directory.ts`) with the order-status
 * machine's release (`order-directory.ts`'s `makeOrderRelease`) and the shared
 * `awcms_idempotency_keys` store — kept apart from the primitives because the
 * primitives must not import `order-directory.ts` (the confirmation/gateway
 * paths in that file import them).
 *
 * ## Idempotency (skill `awcms-idempotency`)
 *
 * Two independent layers, deliberately:
 *
 *   1. The shared store, scoped `commerce.payments.record` /
 *      `commerce.payments.reverse` — `(tenant, scope, Idempotency-Key)`. Same
 *      key + same payload replays the stored response (HTTP replay, a client
 *      retry); same key + a different payload is
 *      `IdempotencyPayloadMismatchError` (409 `IDEMPOTENCY_CONFLICT`). The
 *      acting tenant user AND the resource ids are part of the hashed payload
 *      ("bind the hash to the resource"): another cashier reusing the key, or
 *      the same key aimed at another order, can never replay this response.
 *   2. The ledger's own `UNIQUE (tenant_id, source_key)` (`api:{key}` /
 *      `reversal:{key}`), the second guard that holds even if the store row
 *      were lost.
 */
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../_shared/idempotency";
import type {
  RecordPaymentInput,
  RecordReversalInput,
  SettlementView
} from "../domain/payment-allocation";
import {
  IdempotencyPayloadMismatchError,
  makeOrderRelease
} from "./order-directory";
import {
  recordPaymentAllocation,
  recordPaymentReversal,
  type PaymentAllocationRecord
} from "./payment-allocation-directory";

const RECORD_SCOPE = "commerce.payments.record";
const REVERSE_SCOPE = "commerce.payments.reverse";

/** The order statuses an operator may still record money in: everything but the two dead ends. */
const RECORDABLE_ORDER_STATUSES = [
  "pending_payment",
  "paid",
  "processing",
  "shipped",
  "completed"
] as const;

/** The 201 body of both mutations. */
export type PaymentMutationRecord = {
  payment: PaymentAllocationRecord;
  settlement: SettlementView;
};

export type RecordOwnerPaymentOutcome =
  | { kind: "order_not_found" }
  | { kind: "order_not_payable"; orderStatus: string }
  | { kind: "created" | "replayed"; body: PaymentMutationRecord };

/**
 * @throws {IdempotencyPayloadMismatchError} same key, different payload.
 * @throws {OverpaymentError} the amount exceeds what is still owed.
 */
export async function recordOwnerPayment(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  orderId: string,
  input: RecordPaymentInput,
  correlationId?: string
): Promise<RecordOwnerPaymentOutcome> {
  const requestHash = computeRequestHash({
    action: RECORD_SCOPE,
    actorTenantUserId,
    orderId,
    tenderType: input.tenderType,
    amount: input.amount,
    reference: input.reference,
    note: input.note
  });

  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    RECORD_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      body: existing.responseBody as PaymentMutationRecord
    };
  }

  const isCash = input.tenderType === "cash";
  const outcome = await recordPaymentAllocation(tx, tenantId, {
    orderId,
    tenderType: input.tenderType,
    amount: input.amount,
    ...(isCash ? { cashHanded: input.amount } : {}),
    providerReference: input.reference,
    note: input.note,
    source: "admin",
    sourceKey: `api:${input.idempotencyKey}`,
    actor: { kind: "tenant_user", tenantUserId: actorTenantUserId },
    enforceNoOverpayment: true,
    allowedOrderStatuses: RECORDABLE_ORDER_STATUSES,
    release: makeOrderRelease(
      tx,
      tenantId,
      "admin",
      actorTenantUserId,
      orderId,
      correlationId
    ),
    releaseNote: "Payment recorded — order settled.",
    correlationId
  });

  if (outcome.kind === "order_not_found") return { kind: "order_not_found" };
  if (outcome.kind === "order_not_payable") {
    return { kind: "order_not_payable", orderStatus: outcome.orderStatus };
  }
  if (outcome.kind === "nothing_to_settle") {
    // Unreachable: this call never sets `clampToOutstanding`.
    throw new Error("Unexpected nothing_to_settle outcome.");
  }

  const body: PaymentMutationRecord = {
    payment: outcome.allocation,
    settlement: outcome.settlement
  };

  if (outcome.kind === "deduplicated") {
    // The ledger row exists but the idempotency store has no record (the key
    // was reused after the store row aged out, or the first request's store
    // write was the part that failed): answer with the row, do not insert twice.
    return { kind: "replayed", body };
  }

  await saveIdempotencyRecord(
    tx,
    tenantId,
    RECORD_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    body
  );
  return { kind: "created", body };
}

export type RecordOwnerReversalOutcome =
  | { kind: "not_found" }
  | { kind: "register_session_not_found" }
  | { kind: "register_session_not_open"; status: string }
  | { kind: "register_session_not_cashier" }
  | {
      kind: "not_reversible";
      reason: "not_a_payment" | "not_succeeded" | "fully_reversed";
    }
  | { kind: "created" | "replayed"; body: PaymentMutationRecord };

/**
 * @throws {IdempotencyPayloadMismatchError} same key, different payload.
 * @throws {ReversalExceedsPaymentError} `amount` > what remains reversible.
 */
export async function recordOwnerReversal(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  orderId: string,
  paymentId: string,
  input: RecordReversalInput,
  correlationId?: string
): Promise<RecordOwnerReversalOutcome> {
  const requestHash = computeRequestHash({
    action: REVERSE_SCOPE,
    actorTenantUserId,
    orderId,
    paymentId,
    amount: input.amount,
    note: input.note,
    // Only when present, so a pre-existing payload hashes exactly as before.
    ...(input.registerSessionId
      ? { registerSessionId: input.registerSessionId }
      : {})
  });

  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    REVERSE_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      body: existing.responseBody as PaymentMutationRecord
    };
  }

  const outcome = await recordPaymentReversal(tx, tenantId, {
    orderId,
    allocationId: paymentId,
    amount: input.amount,
    note: input.note,
    sourceKey: `reversal:${input.idempotencyKey}`,
    actor: { kind: "tenant_user", tenantUserId: actorTenantUserId },
    registerSessionId: input.registerSessionId,
    correlationId
  });

  if (outcome.kind === "not_found") return { kind: "not_found" };
  if (
    outcome.kind === "register_session_not_found" ||
    outcome.kind === "register_session_not_open" ||
    outcome.kind === "register_session_not_cashier"
  ) {
    return outcome;
  }
  if (outcome.kind === "not_reversible") {
    return { kind: "not_reversible", reason: outcome.reason };
  }

  const body: PaymentMutationRecord = {
    payment: outcome.allocation,
    settlement: outcome.settlement
  };
  if (outcome.kind === "deduplicated") return { kind: "replayed", body };

  await saveIdempotencyRecord(
    tx,
    tenantId,
    REVERSE_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    body
  );
  return { kind: "created", body };
}
