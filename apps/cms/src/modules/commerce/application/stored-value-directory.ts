/**
 * Stored-value programs, accounts and the owner-side mutations over them
 * (Issue #288, epic #281, ADR-0030). `stored-value-ledger.ts` is the one
 * writer of ledger rows; everything here composes it with the shared
 * idempotency store, the program configuration and the read models the admin
 * screens and reports need.
 *
 * ## Idempotency (skill `awcms-idempotency`)
 *
 * Two independent layers. The shared `awcms_idempotency_keys` store gives HTTP
 * replay/conflict semantics (the hash binds the actor and the resource ids);
 * the ledger's own `UNIQUE (tenant_id, source_key)` is the second guard.
 * Mutations on an existing account lock it FIRST and read the store AFTER, so
 * a retry that waited for the original replays its committed record; ISSUING
 * (which has no row to lock yet) serialises on a per-key advisory lock
 * instead.
 *
 * ## The code is returned once
 *
 * {@link issueStoredValueAccount} generates the code, stores only its hash and
 * last four, and returns the plaintext in the response to THAT request. The
 * response saved in the idempotency store has `code: null` — a replay (or a
 * retry after a lost response) answers `codeRevealed: false`; the remedy for a
 * lost code is to disable the account and issue a new one, never to make the
 * plaintext recoverable.
 */
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
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  computeExpiresAt,
  formatStoredValueCode,
  generateStoredValueCode,
  hashStoredValueCode,
  signedFromCents,
  signedToCents,
  storedValueCodeLast4,
  storedValueSourceKeys,
  type AdjustAccountInput,
  type ChangeStatusInput,
  type IssueAccountInput,
  type LoadAccountInput,
  type StoredValueAccountStatus,
  type StoredValueEntryKind,
  type StoredValueKind,
  type UpsertProgramInput
} from "../domain/stored-value";
import {
  fromCents,
  normalizeMoney,
  toCents
} from "../domain/price-calculation";
import { IdempotencyPayloadMismatchError } from "./order-directory";
import {
  appendStoredValueEntry,
  fetchAccountRecord,
  lockStoredValueAccount,
  settleLapse,
  STORED_VALUE_ACCOUNT_COLUMNS,
  STORED_VALUE_ENTRY_COLUMNS,
  toAccountRecord,
  toEntryRecord,
  type StoredValueAccountRecord,
  type StoredValueActor,
  type StoredValueEntryRecord,
  type StoredValueEntryRefusal
} from "./stored-value-ledger";
import { StoredValueInvariantError } from "./stored-value-ledger";

const AUDIT_MODULE_KEY = "commerce";
const ISSUE_SCOPE = "commerce.stored_value.issue";
const LOAD_SCOPE = "commerce.stored_value.load";
const ADJUST_SCOPE = "commerce.stored_value.adjust";
const STATUS_SCOPE = "commerce.stored_value.status";

export const STORED_VALUE_ACCOUNT_LIST_LIMIT = 50;
export const STORED_VALUE_LEDGER_PAGE_LIMIT = 100;
export const STORED_VALUE_SWEEP_BATCH = 200;
export const STORED_VALUE_RECONCILE_FINDING_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

export type StoredValueProgramRecord = {
  /** `null` until the tenant first saves the program (the defaults below apply meanwhile). */
  id: string | null;
  kind: StoredValueKind;
  configured: boolean;
  enabled: boolean;
  expiryDays: number | null;
  allowRefundToAccount: boolean;
  maxBalance: string | null;
  updatedAt: string | null;
};

type ProgramRow = {
  id: string;
  kind: string;
  enabled: boolean;
  expiry_days: number | null;
  allow_refund_to_account: boolean;
  max_balance: string | null;
  updated_at: Date;
};

const PROGRAM_KINDS: readonly StoredValueKind[] = ["gift_card", "store_credit"];

function toProgramRecord(row: ProgramRow): StoredValueProgramRecord {
  return {
    id: row.id,
    kind: row.kind as StoredValueKind,
    configured: true,
    enabled: row.enabled,
    expiryDays: row.expiry_days,
    allowRefundToAccount: row.allow_refund_to_account,
    maxBalance:
      row.max_balance !== null ? normalizeMoney(String(row.max_balance)) : null,
    updatedAt: row.updated_at.toISOString()
  };
}

function defaultProgram(kind: StoredValueKind): StoredValueProgramRecord {
  return {
    id: null,
    kind,
    configured: false,
    enabled: false,
    expiryDays: null,
    allowRefundToAccount: true,
    maxBalance: null,
    updatedAt: null
  };
}

