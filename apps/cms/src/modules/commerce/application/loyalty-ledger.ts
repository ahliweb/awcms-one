/**
 * Loyalty points ledger — the ONLY writer of `awcms_commerce_loyalty_ledger`
 * and `awcms_commerce_loyalty_accounts` (Issue #289, ADR-0026).
 *
 * ## One write path, one lock
 *
 * Every balance change in the system — an earn from the order-paid consumer, a
 * reversal from the order-cancelled consumer, an expiry from the scheduled job
 * or lazily inside a redemption, a counter redemption, a manual adjustment —
 * goes through {@link appendLedgerEntry}, and only while the caller holds the
 * account row `FOR UPDATE` ({@link lockAccountById} / {@link
 * findOrCreateAccountLocked}). Under that lock the function:
 *
 *   1. answers a replayed idempotency key with the existing row (and refuses
 *      the same key arriving for a different account or different points);
 *   2. assigns the next per-account sequence number and the running
 *      `balance_after`;
 *   3. inserts the (append-only) ledger row;
 *   4. updates the account PROJECTION (`balance`, `version`) in the same
 *      transaction;
 *   5. appends the `loyalty.entry_recorded` domain event, in the same
 *      transaction, so a rolled-back write publishes nothing.
 *
 * Two concurrent redemptions therefore serialise on the account row: the
 * second one sees the first one's committed balance and is refused if it
 * would overdraw. There is no read-then-write window.
 *
 * ## What is NOT here
 *
 * No provider/network call (ADR-0006) happens inside any of these
 * transactions, and nothing here touches `application/order-directory.ts`,
 * `pos-directory.ts`, cart pricing or the payment webhook paths: earn and
 * reversal are driven purely by the `order.paid`/`order.cancelled` domain
 * events (see `domain-event-runtime/infrastructure/consumer-registry.ts`).
 * Wiring a redemption into checkout pricing needs #285's tender model and is
 * deferred (ADR-0026 Deferred).
 */
import { withTenantOrThrow } from "../../../lib/database/tenant-context";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../_shared/idempotency";
import {
  encodeKeysetCursor,
  keysetCursorCreatedAtSql,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_LOYALTY_ACCOUNT_AGGREGATE_TYPE,
  COMMERCE_LOYALTY_ENTRY_RECORDED_EVENT_TYPE
} from "../domain/commerce-events";
import {
  maskPhone,
  POS_WALK_IN_CUSTOMER_SENTINEL_PHONE
} from "../domain/phone-normalisation";
import { fetchCommerceFeatures } from "./commerce-feature-gate";
import {
  assertPoints,
  isLoyaltyEntryKind,
  isValidEntrySign,
  type CustomerLoyaltyHistoryItem,
  type LoyaltyAccount,
  type LoyaltyEntryKind,
  type LoyaltyLedgerEntry,
  type LoyaltySourceType
} from "../domain/loyalty";
import { computeEarnPoints, computeExpiresAt } from "../domain/loyalty-earn";
import {
  computeReversalPoints,
  findExpirableLots,
  type ReplayEntry
} from "../domain/loyalty-lots";
import { fetchEffectiveProgramAt } from "./loyalty-program-directory";

const PRODUCER_MODULE = "commerce";
const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_loyalty";

export const LOYALTY_REDEEM_IDEMPOTENCY_SCOPE = "commerce.loyalty.redeem";
export const LOYALTY_ADJUST_IDEMPOTENCY_SCOPE = "commerce.loyalty.adjust";

export const LOYALTY_LEDGER_DEFAULT_LIMIT = 20;
export const LOYALTY_LEDGER_MAX_LIMIT = 50;
export const LOYALTY_ACCOUNT_LIST_DEFAULT_LIMIT = 20;
export const LOYALTY_ACCOUNT_LIST_MAX_LIMIT = 50;

/** Order statuses an earn may be recorded for — every status AFTER payment that is not a cancellation. */
const EARNABLE_ORDER_STATUSES: readonly string[] = [
  "paid",
  "processing",
  "shipped",
  "completed"
];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The same idempotency key arrived with a different payload (or for a different account). Maps to `409 IDEMPOTENCY_CONFLICT`. */
export class LoyaltyIdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency-Key was already used with a different request.");
    this.name = "LoyaltyIdempotencyConflictError";
  }
}

// ---------------------------------------------------------------------------
// Row decoding
// ---------------------------------------------------------------------------

function toIso(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value as string).toISOString();
}

function toIsoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

type LedgerRow = {
  id: string;
  account_id: string;
  account_seq: string | number | bigint;
  kind: string;
  points: string | number | bigint;
  balance_after: string | number | bigint;
  program_id: string | null;
  source_type: string;
  source_id: string | null;
  reverses_entry_id: string | null;
  expires_at: Date | string | null;
  actor_tenant_user_id: string | null;
  reason: string | null;
  created_at: Date | string;
};

function toLedgerEntry(row: LedgerRow): LoyaltyLedgerEntry {
  if (!isLoyaltyEntryKind(row.kind)) {
    throw new Error(`Unknown loyalty ledger kind "${row.kind}".`);
  }
  return {
    id: row.id,
    accountId: row.account_id,
    accountSeq: assertPoints(row.account_seq, "account_seq"),
    kind: row.kind,
    points: assertPoints(row.points),
    balanceAfter: assertPoints(row.balance_after, "balance_after"),
    programId: row.program_id,
    sourceType: row.source_type as LoyaltySourceType,
    sourceId: row.source_id,
    reversesEntryId: row.reverses_entry_id,
    expiresAt: toIsoOrNull(row.expires_at),
    actorTenantUserId: row.actor_tenant_user_id,
    reason: row.reason,
    createdAt: toIso(row.created_at)
  };
}

async function findEntryByKey(
  tx: Bun.SQL,
  tenantId: string,
  idempotencyKey: string
): Promise<LoyaltyLedgerEntry | null> {
  const rows = (await tx`
    SELECT id, account_id, account_seq, kind, points, balance_after,
      program_id, source_type, source_id, reverses_entry_id, expires_at,
      actor_tenant_user_id, reason, created_at
    FROM awcms_commerce_loyalty_ledger
    WHERE tenant_id = ${tenantId} AND idempotency_key = ${idempotencyKey}
  `) as LedgerRow[];
  return rows[0] ? toLedgerEntry(rows[0]) : null;
}

type AccountRow = {
  id: string;
  customer_id: string;
  balance: string | number | bigint;
  version: string | number | bigint;
  created_at: Date | string;
  updated_at: Date | string;
};

