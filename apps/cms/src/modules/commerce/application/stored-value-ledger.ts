/**
 * The closed-loop stored-value ledger — the SQL half of Issue #288 (epic #281,
 * ADR-0030). `domain/stored-value.ts` decides what the rows MEAN; this file
 * writes them. It makes NO provider/network call (ADR-0006): a redemption is a
 * pair of rows (the payment-allocation leg and the ledger entry) written in the
 * caller's transaction.
 *
 * ## One writer
 *
 * {@link appendStoredValueEntry} is the ONLY function in `src/` that inserts a
 * ledger row (`apps/cms/tests/commerce-stored-value-routes.test.ts` fails if
 * any other file does), and the database trigger it fires
 * (`awcms_commerce_stored_value_ledger_apply`, `sql/985`) is the ONLY thing
 * that moves an account's `balance`/`version`/`status`. The application checks
 * below are therefore a courtesy — they turn a refusal into a clean outcome
 * before a write — and never the enforcement: a caller that skipped them is
 * still refused by the database, and still cannot overdraw.
 *
 * ## Locking
 *
 * Every function that writes locks the account row `FOR NO KEY UPDATE` first
 * (see `sql/985`'s header for why not `FOR UPDATE`). When an order is also
 * involved the order is locked FIRST, always — order -> account — so a
 * redemption and a reversal can never deadlock; a POS sale that has no order
 * row yet locks its accounts (sorted by id) before inserting the order, which
 * no other transaction can reach. Two concurrent redemptions of one card
 * queue on the account: the second reads the first's committed balance and is
 * refused if it would overdraw.
 *
 * ## Atomicity of a refusal
 *
 * A route handler that RETURNS a response commits the transaction (only a
 * thrown error rolls back — `tenant-route.ts`). Every function here therefore
 * decides a refusal BEFORE writing anything the caller would not want to keep;
 * the one deliberate exception is the lazy expiry marker, which is true and
 * wanted whatever happens to the request that discovered it.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_STORED_VALUE_ACCOUNT_AGGREGATE_TYPE,
  COMMERCE_STORED_VALUE_ENTRY_RECORDED_EVENT_TYPE
} from "../domain/commerce-events";
import {
  evaluateEntry,
  maskStoredValueCode,
  normalizeSignedMoney,
  signedFromCents,
  signedToCents,
  storedValueSourceKeys,
  type AccountState,
  type EntryRefusal,
  type StoredValueAccountStatus,
  type StoredValueEntryKind,
  type StoredValueKind
} from "../domain/stored-value";
import { normalizeMoney } from "../domain/price-calculation";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "stored_value_account";
const PRODUCER_MODULE = "commerce";

// ---------------------------------------------------------------------------
// Types and row mapping
// ---------------------------------------------------------------------------

export type StoredValueActor =
  { kind: "tenant_user"; tenantUserId: string } | { kind: "system" };

export type StoredValueAccountRecord = {
  id: string;
  programId: string;
  kind: StoredValueKind;
  status: StoredValueAccountStatus;
  /** `numeric(14,2)` string — the projection of the ledger. */
  balance: string;
  version: number;
  /** `•••••••-•••••••-•••ABCD` — the only form of the code the API ever shows. */
  maskedCode: string;
  codeLast4: string;
  customerId: string | null;
  expiresAt: string | null;
  issuedByTenantUserId: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredValueEntryRecord = {
  id: string;
  accountId: string;
  kind: StoredValueEntryKind;
  /** Signed `numeric(14,2)` string. */
  amount: string;
  accountSeq: number;
  balanceAfter: string;
  allocationId: string | null;
  reason: string | null;
  actorKind: "tenant_user" | "system";
  actorTenantUserId: string | null;
  createdAt: string;
};

