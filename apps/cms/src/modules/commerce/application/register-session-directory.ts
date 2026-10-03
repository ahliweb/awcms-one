/**
 * POS register sessions, drawer movements and handover (Issue #284, epic #281,
 * ADR-0028). The cash-up half (expected totals, close, approval, corrections,
 * the report) is `register-cash-up.ts`; register definitions are
 * `register-directory.ts`.
 *
 * ## Concurrency: three lock modes on the SESSION row
 *
 *   - OPEN locks the REGISTER row (`FOR NO KEY UPDATE`) first, so two
 *     genuinely concurrent opens serialise: the second sees the first's
 *     session and answers `already_open`. The partial unique index
 *     (`sql/970`) is the independent backstop for a writer that skipped the
 *     lock — its 23505 is mapped to the same outcome.
 *   - A POS SALE, a MOVEMENT and a stamped PAYMENT LEG lock the session
 *     `FOR SHARE`: any number of them run in parallel, and a close (below)
 *     cannot slip between a session-open check and the write it guards.
 *   - HANDOVER and CLOSE/APPROVE/CORRECT lock the session `FOR NO KEY UPDATE`:
 *     exclusive against every share-locker and against each other, yet — unlike
 *     `FOR UPDATE` — compatible with the `FOR KEY SHARE` an FK insert (a
 *     movement, an order, a ledger leg) takes on the session row. ADR-0025 D4
 *     records the deadlock `FOR UPDATE` caused for the same reason.
 *
 * Every session-scoped mutation locks first and reads the idempotency store
 * AFTER the lock: under READ COMMITTED a retry that waited for the first
 * request then sees the committed record and replays it deterministically,
 * instead of racing to a lost insert.
 *
 * ## Who may act
 *
 * A movement, a sale and a close are the CURRENT CASHIER's: the acting user
 * must be `current_cashier_tenant_user_id`. A handover changes it (by the
 * current cashier, or by a supervisor — decided by the route, which passes
 * `supervisor`), so accountability for the drawer is always one named person.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
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
import { normalizeMoney } from "../domain/price-calculation";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_REGISTER_SESSION_AGGREGATE_TYPE,
  COMMERCE_REGISTER_SESSION_MOVEMENT_RECORDED_EVENT_TYPE,
  COMMERCE_REGISTER_SESSION_OPENED_EVENT_TYPE
} from "../domain/commerce-events";
import type {
  HandoverInput,
  OpenSessionInput,
  RecordMovementInput,
  RegisterMovementDirection,
  RegisterMovementType,
  RegisterSessionStatus
} from "../domain/register";
import { IdempotencyPayloadMismatchError } from "./order-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "register_session";
const PRODUCER_MODULE = "commerce";
const POSTGRES_UNIQUE_VIOLATION = "23505";
const ONE_ACTIVE_CONSTRAINT = "awcms_commerce_register_sessions_one_active";

const OPEN_SCOPE = "commerce.register_sessions.open";
const MOVEMENT_SCOPE = "commerce.register_sessions.movement";
const HANDOVER_SCOPE = "commerce.register_sessions.handover";

export const REGISTER_SESSION_LIST_LIMIT = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RegisterSessionRecord = {
  id: string;
  registerId: string;
  registerCode: string;
  registerName: string;
  status: RegisterSessionStatus;
  openedAt: string;
  openedByTenantUserId: string;
  /** `numeric(14,2)` string. */
  openingFloat: string;
  currentCashierTenantUserId: string;
  closedAt: string | null;
  closedByTenantUserId: string | null;
};

export type RegisterMovementRecord = {
  id: string;
  sessionId: string;
  movementType: RegisterMovementType;
  direction: RegisterMovementDirection;
  amount: string;
  reference: string | null;
  note: string | null;
  actorTenantUserId: string;
  createdAt: string;
};

type SessionRow = {
  id: string;
  register_id: string;
  register_code: string;
  register_name: string;
  status: string;
  opened_at: Date;
  opened_by_tenant_user_id: string;
  opening_float: string;
  current_cashier_tenant_user_id: string;
  closed_at: Date | null;
  closed_by_tenant_user_id: string | null;
};

const SESSION_SELECT = `s.id, s.register_id, r.code AS register_code, r.name AS register_name,
  s.status, s.opened_at, s.opened_by_tenant_user_id, s.opening_float,
  s.current_cashier_tenant_user_id, s.closed_at, s.closed_by_tenant_user_id`;