function toLoyaltyAccount(row: AccountRow): LoyaltyAccount {
  return {
    id: row.id,
    customerId: row.customer_id,
    balance: assertPoints(row.balance, "balance"),
    version: assertPoints(row.version, "version"),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

export function toCustomerHistoryItem(
  entry: LoyaltyLedgerEntry
): CustomerLoyaltyHistoryItem {
  return {
    id: entry.id,
    kind: entry.kind,
    points: entry.points,
    balanceAfter: entry.balanceAfter,
    expiresAt: entry.expiresAt,
    createdAt: entry.createdAt
  };
}

// ---------------------------------------------------------------------------
// Account locking
// ---------------------------------------------------------------------------

/** A locked account's live state. Mutated in place by {@link appendLedgerEntry} so a caller appending several rows sees the running balance. */
export type LockedAccount = {
  id: string;
  customerId: string;
  balance: number;
  version: number;
};

function toLockedAccount(row: AccountRow): LockedAccount {
  return {
    id: row.id,
    customerId: row.customer_id,
    balance: assertPoints(row.balance, "balance"),
    version: assertPoints(row.version, "version")
  };
}

/** Locks one account by id (`FOR UPDATE`). `null` when it does not exist in this tenant. */
export async function lockAccountById(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string
): Promise<LockedAccount | null> {
  const rows = (await tx`
    SELECT id, customer_id, balance, version, created_at, updated_at
    FROM awcms_commerce_loyalty_accounts
    WHERE tenant_id = ${tenantId} AND id = ${accountId}
    FOR UPDATE
  `) as AccountRow[];
  return rows[0] ? toLockedAccount(rows[0]) : null;
}

/** Locks the customer's account if it exists, never creating one (a redemption by a customer with no account is simply "insufficient"). */
export async function lockAccountForCustomer(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string
): Promise<LockedAccount | null> {
  const rows = (await tx`
    SELECT id, customer_id, balance, version, created_at, updated_at
    FROM awcms_commerce_loyalty_accounts
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
    FOR UPDATE
  `) as AccountRow[];
  return rows[0] ? toLockedAccount(rows[0]) : null;
}

/**
 * Creates the customer's account if it does not exist, then locks it. The
 * insert is `ON CONFLICT DO NOTHING` against the `(tenant_id, customer_id)`
 * unique index, so two first-ever events for one customer cannot create two
 * accounts; whichever loses simply locks the winner's row.
 */
export async function findOrCreateAccountLocked(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string
): Promise<LockedAccount> {
  await tx`
    INSERT INTO awcms_commerce_loyalty_accounts (tenant_id, customer_id)
    VALUES (${tenantId}, ${customerId})
    ON CONFLICT (tenant_id, customer_id) DO NOTHING
  `;
  const locked = await lockAccountForCustomer(tx, tenantId, customerId);
  if (!locked) {
    throw new Error("Loyalty account vanished after insert.");
  }
  return locked;
}

// ---------------------------------------------------------------------------
// The one writer
// ---------------------------------------------------------------------------

export type AppendEntryInput = {
  kind: LoyaltyEntryKind;
  /** Signed integer points — the sign must match `kind` (`isValidEntrySign`). */
  points: number;
  programId?: string | null;
  sourceType: LoyaltySourceType;
  sourceId?: string | null;
  idempotencyKey: string;
  reversesEntryId?: string | null;
  expiresAt?: Date | null;
  actorTenantUserId?: string | null;
  reason?: string | null;
  correlationId?: string;
};

export type AppendEntryResult = {
  /** `false` when the idempotency key already had a row — nothing was written. */
  inserted: boolean;
  entry: LoyaltyLedgerEntry;
};

/**
 * Appends one ledger row and updates the account projection. `account` MUST
 * be a row this transaction holds `FOR UPDATE` (see this file's header).
 * Mutates `account.balance`/`account.version` on a real insert.
 *
 * @throws {LoyaltyIdempotencyConflictError} the key exists for another account
 *   or with different points.
 */
export async function appendLedgerEntry(
  tx: Bun.SQL,
  tenantId: string,
  account: LockedAccount,
  input: AppendEntryInput
): Promise<AppendEntryResult> {
  assertPoints(input.points);
  if (!isValidEntrySign(input.kind, input.points)) {
    throw new RangeError(
      `Loyalty entry kind "${input.kind}" cannot carry ${input.points} points.`
    );
  }

  const existing = await findEntryByKey(tx, tenantId, input.idempotencyKey);
  if (existing) {
    if (existing.accountId !== account.id || existing.points !== input.points) {
      throw new LoyaltyIdempotencyConflictError();
    }
    return { inserted: false, entry: existing };
  }

  const nextSeq = account.version + 1;
  const balanceAfter = assertPoints(account.balance + input.points, "balance");

  const insertedRows = (await tx`
    INSERT INTO awcms_commerce_loyalty_ledger (
      tenant_id, account_id, account_seq, kind, points, balance_after,
      program_id, source_type, source_id, idempotency_key, reverses_entry_id,
      expires_at, actor_tenant_user_id, reason, correlation_id
    ) VALUES (
      ${tenantId}, ${account.id}, ${nextSeq}, ${input.kind}, ${input.points},
      ${balanceAfter}, ${input.programId ?? null}::uuid, ${input.sourceType},
      ${input.sourceId ?? null}::uuid, ${input.idempotencyKey},
      ${input.reversesEntryId ?? null}::uuid, ${input.expiresAt ?? null}::timestamptz,
      ${input.actorTenantUserId ?? null}::uuid, ${input.reason ?? null}::text,
      ${input.correlationId ?? null}::text
    )
    RETURNING id, account_id, account_seq, kind, points, balance_after,
      program_id, source_type, source_id, reverses_entry_id, expires_at,
      actor_tenant_user_id, reason, created_at
  `) as LedgerRow[];
  const entry = toLedgerEntry(insertedRows[0]!);

  await tx`
    UPDATE awcms_commerce_loyalty_accounts
    SET balance = ${balanceAfter}, version = ${nextSeq}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${account.id}
  `;
  account.balance = balanceAfter;
  account.version = nextSeq;

  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_LOYALTY_ENTRY_RECORDED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_LOYALTY_ACCOUNT_AGGREGATE_TYPE,
    aggregateId: account.id,
    producerModule: PRODUCER_MODULE,
    correlationId: input.correlationId,
    actorTenantUserId: input.actorTenantUserId ?? null,
    payload: {
      entryId: entry.id,
      accountId: account.id,
      customerId: account.customerId,
      kind: entry.kind,
      points: entry.points,
      balanceAfter: entry.balanceAfter,
      sourceType: entry.sourceType
    }
  });

  return { inserted: true, entry };
}

