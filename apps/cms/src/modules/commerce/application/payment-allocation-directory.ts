/**
 * Payment-allocation ledger — the SQL half of Issue #285 (epic #281,
 * ADR-0025). `domain/payment-allocation.ts` decides what a set of ledger rows
 * MEANS; this file stores them, sums them, and keeps the order's cached
 * `payment_status` honest. Every function takes the caller's tenant
 * transaction (`tx`, RLS scoped, `app.current_tenant_id` already set) and
 * makes NO provider/network call (ADR-0006: provider calls never sit inside
 * a DB transaction) — the gateway legs are only ever RESOLVED here from a
 * status another path already obtained.
 *
 * ## The one write path, and the order-row lock
 *
 * Every function that adds a ledger row first locks the ORDER row
 * (`SELECT ... FOR UPDATE`), then reads the ledger, validates, inserts,
 * recomputes. The lock is what makes two genuinely concurrent "final
 * allocation" requests safe: the second waits for the first to commit, then
 * sees the first's row, and its own overpayment check fails — it can never
 * over-settle an order, nor release it twice. Lock order is always
 * order -> ledger rows, in every function, so two paths can never deadlock
 * each other. The unique `(tenant_id, source_key)` index is the independent
 * second guard (`sql/940`): even a bug that skipped the lock cannot insert
 * the same logical payment twice.
 *
 * ## Order lifecycle stays the order-status machine's business
 *
 * When settlement reaches the order's release threshold
 * ({@link hasReachedRelease}), the order must move `pending_payment ->
 * paid`. This file does NOT fork that transition: it is handed a
 * {@link ReleaseOrderFn} by the caller (always a thin wrapper over
 * `order-directory.ts`'s `transitionOrderStatus`, so the status timestamp,
 * `order_events` row, audit event and `order.paid`/`order.status_changed`
 * domain events are exactly the ones every other path produces). Taking it as
 * a parameter — rather than importing `order-directory.ts` — keeps the import
 * graph one-way (`order-directory` imports this file for the confirmation /
 * gateway paths).
 *
 * ## Reversals never move the lifecycle backwards
 *
 * A reversal lowers `settled` and re-derives `payment_status`
 * (`paid -> partially_paid`, or `refunded` when everything went back); the
 * order stays `paid`/`processing`/... Cancelling fulfilment because money
 * went back is a human decision (`domain/order-status.ts`'s header).
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  fromCents,
  normalizeMoney,
  toCents
} from "../domain/price-calculation";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_ORDER_AGGREGATE_TYPE,
  COMMERCE_PAYMENT_RECORDED_EVENT_TYPE,
  COMMERCE_PAYMENT_REVERSED_EVENT_TYPE
} from "../domain/commerce-events";
import {
  computeSettlement,
  derivePaymentStatus,
  hasReachedRelease,
  OverpaymentError,
  toSettlementView,
  type LedgerRow,
  type PaymentAllocationKind,
  type PaymentAllocationSource,
  type PaymentAllocationStatus,
  type PaymentTenderType,
  type Settlement,
  type SettlementPaymentStatus,
  type SettlementView
} from "../domain/payment-allocation";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "payment_allocation";
const PRODUCER_MODULE = "commerce";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Who recorded the leg: a tenant user (staff), or the platform itself (webhook/reconcile/backfill). */
export type AllocationActor =
  { kind: "tenant_user"; tenantUserId: string } | { kind: "system" };

/** Moves the order `pending_payment -> paid` through the order-status machine; supplied by the caller. */
export type ReleaseOrderFn = (note: string) => Promise<void>;

export type PaymentAllocationRecord = {
  id: string;
  orderId: string;
  kind: PaymentAllocationKind;
  reversesAllocationId: string | null;
  tenderType: PaymentTenderType;
  /** Applied to the order, `numeric(14,2)` string. */
  amount: string;
  status: PaymentAllocationStatus;
  provider: string | null;
  providerReference: string | null;
  /** Cash leg only. */
  tenderedAmount: string | null;
  /** Cash leg only. */
  changeAmount: string | null;
  note: string | null;
  source: PaymentAllocationSource;
  actorKind: "tenant_user" | "system";
  actorTenantUserId: string | null;
  createdAt: string;
  settledAt: string | null;
};

type AllocationRow = {
  id: string;
  order_id: string;
  kind: string;
  reverses_allocation_id: string | null;
  tender_type: string;
  amount: string;
  status: string;
  provider: string | null;
  provider_reference: string | null;
  tendered_amount: string | null;
  change_amount: string | null;
  note: string | null;
  source: string;
  actor_kind: string;
  actor_tenant_user_id: string | null;
  created_at: Date;
  settled_at: Date | null;
};

const ALLOCATION_COLUMNS = `id, order_id, kind, reverses_allocation_id, tender_type, amount, status,
  provider, provider_reference, tendered_amount, change_amount, note, source,
  actor_kind, actor_tenant_user_id, created_at, settled_at`;