/** Both kinds, always — an unconfigured one is reported with its (disabled) defaults. */
export async function listStoredValuePrograms(
  tx: Bun.SQL,
  tenantId: string
): Promise<StoredValueProgramRecord[]> {
  const rows = (await tx`
    SELECT id, kind, enabled, expiry_days, allow_refund_to_account, max_balance, updated_at
    FROM awcms_commerce_stored_value_programs
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
  `) as ProgramRow[];
  const byKind = new Map(rows.map((row) => [row.kind, toProgramRecord(row)]));
  return PROGRAM_KINDS.map((kind) => byKind.get(kind) ?? defaultProgram(kind));
}

export async function upsertStoredValueProgram(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  kind: StoredValueKind,
  input: UpsertProgramInput,
  correlationId?: string
): Promise<StoredValueProgramRecord> {
  const rows = (await tx`
    INSERT INTO awcms_commerce_stored_value_programs (
      tenant_id, kind, enabled, expiry_days, allow_refund_to_account, max_balance,
      updated_by_tenant_user_id
    )
    VALUES (
      ${tenantId}, ${kind}, ${input.enabled}, ${input.expiryDays},
      ${input.allowRefundToAccount}, ${input.maxBalance}, ${actorTenantUserId}
    )
    ON CONFLICT (tenant_id, kind) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        expiry_days = EXCLUDED.expiry_days,
        allow_refund_to_account = EXCLUDED.allow_refund_to_account,
        max_balance = EXCLUDED.max_balance,
        updated_by_tenant_user_id = EXCLUDED.updated_by_tenant_user_id,
        updated_at = now()
    RETURNING id, kind, enabled, expiry_days, allow_refund_to_account, max_balance, updated_at
  `) as ProgramRow[];
  const record = toProgramRecord(rows[0]!);
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "stored_value_program.update",
    resourceType: "stored_value_program",
    resourceId: record.id!,
    message: `Stored-value program ${kind} ${record.enabled ? "enabled" : "disabled"}.`,
    attributes: {
      kind,
      enabled: record.enabled,
      expiryDays: record.expiryDays,
      allowRefundToAccount: record.allowRefundToAccount,
      maxBalance: record.maxBalance
    },
    correlationId
  });
  return record;
}