// ---------------------------------------------------------------------------
// Replay support (expiry / reversal arithmetic)
// ---------------------------------------------------------------------------

async function loadReplayEntries(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string
): Promise<ReplayEntry[]> {
  const rows = (await tx`
    SELECT id, account_seq, kind, points, created_at, expires_at,
      reverses_entry_id, source_id
    FROM awcms_commerce_loyalty_ledger
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
    ORDER BY account_seq ASC
  `) as {
    id: string;
    account_seq: string | number | bigint;
    kind: string;
    points: string | number | bigint;
    created_at: Date | string;
    expires_at: Date | string | null;
    reverses_entry_id: string | null;
    source_id: string | null;
  }[];

  return rows.map((row) => ({
    id: row.id,
    accountSeq: assertPoints(row.account_seq, "account_seq"),
    kind: row.kind as LoyaltyEntryKind,
    points: assertPoints(row.points),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    reversesEntryId: row.reverses_entry_id,
    sourceId: row.source_id
  }));
}

/**
 * Writes the `expire` entries for every earn lot of this account that fell due
 * at or before `asOf` and has none yet — the same function the scheduled job
 * runs per account AND a redemption/reversal runs first, so a customer can
 * never spend (or be clawed back from) points that have already lapsed just
 * because the job has not ticked yet. Caller holds the account lock.
 *
 * A cheap indexed EXISTS gates the full replay: an account with nothing due
 * costs one query.
 */
export async function expireDueLotsForLockedAccount(
  tx: Bun.SQL,
  tenantId: string,
  account: LockedAccount,
  asOf: Date,
  correlationId?: string
): Promise<number> {
  const due = (await tx`
    SELECT 1 AS due
    FROM awcms_commerce_loyalty_ledger e
    WHERE e.tenant_id = ${tenantId}
      AND e.account_id = ${account.id}
      AND e.kind = 'earn'
      AND e.expires_at IS NOT NULL
      AND e.expires_at <= ${asOf}
      AND NOT EXISTS (
        SELECT 1 FROM awcms_commerce_loyalty_ledger x
        WHERE x.tenant_id = e.tenant_id AND x.kind = 'expire' AND x.source_id = e.id
      )
    LIMIT 1
  `) as unknown[];
  if (due.length === 0) return 0;

  const entries = await loadReplayEntries(tx, tenantId, account.id);
  const lots = findExpirableLots(entries, asOf);

  let written = 0;
  for (const lot of lots) {
    const result = await appendLedgerEntry(tx, tenantId, account, {
      kind: "expire",
      points: -lot.remaining,
      sourceType: "expiry",
      sourceId: lot.lotId,
      idempotencyKey: `expire:${lot.lotId}`,
      correlationId
    });
    if (result.inserted) written += 1;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Earn (order paid)
// ---------------------------------------------------------------------------

export type EarnOutcome =
  | { kind: "earned"; entry: LoyaltyLedgerEntry }
  | { kind: "already_earned"; entry: LoyaltyLedgerEntry }
  /**
   * The `earn:order:<id>` key already belongs to another account or amount
   * (e.g. the order's customer was reassigned after the earn). Retrying can
   * never succeed, so this is a recorded, non-retryable outcome, not a throw.
   */
  | { kind: "skipped_conflict"; orderId: string }
  | {
      kind: "skipped";
      reason:
        | "feature_disabled"
        | "order_not_found"
        | "order_not_earnable"
        | "walk_in_customer"
        | "customer_unavailable"
        | "no_effective_program"
        | "zero_points";
    };

/**
 * Earns points for one paid order — called from the
 * `commerce.order_paid_loyalty_earner` consumer, which wraps it in
 * `applyConsumerEffectOnce`. Exactly once per order: the ledger key
 * `earn:order:<orderId>` is the second, independent guard (a manual replay or
 * a retry that raced the consumer marker still yields one row).
 *
 * Reads ONLY server-side facts — the order row's `subtotal`/`discount`/
 * `paid_at`/`customer_id`, never the event payload — and silently skips (never
 * throws) when the order has since been cancelled, the customer is the
 * walk-in sentinel or blocked, the tenant's loyalty feature is off, or no
 * program version was effective at `paid_at`. Skipping because the feature is
 * off is NOT retroactive: enabling it later does not back-fill earlier orders
 * (ADR-0026 D2).
 */
export async function earnPointsForPaidOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  correlationId?: string
): Promise<EarnOutcome> {
  const features = await fetchCommerceFeatures(tx, tenantId);
  if (!features.loyalty) return { kind: "skipped", reason: "feature_disabled" };

  const orderRows = (await tx`
    SELECT o.id, o.status, o.subtotal, o.discount, o.paid_at, o.customer_id,
      c.phone AS customer_phone, c.status AS customer_status,
      c.deleted_at AS customer_deleted_at
    FROM awcms_commerce_orders o
    JOIN awcms_commerce_customers c
      ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
    WHERE o.tenant_id = ${tenantId} AND o.id = ${orderId} AND o.deleted_at IS NULL
  `) as {
    id: string;
    status: string;
    subtotal: string;
    discount: string;
    paid_at: Date | string | null;
    customer_id: string;
    customer_phone: string;
    customer_status: string;
    customer_deleted_at: Date | string | null;
  }[];
  const order = orderRows[0];
  if (!order) return { kind: "skipped", reason: "order_not_found" };
  if (!EARNABLE_ORDER_STATUSES.includes(order.status)) {
    return { kind: "skipped", reason: "order_not_earnable" };
  }
  if (order.customer_phone === POS_WALK_IN_CUSTOMER_SENTINEL_PHONE) {
    return { kind: "skipped", reason: "walk_in_customer" };
  }
  if (
    order.customer_deleted_at !== null ||
    order.customer_status !== "active"
  ) {
    return { kind: "skipped", reason: "customer_unavailable" };
  }

  const paidAt = order.paid_at === null ? new Date() : new Date(order.paid_at);
  const program = await fetchEffectiveProgramAt(tx, tenantId, paidAt);
  if (!program) return { kind: "skipped", reason: "no_effective_program" };

  const points = computeEarnPoints(
    {
      earnUnitAmount: program.earnUnitAmount,
      earnPointsPerUnit: program.earnPointsPerUnit,
      minOrderAmount: program.minOrderAmount,
      maxPointsPerOrder: program.maxPointsPerOrder
    },
    { subtotal: String(order.subtotal), discount: String(order.discount) }
  );
  if (points <= 0) return { kind: "skipped", reason: "zero_points" };

  const account = await findOrCreateAccountLocked(
    tx,
    tenantId,
    order.customer_id
  );
  let result: AppendEntryResult;
  try {
    result = await appendLedgerEntry(tx, tenantId, account, {
      kind: "earn",
      points,
      programId: program.id,
      sourceType: "order",
      sourceId: orderId,
      idempotencyKey: `earn:order:${orderId}`,
      expiresAt: computeExpiresAt(paidAt, program.expiryDays),
      correlationId
    });
  } catch (error) {
    if (!(error instanceof LoyaltyIdempotencyConflictError)) throw error;
    // Thrown before any write (the key lookup precedes the INSERT), so the
    // transaction is intact. Redelivery cannot change the answer, so surface a
    // warning for an operator and let the consumer mark the event handled.
    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "commerce.loyalty.earn_skipped_conflict",
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: order.customer_id,
      severity: "warning",
      message:
        "Loyalty earn skipped: the order's earn key already belongs to another account or amount (customer reassigned?).",
      attributes: { orderId, customerId: order.customer_id },
      correlationId
    });
    return { kind: "skipped_conflict", orderId };
  }

  return result.inserted
    ? { kind: "earned", entry: result.entry }
    : { kind: "already_earned", entry: result.entry };
}