function toSessionRecord(row: SessionRow): RegisterSessionRecord {
  return {
    id: row.id,
    registerId: row.register_id,
    registerCode: row.register_code,
    registerName: row.register_name,
    status: row.status as RegisterSessionStatus,
    openedAt: row.opened_at.toISOString(),
    openedByTenantUserId: row.opened_by_tenant_user_id,
    openingFloat: normalizeMoney(String(row.opening_float)),
    currentCashierTenantUserId: row.current_cashier_tenant_user_id,
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    closedByTenantUserId: row.closed_by_tenant_user_id
  };
}

type MovementRow = {
  id: string;
  session_id: string;
  movement_type: string;
  direction: string;
  amount: string;
  reference: string | null;
  note: string | null;
  actor_tenant_user_id: string;
  created_at: Date;
};

const MOVEMENT_COLUMNS = `id, session_id, movement_type, direction, amount, reference, note,
  actor_tenant_user_id, created_at`;

function toMovementRecord(row: MovementRow): RegisterMovementRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    movementType: row.movement_type as RegisterMovementType,
    direction: row.direction as RegisterMovementDirection,
    amount: normalizeMoney(String(row.amount)),
    reference: row.reference,
    note: row.note,
    actorTenantUserId: row.actor_tenant_user_id,
    createdAt: row.created_at.toISOString()
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchRegisterSession(
  tx: Bun.SQL,
  tenantId: string,
  sessionId: string
): Promise<RegisterSessionRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(SESSION_SELECT)}
    FROM awcms_commerce_register_sessions s
    JOIN awcms_commerce_registers r ON r.tenant_id = s.tenant_id AND r.id = s.register_id
    WHERE s.tenant_id = ${tenantId} AND s.id = ${sessionId} AND s.deleted_at IS NULL
  `) as SessionRow[];
  return rows[0] ? toSessionRecord(rows[0]) : null;
}

export type RegisterSessionListFilters = {
  registerId?: string;
  status?: RegisterSessionStatus;
  cashierTenantUserId?: string;
};

export type RegisterSessionListPage = {
  items: RegisterSessionRecord[];
  nextCursor: string | null;
};

/** Keyset history, newest first, over `(tenant_id, status, …)`-indexed columns. */
export async function listRegisterSessions(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null,
  filters: RegisterSessionListFilters = {}
): Promise<RegisterSessionListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const registerId = filters.registerId ?? null;
  const status = filters.status ?? null;
  const cashier = filters.cashierTenantUserId ?? null;

  const rows = (await tx`
    SELECT ${tx.unsafe(SESSION_SELECT)},
           ${tx.unsafe(keysetCursorCreatedAtSql("s"))} AS created_at_cursor
    FROM awcms_commerce_register_sessions s
    JOIN awcms_commerce_registers r ON r.tenant_id = s.tenant_id AND r.id = s.register_id
    WHERE s.tenant_id = ${tenantId}
      AND s.deleted_at IS NULL
      AND (${registerId}::uuid IS NULL OR s.register_id = ${registerId})
      AND (${status}::text IS NULL OR s.status = ${status})
      AND (${cashier}::uuid IS NULL OR s.current_cashier_tenant_user_id = ${cashier})
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (s.created_at, s.id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT ${REGISTER_SESSION_LIST_LIMIT}
  `) as (SessionRow & { created_at_cursor: string })[];

  const last = rows[rows.length - 1];
  return {
    items: rows.map(toSessionRecord),
    nextCursor:
      rows.length === REGISTER_SESSION_LIST_LIMIT && last
        ? encodeKeysetCursor(last.created_at_cursor, last.id)
        : null
  };
}

/** Every movement of a session, oldest first. */
export async function listRegisterMovements(
  tx: Bun.SQL,
  tenantId: string,
  sessionId: string
): Promise<RegisterMovementRecord[]> {
  const rows = (await tx`
    SELECT ${tx.unsafe(MOVEMENT_COLUMNS)}
    FROM awcms_commerce_register_movements
    WHERE tenant_id = ${tenantId} AND session_id = ${sessionId}
    ORDER BY created_at ASC, id ASC
  `) as MovementRow[];
  return rows.map(toMovementRecord);
}

// ---------------------------------------------------------------------------
// Locks (shared with register-cash-up.ts)
// ---------------------------------------------------------------------------

export type LockedSession = {
  id: string;
  registerId: string;
  status: RegisterSessionStatus;
  openingFloat: string;
  currentCashierTenantUserId: string;
};

type LockedRow = {
  id: string;
  register_id: string;
  status: string;
  opening_float: string;
  current_cashier_tenant_user_id: string;
};

function toLocked(row: LockedRow | undefined): LockedSession | null {
  return row
    ? {
        id: row.id,
        registerId: row.register_id,
        status: row.status as RegisterSessionStatus,
        openingFloat: normalizeMoney(String(row.opening_float)),
        currentCashierTenantUserId: row.current_cashier_tenant_user_id
      }
    : null;
}

/**
 * Locks the session `FOR SHARE` (movements, sales, stamped legs: many in
 * parallel, all excluded by an exclusive lock). `null` for an unknown,
 * soft-deleted or other-tenant session - one answer for all three.
 */
export async function lockSessionShared(
  tx: Bun.SQL,
  tenantId: string,
  sessionId: string
): Promise<LockedSession | null> {
  const rows = (await tx`
    SELECT id, register_id, status, opening_float, current_cashier_tenant_user_id
    FROM awcms_commerce_register_sessions
    WHERE tenant_id = ${tenantId} AND id = ${sessionId} AND deleted_at IS NULL
    FOR SHARE
  `) as LockedRow[];
  return toLocked(rows[0]);
}

/** Locks the session `FOR NO KEY UPDATE` (handover, close, approve, correct): exclusive, but FK inserts (`FOR KEY SHARE`) still proceed. */
export async function lockSessionExclusive(
  tx: Bun.SQL,
  tenantId: string,
  sessionId: string
): Promise<LockedSession | null> {
  const rows = (await tx`
    SELECT id, register_id, status, opening_float, current_cashier_tenant_user_id
    FROM awcms_commerce_register_sessions
    WHERE tenant_id = ${tenantId} AND id = ${sessionId} AND deleted_at IS NULL
    FOR NO KEY UPDATE
  `) as LockedRow[];
  return toLocked(rows[0]);
}

// ---------------------------------------------------------------------------
// The POS gate
// ---------------------------------------------------------------------------

export type SaleSessionGateOutcome =
  | { kind: "ok"; sessionId: string }
  | { kind: "register_not_found" }
  | { kind: "no_open_session" }
  | { kind: "session_closing" }
  | { kind: "not_session_cashier" };

/**
 * The check `createPosOrder` runs when the register feature is on: the chosen
 * register must have an `open` session whose current cashier is the actor.
 * Locks the session `FOR SHARE` for the rest of the sale's transaction, so a
 * close cannot run between this check and the order insert - and `sql/971`'s
 * trigger refuses an order attached to a non-open session even if this check
 * were skipped. An unknown, inactive-and-sessionless, or other-tenant register
 * all answer `register_not_found`/`no_open_session` without distinguishing a
 * foreign id from a missing one.
 */
export async function gateSaleToRegisterSession(
  tx: Bun.SQL,
  tenantId: string,
  registerId: string,
  actorTenantUserId: string
): Promise<SaleSessionGateOutcome> {
  const registers = (await tx`
    SELECT id FROM awcms_commerce_registers
    WHERE tenant_id = ${tenantId} AND id = ${registerId} AND deleted_at IS NULL
  `) as { id: string }[];
  if (registers.length === 0) return { kind: "register_not_found" };

  const sessions = (await tx`
    SELECT id, status, current_cashier_tenant_user_id
    FROM awcms_commerce_register_sessions
    WHERE tenant_id = ${tenantId} AND register_id = ${registerId}
      AND status IN ('open', 'closing')
    FOR SHARE
  `) as {
    id: string;
    status: string;
    current_cashier_tenant_user_id: string;
  }[];
  const session = sessions[0];
  if (!session) return { kind: "no_open_session" };
  if (session.status !== "open") return { kind: "session_closing" };
  if (session.current_cashier_tenant_user_id !== actorTenantUserId) {
    return { kind: "not_session_cashier" };
  }
  return { kind: "ok", sessionId: session.id };
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export type OpenRegisterSessionOutcome =
  | { kind: "register_not_found" }
  | { kind: "register_inactive" }
  | { kind: "already_open"; activeSessionId: string | null }
  | { kind: "created" | "replayed"; session: RegisterSessionRecord };

/**
 * Opens a session on a register with a counted opening float; the opener is
 * the first current cashier. Idempotent on `Idempotency-Key`.
 *
 * @throws {IdempotencyPayloadMismatchError} same key, different payload.
 */
export async function openRegisterSession(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: OpenSessionInput,
  correlationId?: string
): Promise<OpenRegisterSessionOutcome> {
  const registers = (await tx`
    SELECT id, active
    FROM awcms_commerce_registers
    WHERE tenant_id = ${tenantId} AND id = ${input.registerId} AND deleted_at IS NULL
    FOR NO KEY UPDATE
  `) as { id: string; active: boolean }[];
  const register = registers[0];
  if (!register) return { kind: "register_not_found" };

  const requestHash = computeRequestHash({
    action: OPEN_SCOPE,
    actorTenantUserId,
    registerId: input.registerId,
    openingFloat: input.openingFloat
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    OPEN_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      session: existing.responseBody as RegisterSessionRecord
    };
  }

  if (!register.active) return { kind: "register_inactive" };

  const live = (await tx`
    SELECT id FROM awcms_commerce_register_sessions
    WHERE tenant_id = ${tenantId} AND register_id = ${input.registerId}
      AND status IN ('open', 'closing')
  `) as { id: string }[];
  if (live[0]) return { kind: "already_open", activeSessionId: live[0].id };

  let sessionId: string;
  try {
    const rows = (await tx`
      INSERT INTO awcms_commerce_register_sessions (
        tenant_id, register_id, opened_by_tenant_user_id, opening_float,
        current_cashier_tenant_user_id
      )
      VALUES (
        ${tenantId}, ${input.registerId}, ${actorTenantUserId}, ${input.openingFloat},
        ${actorTenantUserId}
      )
      RETURNING id
    `) as { id: string }[];
    sessionId = rows[0]!.id;
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
      error.constraint === ONE_ACTIVE_CONSTRAINT
    ) {
      return { kind: "already_open", activeSessionId: null };
    }
    throw error;
  }

  const session = (await fetchRegisterSession(tx, tenantId, sessionId))!;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "register_session.open",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: sessionId,
    message: `Register session opened on ${session.registerCode} with an opening float of ${session.openingFloat}.`,
    attributes: {
      registerId: session.registerId,
      registerCode: session.registerCode,
      openingFloat: session.openingFloat
    },
    correlationId
  });
  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_REGISTER_SESSION_OPENED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_REGISTER_SESSION_AGGREGATE_TYPE,
    aggregateId: sessionId,
    producerModule: PRODUCER_MODULE,
    correlationId,
    actorTenantUserId,
    payload: {
      sessionId,
      registerId: session.registerId,
      openingFloat: session.openingFloat,
      cashierTenantUserId: actorTenantUserId
    }
  });

  await saveIdempotencyRecord(
    tx,
    tenantId,
    OPEN_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    session
  );
  return { kind: "created", session };
}

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

export type RecordRegisterMovementOutcome =
  | { kind: "not_found" }
  | { kind: "session_not_open"; status: RegisterSessionStatus }
  | { kind: "not_session_cashier" }
  | { kind: "created" | "replayed"; movement: RegisterMovementRecord };

/**
 * Records one drawer movement (cash only) against an open session. Append-only;
 * the actor must be the session's current cashier. Idempotent on
 * `Idempotency-Key` (shared store) and, independently, on the row's own
 * `source_key`.
 *
 * @throws {IdempotencyPayloadMismatchError} same key, different payload.
 */
export async function recordRegisterMovement(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  sessionId: string,
  input: RecordMovementInput,
  correlationId?: string
): Promise<RecordRegisterMovementOutcome> {
  const session = await lockSessionShared(tx, tenantId, sessionId);
  if (!session) return { kind: "not_found" };

  const requestHash = computeRequestHash({
    action: MOVEMENT_SCOPE,
    actorTenantUserId,
    sessionId,
    movementType: input.movementType,
    direction: input.direction,
    amount: input.amount,
    reference: input.reference,
    note: input.note
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    MOVEMENT_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      movement: existing.responseBody as RegisterMovementRecord
    };
  }

  if (session.status !== "open") {
    return { kind: "session_not_open", status: session.status };
  }
  if (session.currentCashierTenantUserId !== actorTenantUserId) {
    return { kind: "not_session_cashier" };
  }

  const sourceKey = `movement:${input.idempotencyKey}`;
  const prior = (await tx`
    SELECT ${tx.unsafe(MOVEMENT_COLUMNS)}
    FROM awcms_commerce_register_movements
    WHERE tenant_id = ${tenantId} AND source_key = ${sourceKey}
  `) as MovementRow[];
  if (prior[0]) {
    if (prior[0].session_id !== sessionId) {
      throw new IdempotencyPayloadMismatchError();
    }
    return { kind: "replayed", movement: toMovementRecord(prior[0]) };
  }

  const rows = (await tx`
    INSERT INTO awcms_commerce_register_movements (
      tenant_id, session_id, movement_type, direction, amount, reference, note,
      actor_tenant_user_id, source_key
    )
    VALUES (
      ${tenantId}, ${sessionId}, ${input.movementType}, ${input.direction}, ${input.amount},
      ${input.reference}, ${input.note}, ${actorTenantUserId}, ${sourceKey}
    )
    RETURNING ${tx.unsafe(MOVEMENT_COLUMNS)}
  `) as MovementRow[];
  const movement = toMovementRecord(rows[0]!);

  // Money, type and ids only - never the free-text reference/note (a person's
  // name or a bank reference can hide there).
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "register_session.movement",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: sessionId,
    message: `Drawer movement recorded: ${movement.movementType} ${movement.direction} ${movement.amount}.`,
    attributes: {
      movementId: movement.id,
      movementType: movement.movementType,
      direction: movement.direction,
      amount: movement.amount
    },
    correlationId
  });
  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_REGISTER_SESSION_MOVEMENT_RECORDED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_REGISTER_SESSION_AGGREGATE_TYPE,
    aggregateId: sessionId,
    producerModule: PRODUCER_MODULE,
    correlationId,
    actorTenantUserId,
    payload: {
      sessionId,
      movementId: movement.id,
      movementType: movement.movementType,
      direction: movement.direction,
      amount: movement.amount
    }
  });

  await saveIdempotencyRecord(
    tx,
    tenantId,
    MOVEMENT_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    movement
  );
  return { kind: "created", movement };
}

// ---------------------------------------------------------------------------
// Handover
// ---------------------------------------------------------------------------

export type HandOverRegisterSessionOutcome =
  | { kind: "not_found" }
  | { kind: "session_not_open"; status: RegisterSessionStatus }
  | { kind: "forbidden" }
  | { kind: "same_cashier" }
  | { kind: "unknown_cashier" }
  | { kind: "handed_over" | "replayed"; session: RegisterSessionRecord };

/**
 * Hands the drawer to another cashier. Allowed for the CURRENT cashier or a
 * supervisor (`supervisor`, decided by the route from the approve
 * permission). The history is the audit trail (`register_session.handover`,
 * from/to ids); the row only ever names the current cashier. The target must
 * be an ACTIVE tenant user of this tenant - an unknown, inactive or foreign id
 * all answer `unknown_cashier`.
 *
 * @throws {IdempotencyPayloadMismatchError} same key, different payload.
 */
export async function handOverRegisterSession(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  supervisor: boolean,
  sessionId: string,
  input: HandoverInput,
  correlationId?: string
): Promise<HandOverRegisterSessionOutcome> {
  const session = await lockSessionExclusive(tx, tenantId, sessionId);
  if (!session) return { kind: "not_found" };

  const requestHash = computeRequestHash({
    action: HANDOVER_SCOPE,
    actorTenantUserId,
    sessionId,
    toTenantUserId: input.toTenantUserId,
    note: input.note
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    HANDOVER_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      session: existing.responseBody as RegisterSessionRecord
    };
  }

  if (session.status !== "open") {
    return { kind: "session_not_open", status: session.status };
  }
  if (!supervisor && session.currentCashierTenantUserId !== actorTenantUserId) {
    return { kind: "forbidden" };
  }
  if (session.currentCashierTenantUserId === input.toTenantUserId) {
    return { kind: "same_cashier" };
  }

  const target = (await tx`
    SELECT id FROM awcms_tenant_users
    WHERE tenant_id = ${tenantId} AND id = ${input.toTenantUserId} AND status = 'active'
  `) as { id: string }[];
  if (target.length === 0) return { kind: "unknown_cashier" };

  await tx`
    UPDATE awcms_commerce_register_sessions
    SET current_cashier_tenant_user_id = ${input.toTenantUserId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${sessionId}
  `;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "register_session.handover",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: sessionId,
    message: "Register session handed over to another cashier.",
    attributes: {
      fromTenantUserId: session.currentCashierTenantUserId,
      toTenantUserId: input.toTenantUserId,
      bySupervisor:
        supervisor && session.currentCashierTenantUserId !== actorTenantUserId
    },
    correlationId
  });

  const updated = (await fetchRegisterSession(tx, tenantId, sessionId))!;
  await saveIdempotencyRecord(
    tx,
    tenantId,
    HANDOVER_SCOPE,
    input.idempotencyKey,
    requestHash,
    200,
    updated
  );
  return { kind: "handed_over", session: updated };
}