async function fetchEnabledProgram(
  tx: Bun.SQL,
  tenantId: string,
  kind: StoredValueKind
): Promise<ProgramRow | null> {
  const rows = (await tx`
    SELECT id, kind, enabled, expiry_days, allow_refund_to_account, max_balance, updated_at
    FROM awcms_commerce_stored_value_programs
    WHERE tenant_id = ${tenantId} AND kind = ${kind} AND deleted_at IS NULL AND enabled
  `) as ProgramRow[];
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

/** The 201 body of an issue. `code` is the plaintext, present ONLY in the response to the request that created the account. */
export type IssueResponseBody = {
  account: StoredValueAccountRecord;
  entry: StoredValueEntryRecord;
  /** `XXXXXXX-XXXXXXX-XXXXXXX`, shown once; `null` on a replay. */
  code: string | null;
  codeRevealed: boolean;
};

export type IssueOutcome =
  | { kind: "program_unavailable" }
  | { kind: "customer_not_found" }
  | { kind: "ceiling"; ceiling: string }
  | { kind: "created"; body: IssueResponseBody }
  | { kind: "replayed"; body: IssueResponseBody };

/**
 * @throws {IdempotencyPayloadMismatchError} same key, different payload.
 */
export async function issueStoredValueAccount(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: IssueAccountInput,
  now: Date,
  correlationId?: string
): Promise<IssueOutcome> {
  // Nothing exists to row-lock for a brand-new account, so a same-key
  // concurrent request waits on this advisory lock, then finds the first one's
  // committed idempotency record and replays it.
  await tx`
    SELECT pg_advisory_xact_lock(hashtextextended(${`sv-issue:${tenantId}:${input.idempotencyKey}`}, 0))
  `;

  const requestHash = computeRequestHash({
    action: ISSUE_SCOPE,
    actorTenantUserId,
    kind: input.kind,
    amount: input.amount,
    customerId: input.customerId,
    expiresAt:
      input.expiresAt === undefined
        ? undefined
        : input.expiresAt === null
          ? null
          : input.expiresAt.toISOString(),
    reason: input.reason
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    ISSUE_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      body: existing.responseBody as IssueResponseBody
    };
  }

  // The ledger's own guard, for a key whose store record is gone.
  const sourceKey = storedValueSourceKeys.issue(input.idempotencyKey);
  const prior = (await tx`
    SELECT ${tx.unsafe(STORED_VALUE_ENTRY_COLUMNS)}
    FROM awcms_commerce_stored_value_ledger
    WHERE tenant_id = ${tenantId} AND source_key = ${sourceKey}
  `) as Parameters<typeof toEntryRecord>[0][];
  if (prior[0]) {
    const entry = toEntryRecord(prior[0]);
    const account = await fetchAccountRecord(tx, tenantId, entry.accountId);
    return {
      kind: "replayed",
      body: { account: account!, entry, code: null, codeRevealed: false }
    };
  }

  const program = await fetchEnabledProgram(tx, tenantId, input.kind);
  if (!program) return { kind: "program_unavailable" };

  if (input.customerId !== null) {
    const customers = (await tx`
      SELECT id FROM awcms_commerce_customers
      WHERE tenant_id = ${tenantId} AND id = ${input.customerId} AND deleted_at IS NULL
    `) as { id: string }[];
    if (customers.length === 0) return { kind: "customer_not_found" };
  }

  // The ceiling is decided BEFORE the account row exists: a returned response
  // commits, and an account without its issue entry could not.
  if (program.max_balance !== null) {
    const ceiling = normalizeMoney(String(program.max_balance));
    if (toCents(input.amount) > toCents(ceiling)) {
      return { kind: "ceiling", ceiling };
    }
  }

  const expiresAt =
    input.expiresAt === undefined
      ? computeExpiresAt(now, program.expiry_days)
      : input.expiresAt;

  const code = generateStoredValueCode();
  const accountRows = (await tx`
    INSERT INTO awcms_commerce_stored_value_accounts (
      tenant_id, program_id, kind, code_hash, code_last4, customer_id,
      expires_at, issued_by_tenant_user_id
    )
    VALUES (
      ${tenantId}, ${program.id}, ${input.kind}, ${hashStoredValueCode(tenantId, code)},
      ${storedValueCodeLast4(code)}, ${input.customerId}, ${expiresAt}, ${actorTenantUserId}
    )
    RETURNING id
  `) as { id: string }[];
  const accountId = accountRows[0]!.id;

  const appended = await appendStoredValueEntry(tx, tenantId, {
    accountId,
    kind: "issue",
    amount: input.amount,
    reason: input.reason,
    sourceKey,
    actor: { kind: "tenant_user", tenantUserId: actorTenantUserId },
    correlationId
  });
  if (appended.kind !== "recorded") {
    throw new StoredValueInvariantError(
      `An issue entry was refused after the pre-checks (${appended.kind}).`
    );
  }

  const stored: IssueResponseBody = {
    account: appended.account,
    entry: appended.entry,
    code: null,
    codeRevealed: false
  };
  await saveIdempotencyRecord(
    tx,
    tenantId,
    ISSUE_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    stored
  );
  return {
    kind: "created",
    body: {
      account: appended.account,
      entry: appended.entry,
      code: formatStoredValueCode(code),
      codeRevealed: true
    }
  };
}

// ---------------------------------------------------------------------------
// Load / adjust / disable / enable
// ---------------------------------------------------------------------------

export type AccountMutationBody = {
  account: StoredValueAccountRecord;
  entry: StoredValueEntryRecord;
};

export type AccountMutationOutcome =
  | { kind: "not_found" }
  | { kind: "program_disabled" }
  | {
      kind: "refused";
      refusal: StoredValueEntryRefusal;
      available: string;
      ceiling: string | null;
    }
  | { kind: "created" | "replayed"; body: AccountMutationBody };

type MutationSpec = {
  scope: string;
  idempotencyKey: string;
  hashPayload: Record<string, unknown>;
  entryKind: StoredValueEntryKind;
  amount: string;
  reason: string | null;
  sourceKey: (accountId: string) => string;
  /** Loading value honours the program switch; adjusting/disabling an existing balance does not. */
  requiresEnabledProgram: boolean;
};

async function mutateAccount(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  accountId: string,
  spec: MutationSpec,
  correlationId?: string
): Promise<AccountMutationOutcome> {
  // Lock FIRST, read the idempotency store AFTER (see this file's header).
  let account = await lockStoredValueAccount(tx, tenantId, accountId);
  if (!account) return { kind: "not_found" };

  const requestHash = computeRequestHash({
    action: spec.scope,
    actorTenantUserId,
    accountId,
    ...spec.hashPayload
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    spec.scope,
    spec.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      body: existing.responseBody as AccountMutationBody
    };
  }

  if (spec.requiresEnabledProgram && !account.program.enabled) {
    return { kind: "program_disabled" };
  }
  // A lapsed balance is released before anything else touches the account.
  account = await settleLapse(tx, tenantId, account, correlationId);

  const outcome = await appendStoredValueEntry(
    tx,
    tenantId,
    {
      accountId,
      kind: spec.entryKind,
      amount: spec.amount,
      reason: spec.reason,
      sourceKey: spec.sourceKey(accountId),
      actor: { kind: "tenant_user", tenantUserId: actorTenantUserId },
      correlationId
    },
    account
  );
  if (outcome.kind === "account_not_found") return { kind: "not_found" };
  if (outcome.kind === "refused") {
    return {
      kind: "refused",
      refusal: outcome.refusal,
      available: outcome.available,
      ceiling: outcome.ceiling
    };
  }
  const body: AccountMutationBody = {
    account: outcome.account,
    entry: outcome.entry
  };
  if (outcome.kind === "deduplicated") return { kind: "replayed", body };
  await saveIdempotencyRecord(
    tx,
    tenantId,
    spec.scope,
    spec.idempotencyKey,
    requestHash,
    201,
    body
  );
  return { kind: "created", body };
}

export function loadStoredValueAccount(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  accountId: string,
  input: LoadAccountInput,
  correlationId?: string
): Promise<AccountMutationOutcome> {
  return mutateAccount(
    tx,
    tenantId,
    actorTenantUserId,
    accountId,
    {
      scope: LOAD_SCOPE,
      idempotencyKey: input.idempotencyKey,
      hashPayload: { amount: input.amount, reason: input.reason },
      entryKind: "load",
      amount: input.amount,
      reason: input.reason,
      sourceKey: (id) => storedValueSourceKeys.load(id, input.idempotencyKey),
      requiresEnabledProgram: true
    },
    correlationId
  );
}

export function adjustStoredValueAccount(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  accountId: string,
  input: AdjustAccountInput,
  correlationId?: string
): Promise<AccountMutationOutcome> {
  return mutateAccount(
    tx,
    tenantId,
    actorTenantUserId,
    accountId,
    {
      scope: ADJUST_SCOPE,
      idempotencyKey: input.idempotencyKey,
      hashPayload: { amount: input.amount, reason: input.reason },
      entryKind: "adjust",
      amount: input.amount,
      reason: input.reason,
      sourceKey: (id) => storedValueSourceKeys.adjust(id, input.idempotencyKey),
      requiresEnabledProgram: false
    },
    correlationId
  );
}

export function changeStoredValueAccountStatus(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  accountId: string,
  input: ChangeStatusInput,
  correlationId?: string
): Promise<AccountMutationOutcome> {
  return mutateAccount(
    tx,
    tenantId,
    actorTenantUserId,
    accountId,
    {
      scope: STATUS_SCOPE,
      idempotencyKey: input.idempotencyKey,
      hashPayload: { action: input.action, reason: input.reason },
      entryKind: input.action,
      amount: "0.00",
      reason: input.reason,
      sourceKey: (id) => storedValueSourceKeys.status(id, input.idempotencyKey),
      requiresEnabledProgram: false
    },
    correlationId
  );
}

// ---------------------------------------------------------------------------
// Expiry sweep
// ---------------------------------------------------------------------------

export type ExpirySweepResult = {
  /** Accounts released in this run. */
  expired: number;
  /** Total value released (`numeric(14,2)`). */
  released: string;
  /** `true` when more lapsed accounts remain than one batch covers. */
  more: boolean;
};

/**
 * Releases every lapsed account's remaining balance (one `expire` entry each,
 * deterministic per account and expiry instant, so a re-run is a no-op). The
 * application never WAITS for this — an account about to be used is settled
 * first (`settleLapse`) — it exists so the books stop showing lapsed value as
 * outstanding. Bounded to one batch per call.
 */
export async function sweepExpiredStoredValue(
  tx: Bun.SQL,
  tenantId: string,
  correlationId?: string
): Promise<ExpirySweepResult> {
  const candidates = (await tx`
    SELECT id
    FROM awcms_commerce_stored_value_accounts
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
      AND status <> 'expired'
      AND expires_at IS NOT NULL AND expires_at <= clock_timestamp()
    ORDER BY expires_at ASC, id ASC
    LIMIT ${STORED_VALUE_SWEEP_BATCH + 1}
  `) as { id: string }[];

  let released = 0n;
  let expired = 0;
  for (const candidate of candidates.slice(0, STORED_VALUE_SWEEP_BATCH)) {
    const locked = await lockStoredValueAccount(tx, tenantId, candidate.id);
    if (!locked || locked.status === "expired" || !locked.lapsed) continue;
    const balance = locked.balanceCents;
    await settleLapse(tx, tenantId, locked, correlationId);
    released += balance;
    expired += 1;
  }
  return {
    expired,
    released: fromCents(released),
    more: candidates.length > STORED_VALUE_SWEEP_BATCH
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type StoredValueAccountFilters = {
  kind?: StoredValueKind;
  status?: StoredValueAccountStatus;
  customerId?: string;
  /** Exactly four characters of a code's tail (case-insensitive) — how an operator finds a card without the code. */
  last4?: string;
};

export type StoredValueAccountPage = {
  items: StoredValueAccountRecord[];
  nextCursor: string | null;
};

export async function listStoredValueAccounts(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null,
  filters: StoredValueAccountFilters = {}
): Promise<StoredValueAccountPage> {
  const kind = filters.kind ?? null;
  const status = filters.status ?? null;
  const customerId = filters.customerId ?? null;
  const last4 = filters.last4 ? filters.last4.toUpperCase() : null;
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const rows = (await tx`
    SELECT ${tx.unsafe(STORED_VALUE_ACCOUNT_COLUMNS)},
           ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_commerce_stored_value_accounts
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
      AND (${kind}::text IS NULL OR kind = ${kind})
      AND (${status}::text IS NULL OR status = ${status})
      AND (${customerId}::uuid IS NULL OR customer_id = ${customerId})
      AND (${last4}::text IS NULL OR code_last4 = ${last4})
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${STORED_VALUE_ACCOUNT_LIST_LIMIT}
  `) as (Parameters<typeof toAccountRecord>[0] & {
    created_at_cursor: string;
  })[];
  const last = rows[rows.length - 1];
  return {
    items: rows.map(toAccountRecord),
    nextCursor:
      rows.length === STORED_VALUE_ACCOUNT_LIST_LIMIT && last
        ? encodeKeysetCursor(last.created_at_cursor, last.id)
        : null
  };
}

export async function fetchStoredValueAccount(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string
): Promise<StoredValueAccountRecord | null> {
  return fetchAccountRecord(tx, tenantId, accountId);
}

export type StoredValueLedgerPage = {
  items: StoredValueEntryRecord[];
  /** The `account_seq` to continue from (older entries), or `null`. */
  nextCursor: string | null;
};

/** An account's ledger, NEWEST first, keyset on the per-account sequence. `null` when the account does not exist for this tenant (one answer for unknown/other-tenant — BOLA). */
export async function listStoredValueLedger(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  beforeSeq: number | null
): Promise<StoredValueLedgerPage | null> {
  const account = await fetchAccountRecord(tx, tenantId, accountId);
  if (!account) return null;
  const rows = (await tx`
    SELECT ${tx.unsafe(STORED_VALUE_ENTRY_COLUMNS)}
    FROM awcms_commerce_stored_value_ledger
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
      AND (${beforeSeq}::bigint IS NULL OR account_seq < ${beforeSeq})
    ORDER BY account_seq DESC
    LIMIT ${STORED_VALUE_LEDGER_PAGE_LIMIT}
  `) as Parameters<typeof toEntryRecord>[0][];
  const items = rows.map(toEntryRecord);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      items.length === STORED_VALUE_LEDGER_PAGE_LIMIT && last
        ? String(last.accountSeq)
        : null
  };
}

// ---------------------------------------------------------------------------
// Liability report
// ---------------------------------------------------------------------------

export type StoredValueFigure = { count: number; amount: string };

export type StoredValueKindReport = {
  kind: StoredValueKind;
  /** Value added in the period: issues + loads. */
  issued: StoredValueFigure;
  loaded: StoredValueFigure;
  redeemed: StoredValueFigure;
  refunded: StoredValueFigure;
  /** Manual adjustments, split so neither direction hides in a net. */
  adjustedUp: StoredValueFigure;
  adjustedDown: StoredValueFigure;
  /** Value released because the account lapsed. */
  expired: StoredValueFigure;
  /** Net change in the period (sum of every signed entry). */
  net: string;
  /** All-time, as of now: the ledger's sum — what is owed. */
  outstanding: string;
  /** Of `outstanding`: value on disabled accounts (frozen, still owed). */
  disabledBalance: string;
  /** Of `outstanding`: value on accounts past their expiry the sweep has not released yet. */
  lapsedPendingRelease: string;
  accounts: {
    total: number;
    active: number;
    disabled: number;
    expired: number;
  };
};

export type StoredValueReport = {
  from: string;
  to: string;
  timeZone: string;
  kinds: StoredValueKindReport[];
  totals: {
    issued: string;
    redeemed: string;
    refunded: string;
    expired: string;
    outstanding: string;
  };
};

function figure(count: number, cents: bigint): StoredValueFigure {
  return { count, amount: signedFromCents(cents) };
}

/**
 * The liability report, read straight off the ledger (no second projection to
 * drift): per kind, what was issued / loaded / redeemed / refunded / adjusted /
 * expired over an inclusive range of report days (`Asia/Jakarta`, attributed
 * to the day each entry was written), and what is outstanding NOW — the sum of
 * every entry ever written, which stays right even if an account's projection
 * had drifted. A point of value is counted once: an issue is only ever in
 * `issued`; its later redemption or expiry is another row in another bucket.
 */
export async function fetchStoredValueReport(
  tx: Bun.SQL,
  tenantId: string,
  range: { from: string; to: string },
  timeZone: string
): Promise<StoredValueReport> {
  const period = (await tx`
    SELECT a.kind AS tender_kind, l.kind AS entry_kind,
           COUNT(*) AS entry_count,
           COALESCE(SUM(l.amount), 0) AS total,
           COUNT(*) FILTER (WHERE l.amount > 0) AS up_count,
           COALESCE(SUM(l.amount) FILTER (WHERE l.amount > 0), 0) AS up_total,
           COUNT(*) FILTER (WHERE l.amount < 0) AS down_count,
           COALESCE(SUM(l.amount) FILTER (WHERE l.amount < 0), 0) AS down_total
    FROM awcms_commerce_stored_value_ledger l
    JOIN awcms_commerce_stored_value_accounts a
      ON a.tenant_id = l.tenant_id AND a.id = l.account_id
    WHERE l.tenant_id = ${tenantId}
      AND l.created_at >= (${range.from}::date)::timestamp AT TIME ZONE ${timeZone}
      AND l.created_at < ((${range.to}::date + 1)::timestamp AT TIME ZONE ${timeZone})
    GROUP BY a.kind, l.kind
  `) as {
    tender_kind: string;
    entry_kind: string;
    entry_count: string | number;
    total: string;
    up_count: string | number;
    up_total: string;
    down_count: string | number;
    down_total: string;
  }[];

  const outstanding = (await tx`
    SELECT a.kind AS tender_kind,
           COALESCE(SUM(l.amount), 0) AS outstanding
    FROM awcms_commerce_stored_value_accounts a
    LEFT JOIN awcms_commerce_stored_value_ledger l
      ON l.tenant_id = a.tenant_id AND l.account_id = a.id
    WHERE a.tenant_id = ${tenantId} AND a.deleted_at IS NULL
    GROUP BY a.kind
  `) as { tender_kind: string; outstanding: string }[];

  const shape = (await tx`
    SELECT kind AS tender_kind,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status = 'active') AS active,
           COUNT(*) FILTER (WHERE status = 'disabled') AS disabled,
           COUNT(*) FILTER (WHERE status = 'expired') AS expired,
           COALESCE(SUM(balance) FILTER (WHERE status = 'disabled'), 0) AS disabled_balance,
           COALESCE(SUM(balance) FILTER (
             WHERE status <> 'expired' AND expires_at IS NOT NULL AND expires_at <= clock_timestamp()
           ), 0) AS lapsed_balance
    FROM awcms_commerce_stored_value_accounts
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
    GROUP BY kind
  `) as {
    tender_kind: string;
    total: string | number;
    active: string | number;
    disabled: string | number;
    expired: string | number;
    disabled_balance: string;
    lapsed_balance: string;
  }[];

  const cents = (value: string) => signedToCents(String(value));
  let totalIssued = 0n;
  let totalRedeemed = 0n;
  let totalRefunded = 0n;
  let totalExpired = 0n;
  let totalOutstanding = 0n;

  const kinds = PROGRAM_KINDS.map((kind): StoredValueKindReport => {
    const rows = period.filter((row) => row.tender_kind === kind);
    const by = (entryKind: string) =>
      rows.find((row) => row.entry_kind === entryKind);
    const sum = (entryKind: string): StoredValueFigure => {
      const row = by(entryKind);
      return row
        ? figure(Number(row.entry_count), cents(row.total))
        : figure(0, 0n);
    };
    const issue = by("issue");
    const load = by("load");
    const issuedCents =
      (issue ? cents(issue.total) : 0n) + (load ? cents(load.total) : 0n);
    const issued = figure(
      (issue ? Number(issue.entry_count) : 0) +
        (load ? Number(load.entry_count) : 0),
      issuedCents
    );
    const redeemedRaw = sum("redeem");
    const expiredRaw = sum("expire");
    const adjust = by("adjust");
    const net = rows.reduce((acc, row) => acc + cents(row.total), 0n);
    const outstandingRow = outstanding.find((row) => row.tender_kind === kind);
    const shapeRow = shape.find((row) => row.tender_kind === kind);
    const outstandingCents = outstandingRow
      ? cents(outstandingRow.outstanding)
      : 0n;

    // Redemptions and expiries are stored negative; the report shows them as
    // positive magnitudes under their own names.
    const redeemed = figure(
      redeemedRaw.count,
      -signedToCents(redeemedRaw.amount)
    );
    const expiredFigure = figure(
      expiredRaw.count,
      -signedToCents(expiredRaw.amount)
    );
    totalIssued += issuedCents;
    totalRedeemed += -signedToCents(redeemedRaw.amount);
    totalRefunded += signedToCents(sum("refund").amount);
    totalExpired += -signedToCents(expiredRaw.amount);
    totalOutstanding += outstandingCents;

    return {
      kind,
      issued,
      loaded: sum("load"),
      redeemed,
      refunded: sum("refund"),
      adjustedUp: adjust
        ? figure(Number(adjust.up_count), cents(adjust.up_total))
        : figure(0, 0n),
      adjustedDown: adjust
        ? figure(Number(adjust.down_count), -cents(adjust.down_total))
        : figure(0, 0n),
      expired: expiredFigure,
      net: signedFromCents(net),
      outstanding: signedFromCents(outstandingCents),
      disabledBalance: shapeRow
        ? signedFromCents(cents(shapeRow.disabled_balance))
        : "0.00",
      lapsedPendingRelease: shapeRow
        ? signedFromCents(cents(shapeRow.lapsed_balance))
        : "0.00",
      accounts: {
        total: shapeRow ? Number(shapeRow.total) : 0,
        active: shapeRow ? Number(shapeRow.active) : 0,
        disabled: shapeRow ? Number(shapeRow.disabled) : 0,
        expired: shapeRow ? Number(shapeRow.expired) : 0
      }
    };
  });

  return {
    from: range.from,
    to: range.to,
    timeZone,
    kinds,
    totals: {
      issued: signedFromCents(totalIssued),
      redeemed: signedFromCents(totalRedeemed),
      refunded: signedFromCents(totalRefunded),
      expired: signedFromCents(totalExpired),
      outstanding: signedFromCents(totalOutstanding)
    }
  };
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export type ReconcileFinding = {
  accountId: string;
  type:
    | "projection_drift"
    | "status_drift"
    | "ledger_break"
    | "allocation_mismatch";
  detail: string;
  /** Only `projection_drift` is repairable (balance/version); everything else needs a human. */
  repairable: boolean;
  repaired: boolean;
};

export type ReconcileResult = {
  accountsChecked: number;
  findings: ReconcileFinding[];
  /** `true` when more findings exist than the report carries. */
  truncated: boolean;
  repaired: number;
};

/**
 * Compares every account's projection with its ledger and the ledger with
 * itself and the payment ledger. Read-only unless `repair` is set; repairing
 * rewrites ONLY `balance`/`version` (under the account lock; the
 * database accepts it because the new values are exactly what the ledger sums to), and audits each repair. A ledger that
 * disagrees with itself, a status that disagrees with its entries and a
 * redemption that disagrees with its payment leg are REPORTED and never
 * repaired — an append-only table that contradicts itself needs a human, not
 * a script.
 */
export async function reconcileStoredValue(
  tx: Bun.SQL,
  tenantId: string,
  options: { repair: boolean; actor: StoredValueActor; correlationId?: string }
): Promise<ReconcileResult> {
  const checked = (await tx`
    SELECT COUNT(*) AS n FROM awcms_commerce_stored_value_accounts
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
  `) as { n: string | number }[];

  const findings: ReconcileFinding[] = [];
  const limit = STORED_VALUE_RECONCILE_FINDING_LIMIT + 1;

  const drift = (await tx`
    SELECT a.id, a.balance, a.version, COALESCE(l.total, 0) AS ledger_total, COALESCE(l.entries, 0) AS ledger_entries
    FROM awcms_commerce_stored_value_accounts a
    LEFT JOIN (
      SELECT account_id, SUM(amount) AS total, COUNT(*) AS entries
      FROM awcms_commerce_stored_value_ledger
      WHERE tenant_id = ${tenantId}
      GROUP BY account_id
    ) l ON l.account_id = a.id
    WHERE a.tenant_id = ${tenantId} AND a.deleted_at IS NULL
      AND (a.balance <> COALESCE(l.total, 0) OR a.version <> COALESCE(l.entries, 0))
    ORDER BY a.id
    LIMIT ${limit}
  `) as {
    id: string;
    balance: string;
    version: string | number;
    ledger_total: string;
    ledger_entries: string | number;
  }[];
  for (const row of drift) {
    findings.push({
      accountId: row.id,
      type: "projection_drift",
      detail: `projection balance ${normalizeMoney(String(row.balance))} / version ${Number(row.version)} but the ledger sums to ${normalizeMoney(String(row.ledger_total))} over ${Number(row.ledger_entries)} entries`,
      repairable: true,
      repaired: false
    });
  }

  const breaks = (await tx`
    SELECT account_id, MIN(account_seq) AS first_seq
    FROM (
      SELECT account_id, account_seq, balance_after,
             SUM(amount) OVER (PARTITION BY account_id ORDER BY account_seq) AS running,
             ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY account_seq) AS pos
      FROM awcms_commerce_stored_value_ledger
      WHERE tenant_id = ${tenantId}
    ) e
    WHERE running <> balance_after OR pos <> account_seq OR running < 0
    GROUP BY account_id
    ORDER BY account_id
    LIMIT ${limit}
  `) as { account_id: string; first_seq: string | number }[];
  for (const row of breaks) {
    findings.push({
      accountId: row.account_id,
      type: "ledger_break",
      detail: `the ledger disagrees with itself from entry ${Number(row.first_seq)} (a gap, a running balance that does not add up, or a balance below zero)`,
      repairable: false,
      repaired: false
    });
  }

  const statusDrift = (await tx`
    SELECT a.id, a.status
    FROM awcms_commerce_stored_value_accounts a
    WHERE a.tenant_id = ${tenantId} AND a.deleted_at IS NULL
      AND a.status <> COALESCE((
        SELECT CASE l.kind WHEN 'expire' THEN 'expired' WHEN 'disable' THEN 'disabled' ELSE 'active' END
        FROM awcms_commerce_stored_value_ledger l
        WHERE l.tenant_id = a.tenant_id AND l.account_id = a.id
          AND l.kind IN ('expire', 'disable', 'enable')
        ORDER BY l.account_seq DESC
        LIMIT 1
      ), 'active')
    ORDER BY a.id
    LIMIT ${limit}
  `) as { id: string; status: string }[];
  for (const row of statusDrift) {
    findings.push({
      accountId: row.id,
      type: "status_drift",
      detail: `status ${row.status} disagrees with the last status-changing ledger entry`,
      repairable: false,
      repaired: false
    });
  }

  const mismatches = (await tx`
    SELECT p.id AS allocation_id, p.stored_value_account_id AS account_id
    FROM awcms_commerce_payment_allocations p
    LEFT JOIN awcms_commerce_stored_value_ledger l
      ON l.tenant_id = p.tenant_id AND l.allocation_id = p.id
    WHERE p.tenant_id = ${tenantId} AND p.stored_value_account_id IS NOT NULL
      AND p.status = 'succeeded'
      AND (
        l.id IS NULL
        OR l.account_id <> p.stored_value_account_id
        OR ABS(l.amount) <> p.amount
        OR (p.kind = 'payment' AND l.kind <> 'redeem')
        OR (p.kind = 'reversal' AND l.kind <> 'refund')
      )
    ORDER BY p.id
    LIMIT ${limit}
  `) as { allocation_id: string; account_id: string }[];
  for (const row of mismatches) {
    findings.push({
      accountId: row.account_id,
      type: "allocation_mismatch",
      detail: `payment-allocation ${row.allocation_id} has no matching stored-value ledger entry`,
      repairable: false,
      repaired: false
    });
  }

  const truncated = findings.length > STORED_VALUE_RECONCILE_FINDING_LIMIT;
  const reported = findings.slice(0, STORED_VALUE_RECONCILE_FINDING_LIMIT);

  let repaired = 0;
  if (options.repair) {
    for (const finding of reported) {
      if (finding.type !== "projection_drift") continue;
      const account = await lockStoredValueAccount(
        tx,
        tenantId,
        finding.accountId
      );
      if (!account) continue;
      const sums = (await tx`
        SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS entries
        FROM awcms_commerce_stored_value_ledger
        WHERE tenant_id = ${tenantId} AND account_id = ${finding.accountId}
      `) as { total: string; entries: string | number }[];
      const total = normalizeMoney(String(sums[0]!.total));
      if (toCents(total) < 0n) continue; // a negative sum is a ledger break, never "repaired" away
      await tx`
        UPDATE awcms_commerce_stored_value_accounts
        SET balance = ${total}, version = ${Number(sums[0]!.entries)}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${finding.accountId}
      `;
      finding.repaired = true;
      repaired += 1;
      await recordAuditEvent(tx, {
        tenantId,
        actorTenantUserId:
          options.actor.kind === "tenant_user"
            ? options.actor.tenantUserId
            : undefined,
        moduleKey: AUDIT_MODULE_KEY,
        action: "stored_value.reconcile_repair",
        resourceType: "stored_value_account",
        resourceId: finding.accountId,
        message: `Stored-value projection of account ${finding.accountId} rebuilt from its ledger.`,
        attributes: {
          accountId: finding.accountId,
          balanceBefore: account.balance,
          balanceAfter: total
        },
        correlationId: options.correlationId
      });
    }
  }

  return {
    accountsChecked: Number(checked[0]!.n),
    findings: reported,
    truncated,
    repaired
  };
}