// ---------------------------------------------------------------------------
// Reversal (order cancelled)
// ---------------------------------------------------------------------------

export type ReverseOutcome =
  | { kind: "reversed"; entry: LoyaltyLedgerEntry }
  | { kind: "already_reversed"; entry: LoyaltyLedgerEntry }
  | { kind: "no_earn" }
  | { kind: "nothing_to_reverse" };

/**
 * Compensates the earn recorded for a cancelled order — never deletes it. The
 * reversal takes back what the lot still stands for: its original points minus
 * anything that already lapsed (those are gone; taking them again would be a
 * double deduction). Points the customer already SPENT from the lot ARE taken
 * back, so the balance may go negative (ADR-0026 D6) — a negative balance
 * blocks further redemption until later earns cover it.
 *
 * Runs regardless of the feature flag: turning loyalty off must not strand the
 * points of an order that is later cancelled.
 */
export async function reverseEarnForCancelledOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  asOf: Date,
  correlationId?: string
): Promise<ReverseOutcome> {
  const earnRows = (await tx`
    SELECT id, account_id
    FROM awcms_commerce_loyalty_ledger
    WHERE tenant_id = ${tenantId} AND idempotency_key = ${`earn:order:${orderId}`}
  `) as { id: string; account_id: string }[];
  const earn = earnRows[0];
  if (!earn) return { kind: "no_earn" };

  const account = await lockAccountById(tx, tenantId, earn.account_id);
  if (!account) return { kind: "no_earn" };

  const reversalKey = `reversal:order:${orderId}`;
  const prior = await findEntryByKey(tx, tenantId, reversalKey);
  if (prior) return { kind: "already_reversed", entry: prior };

  await expireDueLotsForLockedAccount(
    tx,
    tenantId,
    account,
    asOf,
    correlationId
  );

  const entries = await loadReplayEntries(tx, tenantId, account.id);
  const points = computeReversalPoints(entries, earn.id);
  if (points <= 0) return { kind: "nothing_to_reverse" };

  const result = await appendLedgerEntry(tx, tenantId, account, {
    kind: "reversal",
    points: -points,
    sourceType: "order",
    sourceId: orderId,
    idempotencyKey: reversalKey,
    reversesEntryId: earn.id,
    correlationId
  });

  return result.inserted
    ? { kind: "reversed", entry: result.entry }
    : { kind: "already_reversed", entry: result.entry };
}

// ---------------------------------------------------------------------------
// Redeem / adjust (owner side, Idempotency-Key required)
// ---------------------------------------------------------------------------

async function customerExists(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string
): Promise<boolean> {
  const rows = (await tx`
    SELECT 1 AS present FROM awcms_commerce_customers
    WHERE tenant_id = ${tenantId} AND id = ${customerId} AND deleted_at IS NULL
  `) as unknown[];
  return rows.length > 0;
}

export type RedeemRecord = { entry: LoyaltyLedgerEntry; balance: number };

export type RedeemOutcome =
  | ({ kind: "redeemed" } & RedeemRecord)
  | ({ kind: "replayed" } & RedeemRecord)
  | { kind: "insufficient"; balance: number; requested: number }
  | { kind: "customer_not_found" };

/**
 * Spends `points` of a customer's balance. Requires an idempotency key (the
 * route enforces the header): the shared `awcms_idempotency_keys` store
 * replays a stored response, and the ledger key
 * `redeem:<accountId>:<key>` is the hard guard underneath it. Runs under the
 * account lock, lazily expires due lots first, then refuses — without writing
 * anything — when the balance cannot cover the request.
 *
 * A refused (`insufficient`) request is deliberately NOT recorded in the
 * idempotency store, so the same key can succeed after a top-up.
 */