function toRecord(row: AllocationRow): PaymentAllocationRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    kind: row.kind as PaymentAllocationKind,
    reversesAllocationId: row.reverses_allocation_id,
    tenderType: row.tender_type as PaymentTenderType,
    amount: normalizeMoney(row.amount),
    status: row.status as PaymentAllocationStatus,
    provider: row.provider,
    providerReference: row.provider_reference,
    tenderedAmount:
      row.tendered_amount !== null ? normalizeMoney(row.tendered_amount) : null,
    changeAmount:
      row.change_amount !== null ? normalizeMoney(row.change_amount) : null,
    note: row.note,
    source: row.source as PaymentAllocationSource,
    actorKind: row.actor_kind as "tenant_user" | "system",
    actorTenantUserId: row.actor_tenant_user_id,
    createdAt: row.created_at.toISOString(),
    settledAt: row.settled_at ? row.settled_at.toISOString() : null
  };
}

type OrderLedgerHeader = {
  id: string;
  orderCode: string;
  status: string;
  total: string;
  paymentMethod: string;
  dpAmount: string | null;
  paymentStatus: string;
};

/**
 * Locks the order row and returns the columns settlement needs.
 *
 * `FOR NO KEY UPDATE`, deliberately NOT `FOR UPDATE`: every child insert that
 * has a foreign key to the order (a `payment_events` row, a ledger row)
 * takes `FOR KEY SHARE` on it, which `FOR UPDATE` conflicts with. The webhook
 * path inserts its event row (key-share on the order) and updates the gateway
 * session BEFORE it reaches this lock, so a concurrent delivery holding the
 * session row while waiting for a full `FOR UPDATE` against the first one's
 * key-share is a textbook deadlock — found by the genuinely-concurrent
 * webhook test. `FOR NO KEY UPDATE` still conflicts with itself (so ledger
 * writers serialise, which is the whole point) and with a plain `UPDATE` of
 * the row, but coexists with key-share, so FK checks never block it.
 * `null` for an unknown/soft-deleted/other-tenant order (RLS + the explicit
 * `tenant_id` filter) — one answer for all three, never distinguishable.
 */
export async function lockOrderForSettlement(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<OrderLedgerHeader | null> {
  const rows = (await tx`
    SELECT id, order_code, status, total, payment_method, dp_amount, payment_status
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${orderId} AND deleted_at IS NULL
    FOR NO KEY UPDATE
  `) as {
    id: string;
    order_code: string;
    status: string;
    total: string;
    payment_method: string;
    dp_amount: string | null;
    payment_status: string;
  }[];
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    orderCode: row.order_code,
    status: row.status,
    total: normalizeMoney(row.total),
    paymentMethod: row.payment_method,
    dpAmount: row.dp_amount !== null ? normalizeMoney(row.dp_amount) : null,
    paymentStatus: row.payment_status
  };
}