type AccountRow = {
  id: string;
  program_id: string;
  kind: string;
  code_last4: string;
  customer_id: string | null;
  status: string;
  balance: string;
  version: string | number;
  expires_at: Date | null;
  issued_by_tenant_user_id: string | null;
  last_activity_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export const STORED_VALUE_ACCOUNT_COLUMNS = `id, program_id, kind, code_last4, customer_id, status, balance, version,
  expires_at, issued_by_tenant_user_id, last_activity_at, created_at, updated_at`;

export function toAccountRecord(row: AccountRow): StoredValueAccountRecord {
  return {
    id: row.id,
    programId: row.program_id,
    kind: row.kind as StoredValueKind,
    status: row.status as StoredValueAccountStatus,
    balance: normalizeMoney(String(row.balance)),
    version: Number(row.version),
    maskedCode: maskStoredValueCode(row.code_last4),
    codeLast4: row.code_last4,
    customerId: row.customer_id,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    issuedByTenantUserId: row.issued_by_tenant_user_id,
    lastActivityAt: row.last_activity_at
      ? row.last_activity_at.toISOString()
      : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

type EntryRow = {
  id: string;
  account_id: string;
  kind: string;
  amount: string;
  account_seq: string | number;
  balance_after: string;
  allocation_id: string | null;
  reason: string | null;
  actor_kind: string;
  actor_tenant_user_id: string | null;
  created_at: Date;
};

export const STORED_VALUE_ENTRY_COLUMNS = `id, account_id, kind, amount, account_seq, balance_after, allocation_id,
  reason, actor_kind, actor_tenant_user_id, created_at`;

export function toEntryRecord(row: EntryRow): StoredValueEntryRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind as StoredValueEntryKind,
    amount: normalizeSignedMoney(String(row.amount)),
    accountSeq: Number(row.account_seq),
    balanceAfter: normalizeMoney(String(row.balance_after)),
    allocationId: row.allocation_id,
    reason: row.reason,
    actorKind: row.actor_kind as "tenant_user" | "system",
    actorTenantUserId: row.actor_tenant_user_id,
    createdAt: row.created_at.toISOString()
  };
}

function actorColumns(actor: StoredValueActor): {
  kind: "tenant_user" | "system";
  tenantUserId: string | null;
} {
  return actor.kind === "tenant_user"
    ? { kind: "tenant_user", tenantUserId: actor.tenantUserId }
    : { kind: "system", tenantUserId: null };
}

/** An invariant that cannot hold unless a caller skipped a check it owns; never mapped to a response (so the request's transaction rolls back). */
export class StoredValueInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoredValueInvariantError";
  }
}