export async function redeemPoints(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: {
    customerId: string;
    points: number;
    reason: string | null;
    idempotencyKey: string;
  },
  now: Date,
  correlationId?: string
): Promise<RedeemOutcome> {
  const requestHash = computeRequestHash({
    customerId: input.customerId,
    points: input.points,
    reason: input.reason
  });
  const stored = await findIdempotencyRecord(
    tx,
    tenantId,
    LOYALTY_REDEEM_IDEMPOTENCY_SCOPE,
    input.idempotencyKey
  );
  if (stored) {
    if (stored.requestHash !== requestHash) {
      throw new LoyaltyIdempotencyConflictError();
    }
    return { kind: "replayed", ...(stored.responseBody as RedeemRecord) };
  }

  if (!(await customerExists(tx, tenantId, input.customerId))) {
    return { kind: "customer_not_found" };
  }

  const account = await lockAccountForCustomer(tx, tenantId, input.customerId);
  if (!account) {
    return { kind: "insufficient", balance: 0, requested: input.points };
  }

  await expireDueLotsForLockedAccount(
    tx,
    tenantId,
    account,
    now,
    correlationId
  );

  const key = `redeem:${account.id}:${input.idempotencyKey}`;
  if (account.balance < input.points) {
    // A same-key retry whose first attempt already committed must replay, not
    // be refused: look before concluding "insufficient".
    const prior = await findEntryByKey(tx, tenantId, key);
    if (!prior) {
      return {
        kind: "insufficient",
        balance: account.balance,
        requested: input.points
      };
    }
  }

  const result = await appendLedgerEntry(tx, tenantId, account, {
    kind: "redeem",
    points: -input.points,
    sourceType: "redemption",
    idempotencyKey: key,
    actorTenantUserId,
    reason: input.reason,
    correlationId
  });

  if (!result.inserted) {
    return {
      kind: "replayed",
      entry: result.entry,
      balance: account.balance
    };
  }

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.loyalty.redeemed",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: result.entry.id,
    message: `Redeemed ${input.points} loyalty points.`,
    attributes: {
      accountId: account.id,
      points: input.points,
      balanceAfter: account.balance
    },
    correlationId
  });

  const record: RedeemRecord = {
    entry: result.entry,
    balance: account.balance
  };
  await saveIdempotencyRecord(
    tx,
    tenantId,
    LOYALTY_REDEEM_IDEMPOTENCY_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    record
  );
  return { kind: "redeemed", ...record };
}

export type AdjustOutcome =
  | ({ kind: "adjusted" } & RedeemRecord)
  | ({ kind: "replayed" } & RedeemRecord)
  | { kind: "would_go_negative"; balance: number }
  | { kind: "customer_not_found" };

/**
 * A manual, signed correction — attributable (`actor`), explained (`reason`
 * is mandatory, also a DB CHECK) and audited. A negative adjustment may not
 * take the balance below zero: only a system-driven reversal is allowed to
 * (ADR-0026 D6). A positive adjustment on a customer with no account opens
 * one. Adjustments never expire.
 */
export async function adjustPoints(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: {
    customerId: string;
    points: number;
    reason: string;
    idempotencyKey: string;
  },
  now: Date,
  correlationId?: string
): Promise<AdjustOutcome> {
  const requestHash = computeRequestHash({
    customerId: input.customerId,
    points: input.points,
    reason: input.reason
  });
  const stored = await findIdempotencyRecord(
    tx,
    tenantId,
    LOYALTY_ADJUST_IDEMPOTENCY_SCOPE,
    input.idempotencyKey
  );
  if (stored) {
    if (stored.requestHash !== requestHash) {
      throw new LoyaltyIdempotencyConflictError();
    }
    return { kind: "replayed", ...(stored.responseBody as RedeemRecord) };
  }

  if (!(await customerExists(tx, tenantId, input.customerId))) {
    return { kind: "customer_not_found" };
  }

  const account = await findOrCreateAccountLocked(
    tx,
    tenantId,
    input.customerId
  );
  await expireDueLotsForLockedAccount(
    tx,
    tenantId,
    account,
    now,
    correlationId
  );

  const key = `adjust:${account.id}:${input.idempotencyKey}`;
  if (input.points < 0 && account.balance + input.points < 0) {
    const prior = await findEntryByKey(tx, tenantId, key);
    if (!prior) {
      return { kind: "would_go_negative", balance: account.balance };
    }
  }

  const result = await appendLedgerEntry(tx, tenantId, account, {
    kind: "adjustment",
    points: input.points,
    sourceType: "manual",
    idempotencyKey: key,
    actorTenantUserId,
    reason: input.reason,
    correlationId
  });

  if (!result.inserted) {
    return { kind: "replayed", entry: result.entry, balance: account.balance };
  }

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.loyalty.adjusted",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: result.entry.id,
    message: `Adjusted loyalty points by ${input.points}.`,
    attributes: {
      accountId: account.id,
      points: input.points,
      balanceAfter: account.balance
    },
    correlationId
  });

  const record: RedeemRecord = {
    entry: result.entry,
    balance: account.balance
  };
  await saveIdempotencyRecord(
    tx,
    tenantId,
    LOYALTY_ADJUST_IDEMPOTENCY_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    record
  );
  return { kind: "adjusted", ...record };
}

// ---------------------------------------------------------------------------
// Expiry job (per tenant)
// ---------------------------------------------------------------------------

export type ExpireLoyaltyResult = {
  accountsProcessed: number;
  entriesWritten: number;
  /** `true` when the per-run account bound was hit — more may be due. */
  partial: boolean;
};

/**
 * One tenant's expiry pass: finds up to `accountBatchLimit` accounts holding a
 * due earn lot with no `expire` row and writes the missing rows, each account
 * in its OWN short transaction (so no run ever holds more than one account
 * lock). Idempotent: a lot with an `expire` row is anti-joined out of the scan
 * and cannot get a second one (`sql/950`'s `expire_lot_key`).
 */
