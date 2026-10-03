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
  isStoredValueTender,
  hashStoredValueCode
} from "../domain/stored-value";
import { FeatureDisabledError } from "../domain/commerce-features";
import { fetchCommerceFeatures } from "./commerce-feature-gate";
import {
  refusalToError,
  resolveStoredValueAccounts
} from "./stored-value-tender";
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
    note: input.note,
    // Issue #288 - the plaintext code never enters the hash; `undefined`
    // drops out, so a payload without one hashes exactly as before.
    storedValueCodeHash: input.storedValueCode
      ? hashStoredValueCode(tenantId, input.storedValueCode)
      : undefined
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

  // Issue #288 (ADR-0030) - a stored-value tender names its account by code;
  // resolve it (throttled, one neutral not-found for every failure) before
  // the ledger takes the order lock.
  let storedValueAccountId: string | null = null;
  if (isStoredValueTender(input.tenderType)) {
    const features = await fetchCommerceFeatures(tx, tenantId);
    if (!features.storedValue) throw new FeatureDisabledError("storedValue");
    const resolved = await resolveStoredValueAccounts(
      tx,
      tenantId,
      actorTenantUserId,
      [{ tenderType: input.tenderType, code: input.storedValueCode ?? "" }]
    );
    storedValueAccountId = resolved[0] ?? null;
  }

  const outcome = await recordPaymentAllocation(tx, tenantId, {
    orderId,
    tenderType: input.tenderType,
    amount: input.amount,
    ...(isCash ? { cashHanded: input.amount } : {}),
    storedValueAccountId,
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
  if (outcome.kind === "stored_value_refused") {
    // Nothing was written (the ledger decides before it inserts), so the
    // typed error maps to a plain response with no partial state to commit.
    throw refusalToError(outcome.refusal, outcome.available, input.amount);
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
  | {
      kind: "not_reversible";
      reason:
        | "not_a_payment"
        | "not_succeeded"
        | "fully_reversed"
        | "stored_value_refund_not_allowed"
        | "stored_value_account_unavailable";
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
    note: input.note
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
    correlationId
  });

  if (outcome.kind === "not_found") return { kind: "not_found" };
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