export class StoredValueSourceKeyConflictError extends Error {
  constructor() {
    super(
      "The source key was already used for a different stored-value account."
    );
    this.name = "StoredValueSourceKeyConflictError";
  }
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

export type LockedStoredValueAccount = StoredValueAccountRecord & {
  /** The database clock at lock time (the same clock the trigger uses). */
  dbNow: Date;
  lapsed: boolean;
  expiresAtDate: Date | null;
  balanceCents: bigint;
  program: {
    enabled: boolean;
    allowRefundToAccount: boolean;
    /** `numeric(14,2)` string or `null` (no ceiling). */
    maxBalance: string | null;
  };
};

/**
 * Locks the account `FOR NO KEY UPDATE` and returns it with the program
 * settings the write rules need. `null` for an unknown, soft-deleted or
 * other-tenant account — one answer for all three (RLS + the explicit tenant
 * filter), never distinguishable.
 */
export async function lockStoredValueAccount(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string
): Promise<LockedStoredValueAccount | null> {
  const rows = (await tx`
    SELECT a.id, a.program_id, a.kind, a.code_last4, a.customer_id, a.status, a.balance, a.version,
           a.expires_at, a.issued_by_tenant_user_id, a.last_activity_at, a.created_at, a.updated_at,
           (a.expires_at IS NOT NULL AND a.expires_at <= clock_timestamp()) AS lapsed,
           clock_timestamp() AS db_now,
           p.enabled AS program_enabled,
           p.allow_refund_to_account AS program_allow_refund,
           p.max_balance AS program_max_balance
    FROM awcms_commerce_stored_value_accounts a
    JOIN awcms_commerce_stored_value_programs p
      ON p.tenant_id = a.tenant_id AND p.id = a.program_id
    WHERE a.tenant_id = ${tenantId} AND a.id = ${accountId} AND a.deleted_at IS NULL
    FOR NO KEY UPDATE OF a
  `) as (AccountRow & {
    lapsed: boolean;
    db_now: Date;
    program_enabled: boolean;
    program_allow_refund: boolean;
    program_max_balance: string | null;
  })[];
  const row = rows[0];
  if (!row) return null;
  const record = toAccountRecord(row);
  return {
    ...record,
    dbNow: row.db_now,
    lapsed: row.lapsed,
    expiresAtDate: row.expires_at,
    balanceCents: signedToCents(record.balance),
    program: {
      enabled: row.program_enabled,
      allowRefundToAccount: row.program_allow_refund,
      maxBalance:
        row.program_max_balance !== null
          ? normalizeMoney(String(row.program_max_balance))
          : null
    }
  };
}

function stateOf(account: LockedStoredValueAccount): AccountState {
  return {
    status: account.status,
    balanceCents: account.balanceCents,
    version: account.version,
    expiresAt: account.expiresAtDate
  };
}

export async function fetchAccountRecord(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string
): Promise<StoredValueAccountRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(STORED_VALUE_ACCOUNT_COLUMNS)}
    FROM awcms_commerce_stored_value_accounts
    WHERE tenant_id = ${tenantId} AND id = ${accountId} AND deleted_at IS NULL
  `) as AccountRow[];
  return rows[0] ? toAccountRecord(rows[0]) : null;
}

async function findEntryBySourceKey(
  tx: Bun.SQL,
  tenantId: string,
  sourceKey: string
): Promise<StoredValueEntryRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(STORED_VALUE_ENTRY_COLUMNS)}
    FROM awcms_commerce_stored_value_ledger
    WHERE tenant_id = ${tenantId} AND source_key = ${sourceKey}
  `) as EntryRow[];
  return rows[0] ? toEntryRecord(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// The single writer
// ---------------------------------------------------------------------------

export type AppendStoredValueEntryParams = {
  accountId: string;
  kind: StoredValueEntryKind;
  /** Signed `numeric(14,2)` string — the sign must agree with `kind` (the table's CHECK). */
  amount: string;
  reason?: string | null;
  /** Row-level idempotency key — unique per tenant (`sql/985`). */
  sourceKey: string;
  actor: StoredValueActor;
  /** `redeem` / `refund` only: the payment-allocation row this entry mirrors. */
  allocationId?: string | null;
  correlationId?: string;
};

export type StoredValueEntryRefusal = EntryRefusal | "BALANCE_CEILING";

export type AppendStoredValueEntryOutcome =
  | { kind: "account_not_found" }
  | {
      kind: "refused";
      refusal: StoredValueEntryRefusal;
      /** The balance at the moment of refusal, `numeric(14,2)`. */
      available: string;
      /** `BALANCE_CEILING` only: the program's ceiling. */
      ceiling: string | null;
    }
  | {
      kind: "deduplicated";
      entry: StoredValueEntryRecord;
      account: StoredValueAccountRecord;
    }
  | {
      kind: "recorded";
      entry: StoredValueEntryRecord;
      account: StoredValueAccountRecord;
    };

/**
 * Appends ONE ledger entry to an account, atomically with the account lock.
 * Idempotent on `sourceKey`: a replay returns `{ kind: "deduplicated" }` with
 * the original entry and writes nothing; a key already used for a DIFFERENT
 * account is a programming error ({@link StoredValueSourceKeyConflictError}).
 *
 * The audit event and the domain event are written here, in the same
 * transaction, so no entry can exist without them (and a rolled-back
 * transaction leaves neither).
 */
export async function appendStoredValueEntry(
  tx: Bun.SQL,
  tenantId: string,
  params: AppendStoredValueEntryParams,
  preLocked?: LockedStoredValueAccount
): Promise<AppendStoredValueEntryOutcome> {
  const account =
    preLocked ?? (await lockStoredValueAccount(tx, tenantId, params.accountId));
  if (!account) return { kind: "account_not_found" };

  const existing = await findEntryBySourceKey(tx, tenantId, params.sourceKey);
  if (existing) {
    if (existing.accountId !== params.accountId) {
      throw new StoredValueSourceKeyConflictError();
    }
    return {
      kind: "deduplicated",
      entry: existing,
      account: (await fetchAccountRecord(tx, tenantId, params.accountId))!
    };
  }

  const amountCents = signedToCents(params.amount);
  const verdict = evaluateEntry(
    stateOf(account),
    params.kind,
    amountCents,
    account.dbNow
  );
  if (!verdict.ok) {
    return {
      kind: "refused",
      refusal: verdict.refusal,
      available: signedFromCents(verdict.available),
      ceiling: null
    };
  }
  if (
    (params.kind === "issue" ||
      params.kind === "load" ||
      params.kind === "adjust") &&
    amountCents > 0n &&
    account.program.maxBalance !== null &&
    verdict.next.balanceCents > signedToCents(account.program.maxBalance)
  ) {
    return {
      kind: "refused",
      refusal: "BALANCE_CEILING",
      available: signedFromCents(account.balanceCents),
      ceiling: account.program.maxBalance
    };
  }

  const actor = actorColumns(params.actor);
  const rows = (await tx`
    INSERT INTO awcms_commerce_stored_value_ledger (
      tenant_id, account_id, kind, amount, allocation_id, reason,
      source_key, actor_kind, actor_tenant_user_id,
      account_seq, balance_after
    )
    VALUES (
      ${tenantId}, ${params.accountId}, ${params.kind}, ${signedFromCents(amountCents)},
      ${params.allocationId ?? null}, ${params.reason ?? null},
      ${params.sourceKey}, ${actor.kind}, ${actor.tenantUserId},
      0, 0
    )
    RETURNING ${tx.unsafe(STORED_VALUE_ENTRY_COLUMNS)}
  `) as EntryRow[];
  // `account_seq`/`balance_after` are placeholders the BEFORE INSERT trigger
  // overwrites (the CHECKs run after it); the RETURNING row carries the
  // trigger's values.
  const entry = toEntryRecord(rows[0]!);
  const after = (await fetchAccountRecord(tx, tenantId, params.accountId))!;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId:
      params.actor.kind === "tenant_user"
        ? params.actor.tenantUserId
        : undefined,
    moduleKey: AUDIT_MODULE_KEY,
    action: `stored_value.${params.kind}`,
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: params.accountId,
    message: `Stored value ${params.kind} of ${entry.amount} recorded on account ${params.accountId}.`,
    // Ids, kinds and money only — never the code (which is not stored), the
    // customer, or the free-text reason (which can name a person).
    attributes: {
      accountId: params.accountId,
      accountKind: after.kind,
      entryKind: params.kind,
      amount: entry.amount,
      balanceAfter: entry.balanceAfter,
      accountStatus: after.status,
      allocationId: entry.allocationId
    },
    correlationId: params.correlationId
  });

  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_STORED_VALUE_ENTRY_RECORDED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_STORED_VALUE_ACCOUNT_AGGREGATE_TYPE,
    aggregateId: params.accountId,
    producerModule: PRODUCER_MODULE,
    correlationId: params.correlationId,
    actorTenantUserId:
      params.actor.kind === "tenant_user"
        ? params.actor.tenantUserId
        : undefined,
    payload: {
      entryId: entry.id,
      accountId: params.accountId,
      accountKind: after.kind,
      entryKind: params.kind,
      amount: entry.amount,
      balanceAfter: entry.balanceAfter,
      ...(entry.allocationId ? { allocationId: entry.allocationId } : {})
    }
  });

  return { kind: "recorded", entry, account: after };
}