export async function expireDueLoyaltyPointsForTenant(
  sql: Bun.SQL,
  tenantId: string,
  asOf: Date,
  correlationId?: string,
  accountBatchLimit = 200
): Promise<ExpireLoyaltyResult> {
  const accountIds = await withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => {
      const rows = (await tx`
        SELECT DISTINCT e.account_id
        FROM awcms_commerce_loyalty_ledger e
        WHERE e.tenant_id = ${tenantId}
          AND e.kind = 'earn'
          AND e.expires_at IS NOT NULL
          AND e.expires_at <= ${asOf}
          AND NOT EXISTS (
            SELECT 1 FROM awcms_commerce_loyalty_ledger x
            WHERE x.tenant_id = e.tenant_id AND x.kind = 'expire' AND x.source_id = e.id
          )
        LIMIT ${accountBatchLimit}
      `) as { account_id: string }[];
      return rows.map((row) => row.account_id);
    },
    { workClass: "background_sync" }
  );

  let entriesWritten = 0;
  for (const accountId of accountIds) {
    entriesWritten += await withTenantOrThrow(
      sql,
      tenantId,
      async (tx) => {
        const account = await lockAccountById(tx, tenantId, accountId);
        if (!account) return 0;
        return expireDueLotsForLockedAccount(
          tx,
          tenantId,
          account,
          asOf,
          correlationId
        );
      },
      { workClass: "background_sync" }
    );
  }

  return {
    accountsProcessed: accountIds.length,
    entriesWritten,
    partial: accountIds.length === accountBatchLimit
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type LoyaltyAccountView = LoyaltyAccount & {
  customerName: string;
  customerPhoneMasked: string;
};

type AccountViewRow = AccountRow & {
  customer_name: string;
  customer_phone: string;
  created_at_cursor?: string;
};

function toAccountView(row: AccountViewRow): LoyaltyAccountView {
  return {
    ...toLoyaltyAccount(row),
    customerName: row.customer_name,
    customerPhoneMasked: maskPhone(row.customer_phone)
  };
}

/** The customer's account, or `null` when they have none yet (a customer with no points has balance 0 and no row). */
export async function fetchLoyaltyAccountForCustomer(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string
): Promise<LoyaltyAccount | null> {
  const rows = (await tx`
    SELECT id, customer_id, balance, version, created_at, updated_at
    FROM awcms_commerce_loyalty_accounts
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
  `) as AccountRow[];
  return rows[0] ? toLoyaltyAccount(rows[0]) : null;
}

export type LoyaltyCustomerLookup = {
  id: string;
  name: string;
  phoneMasked: string;
  /** 0 for a customer who has no account yet. */
  balance: number;
};

/**
 * The counter lookup: a customer by E.164 phone (already normalised by the
 * caller) with their current balance. The walk-in sentinel is never returned —
 * it is a shared placeholder row, not a person, and never earns.
 */
export async function findCustomerForLoyaltyLookup(
  tx: Bun.SQL,
  tenantId: string,
  e164Phone: string
): Promise<LoyaltyCustomerLookup | null> {
  if (e164Phone === POS_WALK_IN_CUSTOMER_SENTINEL_PHONE) return null;

  const rows = (await tx`
    SELECT c.id, c.name, c.phone, COALESCE(a.balance, 0) AS balance
    FROM awcms_commerce_customers c
    LEFT JOIN awcms_commerce_loyalty_accounts a
      ON a.tenant_id = c.tenant_id AND a.customer_id = c.id
    WHERE c.tenant_id = ${tenantId} AND c.phone = ${e164Phone}
      AND c.deleted_at IS NULL
  `) as {
    id: string;
    name: string;
    phone: string;
    balance: string | number | bigint;
  }[];
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    phoneMasked: maskPhone(row.phone),
    balance: assertPoints(row.balance, "balance")
  };
}

/** The same block as {@link findCustomerForLoyaltyLookup}, by customer id — `null` for an unknown, deleted or cross-tenant id (indistinguishable by design). */
export async function fetchLoyaltyCustomerById(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string
): Promise<LoyaltyCustomerLookup | null> {
  const rows = (await tx`
    SELECT c.id, c.name, c.phone, COALESCE(a.balance, 0) AS balance
    FROM awcms_commerce_customers c
    LEFT JOIN awcms_commerce_loyalty_accounts a
      ON a.tenant_id = c.tenant_id AND a.customer_id = c.id
    WHERE c.tenant_id = ${tenantId} AND c.id = ${customerId}
      AND c.deleted_at IS NULL
  `) as {
    id: string;
    name: string;
    phone: string;
    balance: string | number | bigint;
  }[];
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    phoneMasked: maskPhone(row.phone),
    balance: assertPoints(row.balance, "balance")
  };
}

export type LoyaltyAccountListPage = {
  items: LoyaltyAccountView[];
  nextCursor: string | null;
};

/** Admin list, newest account first. `customerId` narrows to one customer. */
export async function listLoyaltyAccounts(
  tx: Bun.SQL,
  tenantId: string,
  filter: { customerId?: string },
  cursor: KeysetCursor | null,
  limit: number = LOYALTY_ACCOUNT_LIST_DEFAULT_LIMIT
): Promise<LoyaltyAccountListPage> {
  const boundedLimit = Math.min(
    Math.max(1, Math.trunc(limit)),
    LOYALTY_ACCOUNT_LIST_MAX_LIMIT
  );
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT a.id, a.customer_id, a.balance, a.version, a.created_at, a.updated_at,
      c.name AS customer_name, c.phone AS customer_phone,
      ${tx.unsafe(keysetCursorCreatedAtSql("a"))} AS created_at_cursor
    FROM awcms_commerce_loyalty_accounts a
    JOIN awcms_commerce_customers c
      ON c.tenant_id = a.tenant_id AND c.id = a.customer_id
    WHERE a.tenant_id = ${tenantId}
      AND (${filter.customerId ?? null}::uuid IS NULL OR a.customer_id = ${filter.customerId ?? null})
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (a.created_at, a.id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${boundedLimit}
  `) as AccountViewRow[];

  const last = rows[rows.length - 1];
  return {
    items: rows.map(toAccountView),
    nextCursor:
      rows.length === boundedLimit && last
        ? encodeKeysetCursor(last.created_at_cursor!, last.id)
        : null
  };
}

export type LoyaltyLedgerPage = {
  items: LoyaltyLedgerEntry[];
  nextCursor: string | null;
};

/**
 * One account's history, newest first. `accountId` is ALWAYS resolved from a
 * customer id the caller is entitled to (the bearer session's own customer on
 * the storefront, an authorised owner on the admin side) — this function takes
 * an account id and the caller never passes a client-supplied one directly.
 */
export async function listLedgerForAccount(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  cursor: KeysetCursor | null,
  limit: number = LOYALTY_LEDGER_DEFAULT_LIMIT
): Promise<LoyaltyLedgerPage> {
  const boundedLimit = Math.min(
    Math.max(1, Math.trunc(limit)),
    LOYALTY_LEDGER_MAX_LIMIT
  );
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT id, account_id, account_seq, kind, points, balance_after,
      program_id, source_type, source_id, reverses_entry_id, expires_at,
      actor_tenant_user_id, reason, created_at,
      ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_commerce_loyalty_ledger
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${boundedLimit}
  `) as (LedgerRow & { created_at_cursor: string })[];

  const last = rows[rows.length - 1];
  return {
    items: rows.map(toLedgerEntry),
    nextCursor:
      rows.length === boundedLimit && last
        ? encodeKeysetCursor(last.created_at_cursor, last.id)
        : null
  };
}

// ---------------------------------------------------------------------------
// Reporting summary
// ---------------------------------------------------------------------------

export type LoyaltySummary = {
  /** The window the `period` figures cover; `null` bounds mean unbounded. */
  from: string | null;
  to: string | null;
  period: {
    entries: number;
    earned: number;
    redeemed: number;
    expired: number;
    /** Signed net of manual adjustments. */
    adjustmentsNet: number;
    /** Points taken back by reversals (a magnitude). */
    reversed: number;
    /** `earned - redeemed - expired + adjustmentsNet - reversed`. */
    net: number;
  };
  /** Σ of every ledger row ever — the authoritative points in circulation. */
  outstanding: number;
  accounts: number;
  accountsWithNegativeBalance: number;
};