async function readLedgerRows(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<LedgerRow[]> {
  const rows = (await tx`
    SELECT kind, status, amount
    FROM awcms_commerce_payment_allocations
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
  `) as { kind: string; status: string; amount: string }[];
  return rows.map((row) => ({
    kind: row.kind as PaymentAllocationKind,
    status: row.status as PaymentAllocationStatus,
    amount: normalizeMoney(row.amount)
  }));
}

function settlementOf(
  header: OrderLedgerHeader,
  rows: readonly LedgerRow[]
): { settlement: Settlement; paymentStatus: SettlementPaymentStatus } {
  const settlement = computeSettlement(header.total, rows);
  return {
    settlement,
    paymentStatus: derivePaymentStatus(settlement, header)
  };
}

/**
 * Re-derives the order's settlement from the ledger, moves the lifecycle to
 * `paid` when the release threshold has been reached, and writes the cached
 * `payment_status`. Caller MUST hold the order-row lock.
 */
async function finalizeSettlement(
  tx: Bun.SQL,
  tenantId: string,
  header: OrderLedgerHeader,
  release: ReleaseOrderFn | null,
  releaseNote: string
): Promise<{ view: SettlementView; released: boolean }> {
  const rows = await readLedgerRows(tx, tenantId, header.id);
  const { settlement, paymentStatus } = settlementOf(header, rows);

  let released = false;
  if (
    release &&
    header.status === "pending_payment" &&
    hasReachedRelease(settlement, header)
  ) {
    await release(releaseNote);
    released = true;
  }

  // After the (possible) release: the order-status machine stamps
  // `payment_status = 'paid'` on `-> paid`, which is wrong for a down-payment
  // release; the ledger derivation is the authority, so it always has the
  // last word on the cached column.
  await tx`
    UPDATE awcms_commerce_orders
    SET payment_status = ${paymentStatus}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${header.id}
      AND payment_status IS DISTINCT FROM ${paymentStatus}
  `;

  return { view: toSettlementView(settlement, paymentStatus), released };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listAllocationsForOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<PaymentAllocationRecord[]> {
  const rows = (await tx`
    SELECT ${tx.unsafe(ALLOCATION_COLUMNS)}
    FROM awcms_commerce_payment_allocations
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
    ORDER BY created_at ASC, id ASC
  `) as AllocationRow[];
  return rows.map(toRecord);
}

export type OrderPaymentSummary = {
  orderId: string;
  orderCode: string;
  orderStatus: string;
  settlement: SettlementView;
  allocations: PaymentAllocationRecord[];
};

/** `null` when the order does not exist for this tenant (one answer for unknown/other-tenant — BOLA). */
export async function fetchOrderPaymentSummary(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<OrderPaymentSummary | null> {
  const orderRows = (await tx`
    SELECT id, order_code, status, total, payment_method, dp_amount, payment_status
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${orderId} AND deleted_at IS NULL
  `) as {
    id: string;
    order_code: string;
    status: string;
    total: string;
    payment_method: string;
    dp_amount: string | null;
    payment_status: string;
  }[];
  const order = orderRows[0];
  if (!order) return null;

  const header: OrderLedgerHeader = {
    id: order.id,
    orderCode: order.order_code,
    status: order.status,
    total: normalizeMoney(order.total),
    paymentMethod: order.payment_method,
    dpAmount: order.dp_amount !== null ? normalizeMoney(order.dp_amount) : null,
    paymentStatus: order.payment_status
  };
  const allocations = await listAllocationsForOrder(tx, tenantId, orderId);
  const { settlement, paymentStatus } = settlementOf(
    header,
    allocations.map((a) => ({
      kind: a.kind,
      status: a.status,
      amount: a.amount
    }))
  );
  return {
    orderId: order.id,
    orderCode: order.order_code,
    orderStatus: order.status,
    settlement: toSettlementView(settlement, paymentStatus),
    allocations
  };
}

/**
 * The settlement of an order WITHOUT a lock — for a caller that only needs
 * to decide something (e.g. the admin "mark paid" gate) inside a transaction
 * that will not write a ledger row. Anything that goes on to write must use
 * {@link lockOrderForSettlement} first.
 */
export async function readOrderSettlement(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<{
  view: SettlementView;
  releaseReached: boolean;
} | null> {
  const summary = await fetchOrderPaymentSummary(tx, tenantId, orderId);
  if (!summary) return null;
  const orderRows = (await tx`
    SELECT total, payment_method, dp_amount
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${orderId}
  `) as { total: string; payment_method: string; dp_amount: string | null }[];
  const order = orderRows[0]!;
  const settlement = computeSettlement(
    normalizeMoney(order.total),
    summary.allocations.map((a) => ({
      kind: a.kind,
      status: a.status,
      amount: a.amount
    }))
  );
  return {
    view: summary.settlement,
    releaseReached: hasReachedRelease(settlement, {
      total: normalizeMoney(order.total),
      paymentMethod: order.payment_method,
      dpAmount:
        order.dp_amount !== null ? normalizeMoney(order.dp_amount) : null
    })
  };
}

// ---------------------------------------------------------------------------
// Record a payment
// ---------------------------------------------------------------------------

export type RecordPaymentAllocationParams = {
  orderId: string;
  tenderType: PaymentTenderType;
  /** Applied to the order, `numeric(14,2)` string, > 0. */
  amount: string;
  provider?: string | null;
  providerReference?: string | null;
  /** Cash leg only; with `changeAmount`, `tendered = amount + change` (a CHECK on the table). */
  tenderedAmount?: string | null;
  changeAmount?: string | null;
  /**
   * Owner-side cash leg: the amount the customer HANDED OVER. When set,
   * `amount`/`tenderedAmount`/`changeAmount` are derived under the lock (see
   * the body) and the `amount` passed in is ignored. Only for `cash`.
   */
  cashHanded?: string;
  note?: string | null;
  source: PaymentAllocationSource;
  /** Row-level idempotency key — unique per tenant (see `sql/940`). */
  sourceKey: string;
  actor: AllocationActor;
  /**
   * `true` for an operator-entered tender (reject anything above what is
   * still owed). `false` ONLY for an externally-confirmed fact (a gateway
   * leg the provider already captured): the money exists whether or not the
   * order still wanted it, so it is recorded and the excess surfaces as
   * `overpaid` for an operator to refund via a reversal, rather than
   * silently dropped.
   */
  enforceNoOverpayment: boolean;
  /**
   * `true` for an operator ACCEPTING an amount a customer reported (a
   * manual-transfer confirmation): the applied amount is capped at what is
   * still owed instead of rejecting the acceptance, and the cap is stated in
   * the ledger row's `note` (a customer who transfers a rounded-up amount
   * must not leave the operator unable to accept it). When nothing is owed at
   * all the outcome is `nothing_to_settle` and no row is written.
   */
  clampToOutstanding?: boolean;
  /** Order statuses this payment may be recorded in; `null` = any. */
  allowedOrderStatuses: readonly string[] | null;
  release: ReleaseOrderFn | null;
  releaseNote: string;
  correlationId?: string;
};

export type RecordPaymentAllocationOutcome =
  | { kind: "order_not_found" }
  | { kind: "order_not_payable"; orderStatus: string }
  | { kind: "nothing_to_settle"; settlement: SettlementView }
  | {
      kind: "deduplicated";
      allocation: PaymentAllocationRecord;
      settlement: SettlementView;
    }
  | {
      kind: "recorded";
      allocation: PaymentAllocationRecord;
      settlement: SettlementView;
      released: boolean;
    };

export class AllocationSourceKeyConflictError extends Error {
  constructor() {
    super("The source key was already used for a different order.");
    this.name = "AllocationSourceKeyConflictError";
  }
}

async function findAllocationBySourceKey(
  tx: Bun.SQL,
  tenantId: string,
  sourceKey: string
): Promise<PaymentAllocationRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(ALLOCATION_COLUMNS)}
    FROM awcms_commerce_payment_allocations
    WHERE tenant_id = ${tenantId} AND source_key = ${sourceKey}
  `) as AllocationRow[];
  return rows[0] ? toRecord(rows[0]) : null;
}

function actorColumns(actor: AllocationActor): {
  kind: "tenant_user" | "system";
  tenantUserId: string | null;
} {
  return actor.kind === "tenant_user"
    ? { kind: "tenant_user", tenantUserId: actor.tenantUserId }
    : { kind: "system", tenantUserId: null };
}

async function announcePayment(
  tx: Bun.SQL,
  tenantId: string,
  header: OrderLedgerHeader,
  allocation: PaymentAllocationRecord,
  view: SettlementView,
  actor: AllocationActor,
  message: string,
  correlationId: string | undefined
): Promise<void> {
  const actorTenantUserId =
    actor.kind === "tenant_user" ? actor.tenantUserId : undefined;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action:
      allocation.kind === "reversal" ? "payment.reverse" : "payment.record",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: allocation.id,
    message,
    // Money, tender and ids only — never the customer's name/phone, never the
    // free-text payment reference (a bank/QRIS reference can identify a person).
    attributes: {
      orderId: header.id,
      orderCode: header.orderCode,
      allocationId: allocation.id,
      reversesAllocationId: allocation.reversesAllocationId,
      kind: allocation.kind,
      tenderType: allocation.tenderType,
      amount: allocation.amount,
      source: allocation.source,
      paymentStatus: view.paymentStatus,
      outstanding: view.outstanding
    },
    correlationId
  });

  await appendDomainEvent(tx, tenantId, {
    eventType:
      allocation.kind === "reversal"
        ? COMMERCE_PAYMENT_REVERSED_EVENT_TYPE
        : COMMERCE_PAYMENT_RECORDED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_ORDER_AGGREGATE_TYPE,
    aggregateId: header.id,
    producerModule: PRODUCER_MODULE,
    correlationId,
    actorTenantUserId,
    payload: {
      orderId: header.id,
      orderCode: header.orderCode,
      allocationId: allocation.id,
      ...(allocation.reversesAllocationId
        ? { reversesAllocationId: allocation.reversesAllocationId }
        : {}),
      tenderType: allocation.tenderType,
      amount: allocation.amount,
      source: allocation.source,
      paid: view.paid,
      outstanding: view.outstanding,
      paymentStatus: view.paymentStatus
    }
  });
}

/**
 * Records one `succeeded` payment leg against an order, atomically with the
 * order-row lock described in this file's header, and — when the leg brings
 * the order to its release threshold — moves the order to `paid` through
 * `params.release`.
 *
 * Idempotent on `sourceKey`: a replay returns `{ kind: "deduplicated" }`
 * with the original row and writes nothing. A key already used for a
 * DIFFERENT order is a programming error (`AllocationSourceKeyConflictError`).
 *
 * @throws {OverpaymentError} `enforceNoOverpayment` and `amount` exceeds what is still owed.
 */
export async function recordPaymentAllocation(
  tx: Bun.SQL,
  tenantId: string,
  params: RecordPaymentAllocationParams
): Promise<RecordPaymentAllocationOutcome> {
  const header = await lockOrderForSettlement(tx, tenantId, params.orderId);
  if (!header) return { kind: "order_not_found" };

  const existing = await findAllocationBySourceKey(
    tx,
    tenantId,
    params.sourceKey
  );
  if (existing) {
    if (existing.orderId !== params.orderId) {
      throw new AllocationSourceKeyConflictError();
    }
    const rows = await readLedgerRows(tx, tenantId, header.id);
    const { settlement, paymentStatus } = settlementOf(header, rows);
    return {
      kind: "deduplicated",
      allocation: existing,
      settlement: toSettlementView(settlement, paymentStatus)
    };
  }

  if (
    params.allowedOrderStatuses !== null &&
    !params.allowedOrderStatuses.includes(header.status)
  ) {
    return { kind: "order_not_payable", orderStatus: header.status };
  }

  const beforeLedger = settlementOf(
    header,
    await readLedgerRows(tx, tenantId, header.id)
  );
  const before = beforeLedger.settlement;
  let amount = params.amount;
  let note = params.note ?? null;
  let tenderedAmount = params.tenderedAmount ?? null;
  let changeAmount = params.changeAmount ?? null;
  if (params.cashHanded !== undefined) {
    // The owner-side cash leg: the operator typed what the customer handed
    // over; what is APPLIED and what goes back as change are derived HERE,
    // under the order-row lock, from the cash leg alone (`applied =
    // min(handed, outstanding)`), so a concurrent payment can never turn a
    // correct change figure into a stale one. Nothing owed -> reject: cash
    // against a settled order would be change out of thin air.
    if (params.tenderType !== "cash") {
      throw new RangeError("cashHanded is only valid for a cash tender.");
    }
    if (before.outstandingCents <= 0n) {
      throw new OverpaymentError("0.00", normalizeMoney(params.cashHanded));
    }
    const handed = toCents(params.cashHanded);
    const applied =
      handed >= before.outstandingCents ? before.outstandingCents : handed;
    amount = fromCents(applied);
    tenderedAmount = fromCents(handed);
    changeAmount = fromCents(handed - applied);
  }
  if (params.clampToOutstanding) {
    if (before.outstandingCents <= 0n) {
      return {
        kind: "nothing_to_settle",
        settlement: toSettlementView(before, beforeLedger.paymentStatus)
      };
    }
    if (toCents(amount) > before.outstandingCents) {
      const applied = fromCents(before.outstandingCents);
      note = `Accepted amount ${normalizeMoney(amount)} exceeds the outstanding balance; ${applied} applied.`;
      amount = applied;
    }
  } else if (
    params.enforceNoOverpayment &&
    toCents(amount) > before.outstandingCents
  ) {
    throw new OverpaymentError(
      fromCents(before.outstandingCents),
      normalizeMoney(amount)
    );
  }

  const actor = actorColumns(params.actor);
  const rows = (await tx`
    INSERT INTO awcms_commerce_payment_allocations (
      tenant_id, order_id, kind, tender_type, amount, status,
      provider, provider_reference, tendered_amount, change_amount, note,
      source, source_key, actor_kind, actor_tenant_user_id, settled_at
    )
    VALUES (
      ${tenantId}, ${header.id}, 'payment', ${params.tenderType}, ${amount}, 'succeeded',
      ${params.provider ?? null}, ${params.providerReference ?? null},
      ${tenderedAmount}, ${changeAmount}, ${note},
      ${params.source}, ${params.sourceKey}, ${actor.kind}, ${actor.tenantUserId}, now()
    )
    RETURNING ${tx.unsafe(ALLOCATION_COLUMNS)}
  `) as AllocationRow[];
  const allocation = toRecord(rows[0]!);

  const { view, released } = await finalizeSettlement(
    tx,
    tenantId,
    header,
    params.release,
    params.releaseNote
  );

  await announcePayment(
    tx,
    tenantId,
    header,
    allocation,
    view,
    params.actor,
    `Payment of ${allocation.amount} (${allocation.tenderType}) recorded against order ${header.orderCode}.`,
    params.correlationId
  );

  return { kind: "recorded", allocation, settlement: view, released };
}

// ---------------------------------------------------------------------------
// Gateway legs — pending at checkout, resolved by webhook/reconcile
// ---------------------------------------------------------------------------

export function gatewaySourceKey(
  provider: string,
  providerReference: string
): string {
  return `gateway:${provider}:${providerReference}`;
}

/**
 * Opens the PENDING gateway leg for a hosted-checkout session (called from
 * `createGatewaySession`'s persist transaction, AFTER the provider call
 * returned — never during it). A pending leg is the in-flight record: it
 * never counts toward settlement, fires no event, and is resolved to
 * `succeeded`/`failed` by {@link resolveGatewayAllocation} /
 * {@link failPendingGatewayAllocation}. `ON CONFLICT DO NOTHING` on the source
 * key makes the (rare) concurrent double-create of the same provider
 * reference a no-op.
 */
export async function openPendingGatewayAllocation(
  tx: Bun.SQL,
  tenantId: string,
  params: {
    orderId: string;
    amount: string;
    provider: string;
    providerReference: string;
  }
): Promise<void> {
  if (toCents(params.amount) <= 0n) return;
  await tx`
    INSERT INTO awcms_commerce_payment_allocations (
      tenant_id, order_id, kind, tender_type, amount, status,
      provider, provider_reference, source, source_key, actor_kind
    )
    VALUES (
      ${tenantId}, ${params.orderId}, 'payment', 'gateway', ${params.amount}, 'pending',
      ${params.provider}, ${params.providerReference}, 'gateway_checkout',
      ${gatewaySourceKey(params.provider, params.providerReference)}, 'system'
    )
    ON CONFLICT (tenant_id, source_key) DO NOTHING
  `;
}

/**
 * Resolves a still-`pending` gateway leg to `failed` for the given session
 * status change (`failed`/`expired`). No order lock: a failed row never
 * counts toward settlement, so there is nothing to serialise.
 */
export async function failPendingGatewayAllocation(
  tx: Bun.SQL,
  tenantId: string,
  provider: string,
  providerReference: string
): Promise<void> {
  await tx`
    UPDATE awcms_commerce_payment_allocations
    SET status = 'failed', settled_at = now()
    WHERE tenant_id = ${tenantId}
      AND source_key = ${gatewaySourceKey(provider, providerReference)}
      AND status = 'pending'
  `;
}

export type ResolveGatewayAllocationParams = {
  orderId: string;
  provider: string;
  providerReference: string;
  /** The provider's own reported amount (`gross_amount`), already passed through the amount guard. `undefined` for a provider that reports none (the `log` adapter) — the leg then carries the session's charge basis, the order total. */
  grossAmount?: string;
  source: "gateway_webhook" | "gateway_reconcile";
  release: ReleaseOrderFn;
  releaseNote: string;
  correlationId?: string;
};

export type ResolveGatewayAllocationOutcome =
  | { kind: "order_not_found" }
  | { kind: "deduplicated"; settlement: SettlementView; orderStatus: string }
  | {
      kind: "recorded";
      settlement: SettlementView;
      released: boolean;
      orderStatus: string;
    };

/**
 * A confirmed (verified, amount-guarded) gateway payment: resolves the
 * pending leg to `succeeded` (or inserts a `succeeded` leg when the session
 * pre-dates the ledger), then settles the order. Idempotent under webhook
 * replays AND under the webhook racing the reconcile job: both reach the same
 * `gateway:{provider}:{ref}` key under the order-row lock, the loser finds the
 * leg already `succeeded` and writes nothing.
 *
 * Records the money even when the order is no longer payable (cancelled,
 * expired, already paid by another tender): the provider captured it, so the
 * ledger must say so — the excess shows up as `overpaid` and an operator
 * refunds it with a reversal. The caller decides what that means for the
 * ORDER (`markOrderPaidBySystem`'s `not_payable`/`already_paid`).
 */
export async function resolveGatewayAllocation(
  tx: Bun.SQL,
  tenantId: string,
  params: ResolveGatewayAllocationParams
): Promise<ResolveGatewayAllocationOutcome> {
  const header = await lockOrderForSettlement(tx, tenantId, params.orderId);
  if (!header) return { kind: "order_not_found" };

  const sourceKey = gatewaySourceKey(params.provider, params.providerReference);
  const existing = await findAllocationBySourceKey(tx, tenantId, sourceKey);

  if (existing && existing.status === "succeeded") {
    const { settlement, paymentStatus } = settlementOf(
      header,
      await readLedgerRows(tx, tenantId, header.id)
    );
    return {
      kind: "deduplicated",
      settlement: toSettlementView(settlement, paymentStatus),
      orderStatus: header.status
    };
  }

  const amount = normalizeMoney(params.grossAmount ?? header.total);
  let allocation: PaymentAllocationRecord;

  if (existing && existing.status === "pending") {
    const rows = (await tx`
      UPDATE awcms_commerce_payment_allocations
      SET status = 'succeeded', settled_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${existing.id} AND status = 'pending'
      RETURNING ${tx.unsafe(ALLOCATION_COLUMNS)}
    `) as AllocationRow[];
    allocation = toRecord(rows[0]!);
  } else {
    // No pending leg (a session opened before the ledger existed), or a leg
    // that was already marked `failed` and is now reported paid after all: a
    // new `succeeded` leg. The `failed` row cannot be edited (append-only),
    // so a late payment takes a distinct key rather than colliding with it.
    const key = existing ? `${sourceKey}:late` : sourceKey;
    const lateExisting = existing
      ? await findAllocationBySourceKey(tx, tenantId, key)
      : null;
    if (lateExisting) {
      const { settlement, paymentStatus } = settlementOf(
        header,
        await readLedgerRows(tx, tenantId, header.id)
      );
      return {
        kind: "deduplicated",
        settlement: toSettlementView(settlement, paymentStatus),
        orderStatus: header.status
      };
    }
    const rows = (await tx`
      INSERT INTO awcms_commerce_payment_allocations (
        tenant_id, order_id, kind, tender_type, amount, status,
        provider, provider_reference, source, source_key, actor_kind, settled_at
      )
      VALUES (
        ${tenantId}, ${header.id}, 'payment', 'gateway', ${amount}, 'succeeded',
        ${params.provider}, ${params.providerReference}, ${params.source}, ${key}, 'system', now()
      )
      RETURNING ${tx.unsafe(ALLOCATION_COLUMNS)}
    `) as AllocationRow[];
    allocation = toRecord(rows[0]!);
  }

  const { view, released } = await finalizeSettlement(
    tx,
    tenantId,
    header,
    params.release,
    params.releaseNote
  );

  await announcePayment(
    tx,
    tenantId,
    header,
    allocation,
    view,
    { kind: "system" },
    `Gateway payment of ${allocation.amount} (${params.provider}) confirmed for order ${header.orderCode}.`,
    params.correlationId
  );

  return {
    kind: "recorded",
    settlement: view,
    released,
    orderStatus: header.status
  };
}

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

export class ReversalExceedsPaymentError extends Error {
  public readonly reversible: string;
  constructor(reversible: string) {
    super("The reversal exceeds what remains reversible on the payment.");
    this.name = "ReversalExceedsPaymentError";
    this.reversible = reversible;
  }
}

export type RecordPaymentReversalParams = {
  orderId: string;
  allocationId: string;
  /** `null` = everything that remains reversible. */
  amount: string | null;
  note: string;
  sourceKey: string;
  actor: AllocationActor;
  correlationId?: string;
};

export type RecordPaymentReversalOutcome =
  | { kind: "not_found" }
  | {
      kind: "not_reversible";
      reason: "not_a_payment" | "not_succeeded" | "fully_reversed";
    }
  | {
      kind: "deduplicated";
      allocation: PaymentAllocationRecord;
      settlement: SettlementView;
    }
  | {
      kind: "recorded";
      allocation: PaymentAllocationRecord;
      settlement: SettlementView;
    };

/**
 * A compensating reversal of (part of) a `succeeded` payment. Locks the order
 * first, so concurrent reversals of the same payment serialise and the cap
 * ("never reverse more than was paid") holds under any interleaving.
 * Idempotent on `sourceKey`.
 *
 * Records the ledger fact only — it makes no provider call. Moving the money
 * back (a bank transfer, a provider refund) is the operator's act, performed
 * outside this transaction; this row is the book-keeping of it.
 *
 * @throws {ReversalExceedsPaymentError} `amount` > what remains reversible.
 */
export async function recordPaymentReversal(
  tx: Bun.SQL,
  tenantId: string,
  params: RecordPaymentReversalParams
): Promise<RecordPaymentReversalOutcome> {
  const header = await lockOrderForSettlement(tx, tenantId, params.orderId);
  if (!header) return { kind: "not_found" };

  const existing = await findAllocationBySourceKey(
    tx,
    tenantId,
    params.sourceKey
  );
  if (existing) {
    if (existing.orderId !== params.orderId) {
      throw new AllocationSourceKeyConflictError();
    }
    const { settlement, paymentStatus } = settlementOf(
      header,
      await readLedgerRows(tx, tenantId, header.id)
    );
    return {
      kind: "deduplicated",
      allocation: existing,
      settlement: toSettlementView(settlement, paymentStatus)
    };
  }

  // Tenant + order scoped: an allocation id belonging to another order or
  // another tenant resolves to nothing — the same answer as an unknown id.
  const originalRows = (await tx`
    SELECT ${tx.unsafe(ALLOCATION_COLUMNS)}
    FROM awcms_commerce_payment_allocations
    WHERE tenant_id = ${tenantId} AND order_id = ${header.id} AND id = ${params.allocationId}
  `) as AllocationRow[];
  const original = originalRows[0] ? toRecord(originalRows[0]) : null;
  if (!original) return { kind: "not_found" };
  if (original.kind !== "payment") {
    return { kind: "not_reversible", reason: "not_a_payment" };
  }
  if (original.status !== "succeeded") {
    return { kind: "not_reversible", reason: "not_succeeded" };
  }

  const reversedRows = (await tx`
    SELECT COALESCE(SUM(amount), 0) AS reversed
    FROM awcms_commerce_payment_allocations
    WHERE tenant_id = ${tenantId} AND reverses_allocation_id = ${original.id}
      AND status = 'succeeded'
  `) as { reversed: string }[];
  const reversibleCents =
    toCents(original.amount) -
    toCents(normalizeMoney(reversedRows[0]!.reversed));
  if (reversibleCents <= 0n) {
    return { kind: "not_reversible", reason: "fully_reversed" };
  }

  const amountCents =
    params.amount === null ? reversibleCents : toCents(params.amount);
  if (amountCents <= 0n || amountCents > reversibleCents) {
    throw new ReversalExceedsPaymentError(fromCents(reversibleCents));
  }

  const actor = actorColumns(params.actor);
  const rows = (await tx`
    INSERT INTO awcms_commerce_payment_allocations (
      tenant_id, order_id, kind, reverses_allocation_id, tender_type, amount, status,
      provider, provider_reference, note, source, source_key,
      actor_kind, actor_tenant_user_id, settled_at
    )
    VALUES (
      ${tenantId}, ${header.id}, 'reversal', ${original.id}, ${original.tenderType},
      ${fromCents(amountCents)}, 'succeeded',
      ${original.provider}, ${original.providerReference}, ${params.note}, 'admin', ${params.sourceKey},
      ${actor.kind}, ${actor.tenantUserId}, now()
    )
    RETURNING ${tx.unsafe(ALLOCATION_COLUMNS)}
  `) as AllocationRow[];
  const allocation = toRecord(rows[0]!);

  // `release: null` — a reversal never moves the lifecycle.
  const { view } = await finalizeSettlement(tx, tenantId, header, null, "");

  await announcePayment(
    tx,
    tenantId,
    header,
    allocation,
    view,
    params.actor,
    `Reversal of ${allocation.amount} (${allocation.tenderType}) recorded against order ${header.orderCode}.`,
    params.correlationId
  );

  return { kind: "recorded", allocation, settlement: view };
}

// ---------------------------------------------------------------------------
// Reporting reads
// ---------------------------------------------------------------------------

export type TenderMixRow = {
  tenderType: PaymentTenderType;
  paymentCount: number;
  payments: string;
  reversalCount: number;
  reversals: string;
  net: string;
};

export type TenderMixReport = {
  from: string;
  to: string;
  /** `Asia/Jakarta` — the same report day the sales projections use (`sales-report-deltas.ts`). */
  timeZone: string;
  items: TenderMixRow[];
  totalPayments: string;
  totalReversals: string;
  totalNet: string;
};

const TENDER_ORDER: readonly PaymentTenderType[] = [
  "cash",
  "manual_qris",
  "manual_bank_transfer",
  "gateway"
];

/**
 * Money movement by tender over an inclusive `[from, to]` range of report
 * days (`SALES_REPORT_TIME_ZONE`), read straight off the ledger — the ledger
 * IS the source of truth, so there is no second projection to drift or
 * reconcile. Each row is attributed to the day it was RECORDED (a refund is
 * the day the refund happened, not the day of the sale it undoes), counts
 * only `succeeded` legs, and a tender with no activity in the range is
 * absent rather than shown as zero.
 */
export async function listTenderMix(
  tx: Bun.SQL,
  tenantId: string,
  range: { from: string; to: string },
  timeZone: string
): Promise<TenderMixReport> {
  const rows = (await tx`
    SELECT tender_type,
      COUNT(*) FILTER (WHERE kind = 'payment') AS payment_count,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'payment'), 0) AS payments,
      COUNT(*) FILTER (WHERE kind = 'reversal') AS reversal_count,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'reversal'), 0) AS reversals
    FROM awcms_commerce_payment_allocations
    WHERE tenant_id = ${tenantId}
      AND status = 'succeeded'
      AND created_at >= (${range.from}::date)::timestamp AT TIME ZONE ${timeZone}
      AND created_at < ((${range.to}::date + 1)::timestamp AT TIME ZONE ${timeZone})
    GROUP BY tender_type
  `) as {
    tender_type: string;
    payment_count: string | number;
    payments: string;
    reversal_count: string | number;
    reversals: string;
  }[];

  let totalPayments = 0n;
  let totalReversals = 0n;
  const items = rows
    .map((row) => {
      const payments = toCents(normalizeMoney(String(row.payments)));
      const reversals = toCents(normalizeMoney(String(row.reversals)));
      totalPayments += payments;
      totalReversals += reversals;
      return {
        tenderType: row.tender_type as PaymentTenderType,
        paymentCount: Number(row.payment_count),
        payments: fromCents(payments),
        reversalCount: Number(row.reversal_count),
        reversals: fromCents(reversals),
        net: fromCents(payments - reversals)
      };
    })
    .sort(
      (a, b) =>
        TENDER_ORDER.indexOf(a.tenderType) - TENDER_ORDER.indexOf(b.tenderType)
    );

  return {
    from: range.from,
    to: range.to,
    timeZone,
    items,
    totalPayments: fromCents(totalPayments),
    totalReversals: fromCents(totalReversals),
    totalNet: fromCents(totalPayments - totalReversals)
  };
}

export type OutstandingBalanceRow = {
  orderId: string;
  orderCode: string;
  channel: string;
  status: string;
  paymentStatus: string;
  total: string;
  settled: string;
  outstanding: string;
  createdAt: string;
};

export type OutstandingBalancesReport = {
  channel: string | null;
  items: OutstandingBalanceRow[];
  /** `true` when more rows matched than `items` carries (`limit`). */
  truncated: boolean;
  count: number;
  totalOutstanding: string;
};

export const OUTSTANDING_BALANCES_DEFAULT_LIMIT = 100;
export const OUTSTANDING_BALANCES_MAX_LIMIT = 500;

/**
 * Orders that still owe money: not cancelled/expired, not soft-deleted, with
 * `total − settled > 0` where `settled` is the ledger sum (never the cached
 * `payment_status` alone — that column only narrows the scan to the partial
 * index `sql/940` adds; the figure is always re-derived from the rows).
 * Largest balance first. `count`/`totalOutstanding` cover EVERY matching
 * order, `items` only the first `limit`.
 */
export async function listOutstandingBalances(
  tx: Bun.SQL,
  tenantId: string,
  options: { channel: string | null; limit: number }
): Promise<OutstandingBalancesReport> {
  const channel = options.channel;
  // One statement: the window aggregates run over EVERY matching order before
  // LIMIT trims the page, so a tenant with thousands of unsettled orders
  // never loads them into memory just to count and sum them.
  const rows = (await tx`
    WITH unsettled AS (
      SELECT o.id, o.order_code, o.channel, o.status, o.payment_status, o.total, o.created_at,
             COALESCE(p.settled, 0) AS settled,
             o.total - COALESCE(p.settled, 0) AS outstanding
      FROM awcms_commerce_orders o
      LEFT JOIN LATERAL (
        SELECT SUM(CASE WHEN a.kind = 'payment' THEN a.amount ELSE -a.amount END) AS settled
        FROM awcms_commerce_payment_allocations a
        WHERE a.tenant_id = o.tenant_id AND a.order_id = o.id AND a.status = 'succeeded'
      ) p ON true
      WHERE o.tenant_id = ${tenantId}
        AND o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'expired')
        AND o.payment_status IN ('unpaid', 'partially_paid', 'dp_paid')
        AND (${channel}::text IS NULL OR o.channel = ${channel})
        AND o.total - COALESCE(p.settled, 0) > 0
    )
    SELECT id, order_code, channel, status, payment_status, total, created_at, settled, outstanding,
           COUNT(*) OVER () AS match_count,
           SUM(outstanding) OVER () AS match_outstanding
    FROM unsettled
    ORDER BY outstanding DESC, created_at DESC, id DESC
    LIMIT ${options.limit}
  `) as {
    id: string;
    order_code: string;
    channel: string;
    status: string;
    payment_status: string;
    total: string;
    created_at: Date;
    settled: string;
    outstanding: string;
    match_count: string | number;
    match_outstanding: string;
  }[];

  const items = rows.map((row) => ({
    orderId: row.id,
    orderCode: row.order_code,
    channel: row.channel,
    status: row.status,
    paymentStatus: row.payment_status,
    total: normalizeMoney(row.total),
    settled: normalizeMoney(String(row.settled)),
    outstanding: normalizeMoney(String(row.outstanding)),
    createdAt: row.created_at.toISOString()
  }));

  const first = rows[0];
  const count = first ? Number(first.match_count) : 0;
  return {
    channel,
    items,
    truncated: count > items.length,
    count,
    totalOutstanding: first
      ? normalizeMoney(String(first.match_outstanding))
      : "0.00"
  };
}