/**
 * If the (locked) account has passed its expiry and is not yet `expired`,
 * appends the `expire` entry that releases its whole balance and returns the
 * refreshed account; otherwise returns it unchanged. Called wherever an
 * account is about to be USED, so a lapsed balance can never be spent however
 * rarely the sweep runs. Idempotent per (account, expiry instant).
 */
export async function settleLapse(
  tx: Bun.SQL,
  tenantId: string,
  account: LockedStoredValueAccount,
  correlationId?: string
): Promise<LockedStoredValueAccount> {
  if (!account.lapsed || account.status === "expired") return account;
  const outcome = await appendStoredValueEntry(
    tx,
    tenantId,
    {
      accountId: account.id,
      kind: "expire",
      amount: signedFromCents(-account.balanceCents),
      reason: null,
      sourceKey: storedValueSourceKeys.expire(
        account.id,
        account.expiresAtDate!
      ),
      actor: { kind: "system" },
      correlationId
    },
    account
  );
  if (outcome.kind === "refused") {
    throw new StoredValueInvariantError(
      `A lapsed account could not be expired (${outcome.refusal}).`
    );
  }
  return (await lockStoredValueAccount(tx, tenantId, account.id))!;
}

// ---------------------------------------------------------------------------
// Payment-ledger integration (called by `payment-allocation-directory.ts`)
// ---------------------------------------------------------------------------