/**
 * Earned / redeemed / expired / outstanding without double counting: every
 * figure is a SUM over the single ledger, grouped by `kind`, so one point is
 * counted once (an `earn` is only ever in `earned`; its later `expire` or
 * `reversal` is a different row in a different bucket). `outstanding` is the
 * ledger's all-time sum, NOT the projection — so it stays right even if a
 * projection has drifted (`reconcile` reports that separately).
 */
export async function fetchLoyaltySummary(
  tx: Bun.SQL,
  tenantId: string,
  range: { from?: Date; to?: Date }
): Promise<LoyaltySummary> {
  const rows = (await tx`
    SELECT kind, COUNT(*)::int AS entries, COALESCE(SUM(points), 0) AS points
    FROM awcms_commerce_loyalty_ledger
    WHERE tenant_id = ${tenantId}
      AND (${range.from ?? null}::timestamptz IS NULL OR created_at >= ${range.from ?? null})
      AND (${range.to ?? null}::timestamptz IS NULL OR created_at < ${range.to ?? null})
    GROUP BY kind
  `) as { kind: string; entries: number; points: string | number }[];

  const sums: Record<string, number> = {};
  let entries = 0;
  for (const row of rows) {
    sums[row.kind] = Number(row.points);
    entries += Number(row.entries);
  }

  const earned = sums.earn ?? 0;
  const redeemed = -(sums.redeem ?? 0);
  const expired = -(sums.expire ?? 0);
  const adjustmentsNet = sums.adjustment ?? 0;
  const reversed = -(sums.reversal ?? 0);

  const totals = (await tx`
    SELECT
      (SELECT COALESCE(SUM(points), 0) FROM awcms_commerce_loyalty_ledger
        WHERE tenant_id = ${tenantId}) AS outstanding,
      (SELECT COUNT(*)::int FROM awcms_commerce_loyalty_accounts
        WHERE tenant_id = ${tenantId}) AS accounts,
      (SELECT COUNT(*)::int FROM awcms_commerce_loyalty_accounts
        WHERE tenant_id = ${tenantId} AND balance < 0) AS negative_accounts
  `) as {
    outstanding: string | number;
    accounts: number;
    negative_accounts: number;
  }[];
  const total = totals[0]!;

  return {
    from: range.from?.toISOString() ?? null,
    to: range.to?.toISOString() ?? null,
    period: {
      entries,
      earned,
      redeemed,
      expired,
      adjustmentsNet,
      reversed,
      net: earned - redeemed - expired + adjustmentsNet - reversed
    },
    outstanding: Number(total.outstanding),
    accounts: Number(total.accounts),
    accountsWithNegativeBalance: Number(total.negative_accounts)
  };
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export type LoyaltyDrift = {
  accountId: string;
  customerId: string;
  projectedBalance: number;
  ledgerBalance: number;
  projectedVersion: number;
  ledgerVersion: number;
};

export type LoyaltyReconcileReport = {
  accountsChecked: number;
  /** Accounts whose projection (`balance`/`version`) disagrees with the ledger. */
  drifted: LoyaltyDrift[];
  /** Accounts with a ledger row whose running `balance_after` is not the running sum — a tampered/corrupt ledger no projection rewrite can fix. */
  ledgerBreaks: { accountId: string; badRows: number }[];
  /**
   * Drifted accounts whose surviving ledger is NOT a complete history (it does
   * not start at `account_seq = 1`, has gaps, or is empty while the projection
   * is not) — a retention purge aged the early rows out. `SUM(ledger)` is then
   * not the balance, so these are never repaired, only reported. A subset of
   * `drifted`.
   */
  unrepairable: { accountId: string; reason: "unrepairable_history_purged" }[];
  /** Projections rewritten (only with `repair: true`). */
  repaired: number;
};

/**
 * Recomputes every account's balance from the ledger and compares it with the
 * projection. Read-only unless `repair` is set, in which case each drifted
 * account is locked and ONLY its projection (`balance`, `version`) is
 * rewritten from the ledger, with one audit event per repair — the ledger is
 * never edited. A `ledgerBreak` (a row whose `balance_after` is not the
 * running sum) is reported, never "repaired": there is no safe automatic
 * answer to an append-only table that disagrees with itself.
 *
 * Only a COMPLETE history is repaired from `SUM(ledger)`: the retention purge
 * ages early ledger rows out, after which the survivors no longer sum to the
 * balance, and "repairing" would zero a real balance. An account whose
 * surviving ledger does not start at `account_seq = 1` (or has gaps, or is
 * empty while the projection is not) is reported as
 * `unrepairable_history_purged` and left untouched.
 */
export async function reconcileLoyaltyForTenant(
  tx: Bun.SQL,
  tenantId: string,
  options: {
    repair: boolean;
    actorTenantUserId?: string;
    correlationId?: string;
    limit?: number;
  }
): Promise<LoyaltyReconcileReport> {
  const limit = options.limit ?? 1000;

  const driftRows = (await tx`
    SELECT a.id, a.customer_id, a.balance, a.version,
      COALESCE(SUM(l.points), 0) AS ledger_balance,
      COALESCE(MAX(l.account_seq), 0) AS ledger_version,
      COUNT(l.id) AS ledger_count
    FROM awcms_commerce_loyalty_accounts a
    LEFT JOIN awcms_commerce_loyalty_ledger l
      ON l.tenant_id = a.tenant_id AND l.account_id = a.id
    WHERE a.tenant_id = ${tenantId}
    GROUP BY a.id, a.customer_id, a.balance, a.version
    HAVING a.balance <> COALESCE(SUM(l.points), 0)
      OR a.version <> COALESCE(MAX(l.account_seq), 0)
      OR a.version <> COUNT(l.id)
    ORDER BY a.id
    LIMIT ${limit}
  `) as {
    id: string;
    customer_id: string;
    balance: string | number | bigint;
    version: string | number | bigint;
    ledger_balance: string | number;
    ledger_version: string | number | bigint;
  }[];

  const breakRows = (await tx`
    SELECT account_id, COUNT(*)::int AS bad_rows
    FROM (
      SELECT account_id,
        balance_after - SUM(points) OVER (
          PARTITION BY account_id ORDER BY account_seq
        ) AS diff
      FROM awcms_commerce_loyalty_ledger
      WHERE tenant_id = ${tenantId}
    ) running
    WHERE diff <> 0
    GROUP BY account_id
    ORDER BY account_id
    LIMIT ${limit}
  `) as { account_id: string; bad_rows: number }[];

  const countRows = (await tx`
    SELECT COUNT(*)::int AS accounts
    FROM awcms_commerce_loyalty_accounts WHERE tenant_id = ${tenantId}
  `) as { accounts: number }[];

  const drifted: LoyaltyDrift[] = driftRows.map((row) => ({
    accountId: row.id,
    customerId: row.customer_id,
    projectedBalance: assertPoints(row.balance),
    ledgerBalance: Number(row.ledger_balance),
    projectedVersion: assertPoints(row.version),
    ledgerVersion: assertPoints(row.ledger_version)
  }));

  const unrepairable: LoyaltyReconcileReport["unrepairable"] = [];
  const unrepairableIds = new Set<string>();
  const markUnrepairable = (accountId: string) => {
    if (unrepairableIds.has(accountId)) return;
    unrepairableIds.add(accountId);
    unrepairable.push({
      accountId,
      reason: "unrepairable_history_purged"
    });
  };
  // A history is complete only when it starts at 1 and has no gaps.
  const isCompleteHistory = (stats: {
    count: number;
    minSeq: number;
    maxSeq: number;
  }) => stats.count > 0 && stats.minSeq === 1 && stats.maxSeq === stats.count;

  for (const drift of drifted) {
    const stats = (await tx`
      SELECT COUNT(*)::int AS count,
        COALESCE(MIN(account_seq), 0)::int AS min_seq,
        COALESCE(MAX(account_seq), 0)::int AS max_seq
      FROM awcms_commerce_loyalty_ledger
      WHERE tenant_id = ${tenantId} AND account_id = ${drift.accountId}
    `) as { count: number; min_seq: number; max_seq: number }[];
    if (
      !isCompleteHistory({
        count: Number(stats[0]!.count),
        minSeq: Number(stats[0]!.min_seq),
        maxSeq: Number(stats[0]!.max_seq)
      })
    ) {
      markUnrepairable(drift.accountId);
    }
  }

  let repaired = 0;
  if (options.repair) {
    for (const drift of drifted) {
      const locked = await lockAccountById(tx, tenantId, drift.accountId);
      if (!locked) continue;
      // Recompute under the lock: the figure in the report may be stale.
      const fresh = (await tx`
        SELECT COALESCE(SUM(points), 0) AS balance,
          COALESCE(MAX(account_seq), 0) AS version,
          COUNT(*)::int AS count,
          COALESCE(MIN(account_seq), 0)::int AS min_seq
        FROM awcms_commerce_loyalty_ledger
        WHERE tenant_id = ${tenantId} AND account_id = ${drift.accountId}
      `) as {
        balance: string | number;
        version: string | number | bigint;
        count: number;
        min_seq: number;
      }[];
      const balance = Number(fresh[0]!.balance);
      const version = assertPoints(fresh[0]!.version);
      if (
        !isCompleteHistory({
          count: Number(fresh[0]!.count),
          minSeq: Number(fresh[0]!.min_seq),
          maxSeq: version
        })
      ) {
        markUnrepairable(drift.accountId);
        continue;
      }
      if (balance === locked.balance && version === locked.version) continue;

      await tx`
        UPDATE awcms_commerce_loyalty_accounts
        SET balance = ${balance}, version = ${version}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${drift.accountId}
      `;
      await recordAuditEvent(tx, {
        tenantId,
        actorTenantUserId: options.actorTenantUserId,
        moduleKey: AUDIT_MODULE_KEY,
        action: "commerce.loyalty.projection_repaired",
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: drift.accountId,
        severity: "warning",
        message: `Loyalty balance projection repaired from the ledger (${locked.balance} -> ${balance}).`,
        attributes: {
          accountId: drift.accountId,
          before: { balance: locked.balance, version: locked.version },
          after: { balance, version }
        },
        correlationId: options.correlationId
      });
      repaired += 1;
    }
  }

  return {
    accountsChecked: Number(countRows[0]?.accounts ?? 0),
    drifted,
    ledgerBreaks: breakRows.map((row) => ({
      accountId: row.account_id,
      badRows: Number(row.bad_rows)
    })),
    unrepairable,
    repaired
  };
}

/** What the signed-in customer sees: their own balance, the rule in force, and their history. */
export type CustomerLoyaltyOverview = {
  balance: number;
  program: {
    name: string;
    earnUnitAmount: string;
    earnPointsPerUnit: number;
    minOrderAmount: string;
    maxPointsPerOrder: number | null;
    expiryDays: number | null;
  } | null;
  history: { items: CustomerLoyaltyHistoryItem[]; nextCursor: string | null };
};

/**
 * The storefront `account/loyalty` read, as one function so the route and its
 * test run the SAME code. `customerId` MUST be the verified bearer session's
 * own customer — this function takes no other identifier and every query is
 * keyed by it (the account is resolved FROM the customer, the ledger is read
 * for THAT account), so there is nothing a caller could vary to see another
 * customer's rows. The projection drops the staff actor, the free-text reason
 * and the source/program ids.
 */
export async function fetchCustomerLoyaltyOverview(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  page: { cursor: KeysetCursor | null; limit: number },
  now: Date
): Promise<CustomerLoyaltyOverview> {
  const account = await fetchLoyaltyAccountForCustomer(
    tx,
    tenantId,
    customerId
  );
  const history = account
    ? await listLedgerForAccount(
        tx,
        tenantId,
        account.id,
        page.cursor,
        page.limit
      )
    : { items: [], nextCursor: null };
  const program = await fetchEffectiveProgramAt(tx, tenantId, now);

  return {
    balance: account?.balance ?? 0,
    program: program
      ? {
          name: program.name,
          earnUnitAmount: program.earnUnitAmount,
          earnPointsPerUnit: program.earnPointsPerUnit,
          minOrderAmount: program.minOrderAmount,
          maxPointsPerOrder: program.maxPointsPerOrder,
          expiryDays: program.expiryDays
        }
      : null,
    history: {
      items: history.items.map(toCustomerHistoryItem),
      nextCursor: history.nextCursor
    }
  };
}

/** Whether loyalty is enabled for the tenant — the shared gate the storefront/owner routes use. */
export async function isLoyaltyEnabled(
  tx: Bun.SQL,
  tenantId: string
): Promise<boolean> {
  return (await fetchCommerceFeatures(tx, tenantId)).loyalty;
}