export type StoredValueRedeemRefusal =
  "NOT_FOUND" | "KIND_MISMATCH" | "UNAVAILABLE" | "EXPIRED" | "INSUFFICIENT";

/**
 * Locks the account and decides whether `amount` can be redeemed from it NOW
 * — without writing the redemption. Disabled / expired / lapsed / too poor /
 * wrong kind are refusals; the lazy-expiry marker is the one thing it may
 * write (see this file's header). A program that was switched off still lets
 * its outstanding value be spent: `enabled` governs ISSUING and LOADING only.
 */
export async function checkStoredValueRedeemable(
  tx: Bun.SQL,
  tenantId: string,
  params: {
    accountId: string;
    tenderType: StoredValueKind;
    /** `numeric(14,2)` string, > 0. */
    amount: string;
  }
): Promise<
  | { ok: true; available: string }
  | { ok: false; refusal: StoredValueRedeemRefusal; available: string }
> {
  let account = await lockStoredValueAccount(tx, tenantId, params.accountId);
  if (!account) return { ok: false, refusal: "NOT_FOUND", available: "0.00" };
  if (account.kind !== params.tenderType) {
    return { ok: false, refusal: "KIND_MISMATCH", available: "0.00" };
  }
  account = await settleLapse(tx, tenantId, account);
  const verdict = evaluateEntry(
    stateOf(account),
    "redeem",
    -signedToCents(params.amount),
    account.dbNow
  );
  if (verdict.ok) return { ok: true, available: account.balance };
  const refusal: StoredValueRedeemRefusal =
    verdict.refusal === "INSUFFICIENT"
      ? "INSUFFICIENT"
      : verdict.refusal === "ACCOUNT_EXPIRED" ||
          verdict.refusal === "ACCOUNT_LAPSED"
        ? "EXPIRED"
        : "UNAVAILABLE";
  return { ok: false, refusal, available: account.balance };
}

export type StoredValueRefundRefusal =
  "stored_value_refund_not_allowed" | "stored_value_account_unavailable";

/** The compensating twin of {@link checkStoredValueRedeemable}: may a reversal return value to this account? */
export async function checkStoredValueRefundable(
  tx: Bun.SQL,
  tenantId: string,
  params: { accountId: string }
): Promise<{ ok: true } | { ok: false; refusal: StoredValueRefundRefusal }> {
  let account = await lockStoredValueAccount(tx, tenantId, params.accountId);
  if (!account) {
    return { ok: false, refusal: "stored_value_account_unavailable" };
  }
  if (!account.program.allowRefundToAccount) {
    return { ok: false, refusal: "stored_value_refund_not_allowed" };
  }
  account = await settleLapse(tx, tenantId, account);
  const verdict = evaluateEntry(stateOf(account), "refund", 1n, account.dbNow);
  return verdict.ok
    ? { ok: true }
    : { ok: false, refusal: "stored_value_account_unavailable" };
}

export type StoredValueLoadRefusal =
  | "NOT_FOUND"
  | "KIND_MISMATCH"
  | "PROGRAM_DISABLED"
  | "UNAVAILABLE"
  | "EXPIRED"
  | "BALANCE_CEILING";

/**
 * Locks the account and decides whether `amount` can be LOADED onto it now -
 * without writing the load (Issue #287: a refund into store credit decides
 * every refusal before it writes the payment-ledger reversal). The mirror of
 * {@link checkStoredValueRedeemable}: wrong kind, a switched-off program,
 * disabled / expired / lapsed account and the balance ceiling are refusals.
 */
export async function checkStoredValueLoadable(
  tx: Bun.SQL,
  tenantId: string,
  params: {
    accountId: string;
    kind: StoredValueKind;
    /** `numeric(14,2)` string, > 0. */
    amount: string;
  }
): Promise<{ ok: true } | { ok: false; refusal: StoredValueLoadRefusal }> {
  let account = await lockStoredValueAccount(tx, tenantId, params.accountId);
  if (!account) return { ok: false, refusal: "NOT_FOUND" };
  if (account.kind !== params.kind) {
    return { ok: false, refusal: "KIND_MISMATCH" };
  }
  if (!account.program.enabled) {
    return { ok: false, refusal: "PROGRAM_DISABLED" };
  }
  account = await settleLapse(tx, tenantId, account);
  const amountCents = signedToCents(params.amount);
  const verdict = evaluateEntry(
    stateOf(account),
    "load",
    amountCents,
    account.dbNow
  );
  if (!verdict.ok) {
    return {
      ok: false,
      refusal:
        verdict.refusal === "ACCOUNT_EXPIRED" ||
        verdict.refusal === "ACCOUNT_LAPSED"
          ? "EXPIRED"
          : "UNAVAILABLE"
    };
  }
  if (
    account.program.maxBalance !== null &&
    verdict.next.balanceCents > signedToCents(account.program.maxBalance)
  ) {
    return { ok: false, refusal: "BALANCE_CEILING" };
  }
  return { ok: true };
}

type MirrorParams = {
  accountId: string;
  allocationId: string;
  /** The allocation's applied amount, `numeric(14,2)`, > 0. */
  amount: string;
  allocationSourceKey: string;
  actor: StoredValueActor;
  correlationId?: string;
};

/** The `redeem` entry mirroring a just-inserted payment-allocation leg. Throws {@link StoredValueInvariantError} if the check that preceded it was skipped. */
export async function redeemForAllocation(
  tx: Bun.SQL,
  tenantId: string,
  params: MirrorParams
): Promise<StoredValueEntryRecord> {
  const outcome = await appendStoredValueEntry(tx, tenantId, {
    accountId: params.accountId,
    kind: "redeem",
    amount: signedFromCents(-signedToCents(params.amount)),
    sourceKey: storedValueSourceKeys.redeem(params.allocationSourceKey),
    allocationId: params.allocationId,
    actor: params.actor,
    correlationId: params.correlationId
  });
  if (outcome.kind !== "recorded") {
    throw new StoredValueInvariantError(
      `A stored-value redemption could not be mirrored (${outcome.kind}${
        outcome.kind === "refused" ? `: ${outcome.refusal}` : ""
      }).`
    );
  }
  return outcome.entry;
}

/** The `refund` entry mirroring a just-inserted payment-allocation reversal. */
export async function refundForReversal(
  tx: Bun.SQL,
  tenantId: string,
  params: MirrorParams
): Promise<StoredValueEntryRecord> {
  const outcome = await appendStoredValueEntry(tx, tenantId, {
    accountId: params.accountId,
    kind: "refund",
    amount: signedFromCents(signedToCents(params.amount)),
    sourceKey: storedValueSourceKeys.refund(params.allocationSourceKey),
    allocationId: params.allocationId,
    actor: params.actor,
    correlationId: params.correlationId
  });
  if (outcome.kind !== "recorded") {
    throw new StoredValueInvariantError(
      `A stored-value refund could not be mirrored (${outcome.kind}${
        outcome.kind === "refused" ? `: ${outcome.refusal}` : ""
      }).`
    );
  }
  return outcome.entry;
}
