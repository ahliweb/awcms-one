/**
 * Cash-up (Issue #284, epic #281, ADR-0028): the expected closing amount per
 * tender, the close request with its variance and approval, the post-close
 * correction, and the per-session report. Sessions, movements and handover are
 * `register-session-directory.ts`.
 *
 * ## The cash-up never rewrites a sale or a payment
 *
 * Everything here READS the payment-allocation ledger (ADR-0025) and the
 * movements, and WRITES only the register tables. The legs a session counts
 * are exactly the ones stamped with its id at write time
 * (`register-session-stamp.ts`), so "expected" is a sum over immutable rows -
 * and it is snapshotted once, onto the close request's lines, so a closed
 * session's numbers are evidence rather than a query that could be re-run
 * against moved data.
 *
 * ## The close workflow
 *
 *   close (the current cashier, `commerce.register_cash_ups.create`) counts the
 *   drawer per tender:
 *     - gross variance <= the tenant's threshold          -> `auto`, closed;
 *     - above it, the closer ALSO holds the approve perm   -> `approved`
 *       (by the closer), closed;
 *     - above it, the closer does not                      -> `pending`, the
 *       session goes `closing` and accepts nothing until
 *   decide (`commerce.register_cash_ups.approve`):
 *     - approve -> `approved`, closed;  reject -> `rejected`, back to `open`
 *       (the rejected request stays as history; the next close is attempt n+1).
 *
 * A reason is mandatory whenever any tender is off. A close is idempotent on
 * `Idempotency-Key` and exclusive against every sale/movement/leg (the session
 * lock modes are documented in `register-session-directory.ts`), so two
 * concurrent closes cannot both succeed and a sale cannot land in a session
 * that has just been counted.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../_shared/idempotency";
import { fetchModuleSettingsView } from "../../module-management/application/module-settings";
import {
  normalizeMoney,
  fromCents,
  toCents
} from "../domain/price-calculation";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_REGISTER_SESSION_AGGREGATE_TYPE,
  COMMERCE_REGISTER_SESSION_CLOSED_EVENT_TYPE,
  COMMERCE_REGISTER_SESSION_CORRECTED_EVENT_TYPE
} from "../domain/commerce-events";
import type { PaymentTenderType } from "../domain/payment-allocation";
import {
  applyCorrections,
  computeExpectedLines,
  evaluateCount,
  MissingCountError,
  NegativeCorrectedCountError,
  normalizeSignedMoney,
  resolveCashUpSettings,
  type CashUpSettings,
  type CloseDecisionInput,
  type CloseSessionInput,
  type CorrectionRow,
  type CountedTenderLine,
  type ExpectedTenderLine,
  type RecordCorrectionInput,
  type RegisterCashUpReport,
  type RegisterCloseDecision,
  type RegisterMovementDirection,
  type RegisterMovementType,
  type RegisterSessionStatus,
  type ReportCloseRequest,
  type ReportCorrection,
  type ReportTenderLine,
  type TenderLedgerSum
} from "../domain/register";
import { IdempotencyPayloadMismatchError } from "./order-directory";
import {
  fetchRegisterSession,
  lockSessionExclusive,
  type RegisterSessionRecord
} from "./register-session-directory";

export type { RegisterCashUpReport };

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "register_session";
const PRODUCER_MODULE = "commerce";
const CLOSE_SCOPE = "commerce.register_sessions.close";
const DECISION_SCOPE = "commerce.register_sessions.close_decision";
const CORRECT_SCOPE = "commerce.register_sessions.correct";

// ---------------------------------------------------------------------------
// Expected totals (derived, under whatever lock the caller holds)
// ---------------------------------------------------------------------------

async function readLedgerSums(
  tx: Bun.SQL,
  tenantId: string,
  sessionId: string
): Promise<TenderLedgerSum[]> {
  const rows = (await tx`
    SELECT tender_type,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'payment'), 0) AS payments,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'reversal'), 0) AS reversals
    FROM awcms_commerce_payment_allocations
    WHERE tenant_id = ${tenantId} AND register_session_id = ${sessionId}
      AND status = 'succeeded'
    GROUP BY tender_type
  `) as { tender_type: string; payments: string; reversals: string }[];
  return rows.map((row) => ({
    tenderType: row.tender_type as PaymentTenderType,
    paymentsCents: toCents(normalizeMoney(String(row.payments))),
    reversalsCents: toCents(normalizeMoney(String(row.reversals)))
  }));
}

async function readMovementTotals(
  tx: Bun.SQL,
  tenantId: string,
  sessionId: string
): Promise<{ inCents: bigint; outCents: bigint }> {
  const rows = (await tx`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE direction = 'in'), 0) AS total_in,
      COALESCE(SUM(amount) FILTER (WHERE direction = 'out'), 0) AS total_out
    FROM awcms_commerce_register_movements
    WHERE tenant_id = ${tenantId} AND session_id = ${sessionId}
  `) as { total_in: string; total_out: string }[];
  return {
    inCents: toCents(normalizeMoney(String(rows[0]!.total_in))),
    outCents: toCents(normalizeMoney(String(rows[0]!.total_out)))
  };
}

/** The expected amount per tender for a session, derived from the stamped ledger legs and the movements. */
export async function computeSessionExpected(
  tx: Bun.SQL,
  tenantId: string,
  session: { id: string; openingFloat: string }
): Promise<{
  lines: ExpectedTenderLine[];
  movementsInCents: bigint;
  movementsOutCents: bigint;
}> {
  const [ledger, movements] = [
    await readLedgerSums(tx, tenantId, session.id),
    await readMovementTotals(tx, tenantId, session.id)
  ];
  return {
    lines: computeExpectedLines({
      openingFloatCents: toCents(session.openingFloat),
      ledger,
      movementsInCents: movements.inCents,
      movementsOutCents: movements.outCents
    }),
    movementsInCents: movements.inCents,
    movementsOutCents: movements.outCents
  };
}

async function readCashUpSettings(
  tx: Bun.SQL,
  tenantId: string
): Promise<CashUpSettings> {
  const view = await fetchModuleSettingsView(tx, tenantId, "commerce");
  return resolveCashUpSettings(view?.effective);
}

// ---------------------------------------------------------------------------
// Stored close data
// ---------------------------------------------------------------------------

type RequestRow = {
  id: string;
  attempt: number;
  requested_by_tenant_user_id: string;
  variance_total: string;
  variance_gross: string;
  approval_threshold: string;
  approval_required: boolean;
  variance_reason: string | null;
  decision: string;
  decided_by_tenant_user_id: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  created_at: Date;
};

const REQUEST_COLUMNS = `id, attempt, requested_by_tenant_user_id, variance_total, variance_gross,
  approval_threshold, approval_required, variance_reason, decision,
  decided_by_tenant_user_id, decided_at, decision_note, created_at`;

function toCloseRequest(row: RequestRow): ReportCloseRequest {
  return {
    id: row.id,
    attempt: Number(row.attempt),
    requestedByTenantUserId: row.requested_by_tenant_user_id,
    requestedAt: row.created_at.toISOString(),
    varianceTotal: normalizeSignedMoney(String(row.variance_total)),
    varianceGross: normalizeMoney(String(row.variance_gross)),
    approvalThreshold: normalizeMoney(String(row.approval_threshold)),
    approvalRequired: row.approval_required,
    varianceReason: row.variance_reason,
    decision: row.decision as RegisterCloseDecision,
    decidedByTenantUserId: row.decided_by_tenant_user_id,
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    decisionNote: row.decision_note
  };
}

async function listCloseRequests(
  tx: Bun.SQL,
  tenantId: string,
  sessionId: string
): Promise<ReportCloseRequest[]> {
  const rows = (await tx`
    SELECT ${tx.unsafe(REQUEST_COLUMNS)}
    FROM awcms_commerce_register_close_requests
    WHERE tenant_id = ${tenantId} AND session_id = ${sessionId}
    ORDER BY attempt ASC
  `) as RequestRow[];
  return rows.map(toCloseRequest);
}

async function readCloseLines(
  tx: Bun.SQL,
  tenantId: string,
  closeRequestId: string
): Promise<CountedTenderLine[]> {
  const rows = (await tx`
    SELECT tender_type, expected, counted, variance
    FROM awcms_commerce_register_close_lines
    WHERE tenant_id = ${tenantId} AND close_request_id = ${closeRequestId}
  `) as {
    tender_type: string;
    expected: string;
    counted: string;
    variance: string;
  }[];
  return rows.map((row) => ({
    tenderType: row.tender_type as PaymentTenderType,
    expected: normalizeSignedMoney(String(row.expected)),
    counted: normalizeMoney(String(row.counted)),
    variance: normalizeSignedMoney(String(row.variance))
  }));
}

async function listCorrections(
  tx: Bun.SQL,
  tenantId: string,
  sessionId: string
): Promise<ReportCorrection[]> {
  const rows = (await tx`
    SELECT correction_id, tender_type, adjustment, reason, actor_tenant_user_id, created_at
    FROM awcms_commerce_register_corrections
    WHERE tenant_id = ${tenantId} AND session_id = ${sessionId}
    ORDER BY created_at ASC, tender_type ASC
  `) as {
    correction_id: string;
    tender_type: string;
    adjustment: string;
    reason: string;
    actor_tenant_user_id: string;
    created_at: Date;
  }[];
  return rows.map((row) => ({
    correctionId: row.correction_id,
    tenderType: row.tender_type as PaymentTenderType,
    adjustment: normalizeSignedMoney(String(row.adjustment)),
    reason: row.reason,
    actorTenantUserId: row.actor_tenant_user_id,
    createdAt: row.created_at.toISOString()
  }));
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * The per-session cash-up report: opening float, sales by tender, movements,
 * expected, counted and variance (with corrections applied on top, the
 * original lines untouched). Live (derived from the ledger) while the session
 * is open; the stored close snapshot once it is closed. `null` for an unknown
 * or other-tenant session.
 */
export async function fetchRegisterCashUpReport(
  tx: Bun.SQL,
  tenantId: string,
  sessionId: string
): Promise<RegisterCashUpReport | null> {
  const session = await fetchRegisterSession(tx, tenantId, sessionId);
  if (!session) return null;

  const registerRows = (await tx`
    SELECT id, code, name, location_label
    FROM awcms_commerce_registers
    WHERE tenant_id = ${tenantId} AND id = ${session.registerId}
  `) as {
    id: string;
    code: string;
    name: string;
    location_label: string | null;
  }[];
  const register = registerRows[0]!;

  const movementRows = (await tx`
    SELECT id, movement_type, direction, amount, reference, note, actor_tenant_user_id, created_at
    FROM awcms_commerce_register_movements
    WHERE tenant_id = ${tenantId} AND session_id = ${sessionId}
    ORDER BY created_at ASC, id ASC
  `) as {
    id: string;
    movement_type: string;
    direction: string;
    amount: string;
    reference: string | null;
    note: string | null;
    actor_tenant_user_id: string;
    created_at: Date;
  }[];
  const movements = movementRows.map((row) => ({
    id: row.id,
    movementType: row.movement_type as RegisterMovementType,
    direction: row.direction as RegisterMovementDirection,
    amount: normalizeMoney(String(row.amount)),
    reference: row.reference,
    note: row.note,
    actorTenantUserId: row.actor_tenant_user_id,
    createdAt: row.created_at.toISOString()
  }));

  const salesRows = (await tx`
    SELECT COUNT(*) AS sale_count, COALESCE(SUM(total), 0) AS sale_total
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND register_session_id = ${sessionId}
      AND status NOT IN ('cancelled', 'expired') AND deleted_at IS NULL
  `) as { sale_count: string | number; sale_total: string }[];

  const expected = await computeSessionExpected(tx, tenantId, session);
  const closeRequests = await listCloseRequests(tx, tenantId, sessionId);
  const corrections = await listCorrections(tx, tenantId, sessionId);

  // The request whose figures the report shows: the one that closed the
  // session, else the pending one (counts awaiting approval).
  const finalRequest =
    closeRequests.find(
      (request) =>
        request.decision === "auto" || request.decision === "approved"
    ) ?? closeRequests.find((request) => request.decision === "pending");
  const storedLines = finalRequest
    ? await readCloseLines(tx, tenantId, finalRequest.id)
    : null;
  const closed = session.status === "closed" || session.status === "corrected";

  // For a closed session the SNAPSHOT is the evidence; the live ledger sums
  // still supply the payments/reversals breakdown (they cannot have changed:
  // stamping needs an open session).
  const expectedByTender = new Map(
    expected.lines.map((line) => [line.tenderType, line])
  );
  const stored = new Map(
    (storedLines ?? []).map((line) => [line.tenderType, line])
  );
  const effective = storedLines
    ? new Map(
        applyCorrections(
          storedLines,
          corrections.map((correction): CorrectionRow => ({
            tenderType: correction.tenderType,
            adjustment: correction.adjustment
          }))
        ).map((line) => [line.tenderType, line])
      )
    : new Map<PaymentTenderType, ReturnType<typeof applyCorrections>[number]>();

  const tenderTypes = new Set<PaymentTenderType>([
    ...expectedByTender.keys(),
    ...stored.keys(),
    ...effective.keys()
  ]);
  const order: readonly PaymentTenderType[] = [
    "cash",
    "manual_qris",
    "manual_bank_transfer",
    "gateway"
  ];
  const tenders: ReportTenderLine[] = [...tenderTypes]
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((tenderType) => {
      const live = expectedByTender.get(tenderType);
      const line = stored.get(tenderType);
      const withCorrections = effective.get(tenderType);
      return {
        tenderType,
        payments: live?.payments ?? "0.00",
        reversals: live?.reversals ?? "0.00",
        expected: closed && line ? line.expected : (live?.expected ?? "0.00"),
        counted: line ? line.counted : null,
        variance: line ? line.variance : null,
        correction: withCorrections?.correction ?? "0.00",
        effectiveCounted: withCorrections?.effectiveCounted ?? null,
        effectiveVariance: withCorrections?.effectiveVariance ?? null
      };
    });

  return {
    register: {
      id: register.id,
      code: register.code,
      name: register.name,
      locationLabel: register.location_label
    },
    session,
    live: !closed,
    openingFloat: session.openingFloat,
    sales: {
      count: Number(salesRows[0]!.sale_count),
      total: normalizeMoney(String(salesRows[0]!.sale_total))
    },
    tenders,
    movementTotals: {
      in: fromCents(expected.movementsInCents),
      out: fromCents(expected.movementsOutCents)
    },
    movements,
    closeRequests,
    variance: finalRequest
      ? {
          total: finalRequest.varianceTotal,
          gross: finalRequest.varianceGross,
          reason: finalRequest.varianceReason,
          approvalThreshold: finalRequest.approvalThreshold,
          decision: finalRequest.decision
        }
      : null,
    corrections
  };
}

// ---------------------------------------------------------------------------
// Close (cash-up)
// ---------------------------------------------------------------------------

export type CloseRegisterSessionBody = {
  /** `closed`: the session is now closed; `pending_approval`: it is `closing`, waiting for an approver; `reopened`: an approver rejected the count and the session is `open` again. */
  outcome: "closed" | "pending_approval" | "reopened";
  report: RegisterCashUpReport;
};

export type CloseRegisterSessionOutcome =
  | { kind: "not_found" }
  | { kind: "session_not_open"; status: RegisterSessionStatus }
  | { kind: "not_session_cashier" }
  | { kind: "missing_count"; tenderTypes: PaymentTenderType[] }
  | { kind: "variance_reason_required" }
  | {
      kind: "closed" | "pending_approval" | "replayed";
      body: CloseRegisterSessionBody;
    };

async function insertCloseLines(
  tx: Bun.SQL,
  tenantId: string,
  sessionId: string,
  closeRequestId: string,
  lines: readonly CountedTenderLine[]
): Promise<void> {
  // Sequential - one reserved `tx` connection.
  for (const line of lines) {
    await tx`
      INSERT INTO awcms_commerce_register_close_lines (
        tenant_id, close_request_id, session_id, tender_type, expected, counted, variance
      )
      VALUES (
        ${tenantId}, ${closeRequestId}, ${sessionId}, ${line.tenderType},
        ${line.expected}, ${line.counted}, ${line.variance}
      )
    `;
  }
}

async function announceClosed(
  tx: Bun.SQL,
  tenantId: string,
  session: RegisterSessionRecord,
  request: ReportCloseRequest,
  lines: readonly CountedTenderLine[],
  actorTenantUserId: string,
  correlationId: string | undefined
): Promise<void> {
  const attributes = {
    registerId: session.registerId,
    registerCode: session.registerCode,
    attempt: request.attempt,
    decision: request.decision,
    approvalRequired: request.approvalRequired,
    approvalThreshold: request.approvalThreshold,
    varianceTotal: request.varianceTotal,
    varianceGross: request.varianceGross,
    lines: lines.map((line) => ({
      tenderType: line.tenderType,
      expected: line.expected,
      counted: line.counted,
      variance: line.variance
    }))
  };
  // The free-text variance reason stays on the close request row; the audit
  // trail and the event carry money and ids only.
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "register_session.close",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: session.id,
    severity: request.varianceGross === "0.00" ? "info" : "warning",
    message: `Register session on ${session.registerCode} closed (variance ${request.varianceTotal}).`,
    attributes,
    correlationId
  });
  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_REGISTER_SESSION_CLOSED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_REGISTER_SESSION_AGGREGATE_TYPE,
    aggregateId: session.id,
    producerModule: PRODUCER_MODULE,
    correlationId,
    actorTenantUserId,
    payload: { sessionId: session.id, ...attributes }
  });
}

/**
 * Closes (cash-ups) a session. See this file's header for the workflow.
 * `hasApprovePermission` is called only when the variance exceeds the
 * threshold - the route answers it from a second `authorizeInTransaction`
 * for `commerce.register_cash_ups.approve`, so a closer who also holds it
 * closes in one step and one who does not leaves the session `closing`.
 *
 * @throws {IdempotencyPayloadMismatchError} same key, different payload.
 */
export async function closeRegisterSession(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  sessionId: string,
  input: CloseSessionInput,
  hasApprovePermission: () => Promise<boolean>,
  correlationId?: string
): Promise<CloseRegisterSessionOutcome> {
  const session = await lockSessionExclusive(tx, tenantId, sessionId);
  if (!session) return { kind: "not_found" };

  const requestHash = computeRequestHash({
    action: CLOSE_SCOPE,
    actorTenantUserId,
    sessionId,
    counted: input.counted,
    varianceReason: input.varianceReason
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    CLOSE_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      body: existing.responseBody as CloseRegisterSessionBody
    };
  }

  if (session.status !== "open") {
    return { kind: "session_not_open", status: session.status };
  }
  if (session.currentCashierTenantUserId !== actorTenantUserId) {
    return { kind: "not_session_cashier" };
  }

  const cashUpSettings = await readCashUpSettings(tx, tenantId);
  const threshold = cashUpSettings.approvalThreshold;
  const expected = await computeSessionExpected(tx, tenantId, session);
  let evaluation;
  try {
    evaluation = evaluateCount(expected.lines, input.counted, threshold);
  } catch (error) {
    if (error instanceof MissingCountError) {
      return { kind: "missing_count", tenderTypes: error.tenderTypes };
    }
    throw error;
  }
  if (evaluation.hasVariance && input.varianceReason === null) {
    return { kind: "variance_reason_required" };
  }

  const attemptRows = (await tx`
    SELECT COALESCE(MAX(attempt), 0) + 1 AS next_attempt
    FROM awcms_commerce_register_close_requests
    WHERE tenant_id = ${tenantId} AND session_id = ${sessionId}
  `) as { next_attempt: string | number }[];
  const attempt = Number(attemptRows[0]!.next_attempt);

  let decision: RegisterCloseDecision = "auto";
  if (evaluation.approvalRequired) {
    // Separation of duties (ADR-0028 D4): the closer holding `approve` does
    // NOT approve their own variance unless the tenant opted in with
    // `cashUp.allowSelfApproval`; by default another user decides.
    decision =
      cashUpSettings.allowSelfApproval && (await hasApprovePermission())
        ? "approved"
        : "pending";
  }
  const decidedNow = decision !== "pending";
  const decidedBy = decision === "approved" ? actorTenantUserId : null;

  const requestRows = (await tx`
    INSERT INTO awcms_commerce_register_close_requests (
      tenant_id, session_id, attempt, requested_by_tenant_user_id,
      variance_total, variance_gross, approval_threshold, approval_required,
      variance_reason, decision, decided_by_tenant_user_id, decided_at, source_key
    )
    VALUES (
      ${tenantId}, ${sessionId}, ${attempt}, ${actorTenantUserId},
      ${evaluation.varianceTotal}, ${evaluation.varianceGross}, ${threshold},
      ${evaluation.approvalRequired}, ${input.varianceReason}, ${decision}, ${decidedBy},
      CASE WHEN ${decidedNow} THEN now() ELSE NULL END, ${`close:${input.idempotencyKey}`}
    )
    RETURNING ${tx.unsafe(REQUEST_COLUMNS)}
  `) as RequestRow[];
  const request = toCloseRequest(requestRows[0]!);
  await insertCloseLines(tx, tenantId, sessionId, request.id, evaluation.lines);

  const before = (await fetchRegisterSession(tx, tenantId, sessionId))!;
  if (decision === "pending") {
    await tx`
      UPDATE awcms_commerce_register_sessions
      SET status = 'closing', updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${sessionId}
    `;
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "register_session.close_requested",
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: sessionId,
      severity: "warning",
      message: `Register session on ${before.registerCode} counted; variance ${request.varianceGross} exceeds the approval threshold ${threshold} and awaits approval.`,
      attributes: {
        attempt,
        varianceTotal: request.varianceTotal,
        varianceGross: request.varianceGross,
        approvalThreshold: threshold
      },
      correlationId
    });
  } else {
    await tx`
      UPDATE awcms_commerce_register_sessions
      SET status = 'closed', closed_at = now(), closed_by_tenant_user_id = ${actorTenantUserId},
          updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${sessionId}
    `;
    const closedSession = (await fetchRegisterSession(
      tx,
      tenantId,
      sessionId
    ))!;
    await announceClosed(
      tx,
      tenantId,
      closedSession,
      request,
      evaluation.lines,
      actorTenantUserId,
      correlationId
    );
  }

  const body: CloseRegisterSessionBody = {
    outcome: decision === "pending" ? "pending_approval" : "closed",
    report: (await fetchRegisterCashUpReport(tx, tenantId, sessionId))!
  };
  await saveIdempotencyRecord(
    tx,
    tenantId,
    CLOSE_SCOPE,
    input.idempotencyKey,
    requestHash,
    200,
    body
  );
  return body.outcome === "pending_approval"
    ? { kind: "pending_approval", body }
    : { kind: "closed", body };
}

// ---------------------------------------------------------------------------
// Approve / reject a pending close
// ---------------------------------------------------------------------------

export type DecideRegisterCloseOutcome =
  | { kind: "not_found" }
  | { kind: "not_pending"; status: RegisterSessionStatus }
  /** The decider is the user who requested the close and `cashUp.allowSelfApproval` is off. */
  | { kind: "self_approval_forbidden" }
  | {
      kind: "approved" | "rejected" | "replayed";
      body: CloseRegisterSessionBody;
    };

/**
 * Decides the pending close request of a `closing` session. Approve closes it
 * (the closer recorded on the session stays the cashier who counted; the
 * approver is on the request); reject returns the session to `open` for a
 * recount, the rejected request kept as history.
 *
 * @throws {IdempotencyPayloadMismatchError} same key, different payload.
 */
export async function decideRegisterClose(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  sessionId: string,
  input: CloseDecisionInput,
  correlationId?: string
): Promise<DecideRegisterCloseOutcome> {
  const session = await lockSessionExclusive(tx, tenantId, sessionId);
  if (!session) return { kind: "not_found" };

  const requestHash = computeRequestHash({
    action: DECISION_SCOPE,
    actorTenantUserId,
    sessionId,
    decision: input.decision,
    note: input.note
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    DECISION_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      body: existing.responseBody as CloseRegisterSessionBody
    };
  }

  if (session.status !== "closing") {
    return { kind: "not_pending", status: session.status };
  }
  const pendingRows = (await tx`
    SELECT ${tx.unsafe(REQUEST_COLUMNS)}
    FROM awcms_commerce_register_close_requests
    WHERE tenant_id = ${tenantId} AND session_id = ${sessionId} AND decision = 'pending'
  `) as RequestRow[];
  const pending = pendingRows[0];
  if (!pending) return { kind: "not_pending", status: session.status };

  // Separation of duties: nobody approves a variance on a count they made
  // themselves, unless the tenant opted in. (Rejecting your own pending count
  // is allowed: it only sends the drawer back to be recounted.)
  if (
    input.decision === "approve" &&
    pending.requested_by_tenant_user_id === actorTenantUserId &&
    !(await readCashUpSettings(tx, tenantId)).allowSelfApproval
  ) {
    return { kind: "self_approval_forbidden" };
  }

  const newDecision = input.decision === "approve" ? "approved" : "rejected";
  const decidedRows = (await tx`
    UPDATE awcms_commerce_register_close_requests
    SET decision = ${newDecision}, decided_by_tenant_user_id = ${actorTenantUserId},
        decided_at = now(), decision_note = ${input.note}
    WHERE tenant_id = ${tenantId} AND id = ${pending.id}
    RETURNING ${tx.unsafe(REQUEST_COLUMNS)}
  `) as RequestRow[];
  const request = toCloseRequest(decidedRows[0]!);

  if (newDecision === "approved") {
    await tx`
      UPDATE awcms_commerce_register_sessions
      SET status = 'closed', closed_at = now(),
          closed_by_tenant_user_id = ${request.requestedByTenantUserId}, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${sessionId}
    `;
    const closedSession = (await fetchRegisterSession(
      tx,
      tenantId,
      sessionId
    ))!;
    await announceClosed(
      tx,
      tenantId,
      closedSession,
      request,
      await readCloseLines(tx, tenantId, request.id),
      actorTenantUserId,
      correlationId
    );
  } else {
    await tx`
      UPDATE awcms_commerce_register_sessions
      SET status = 'open', updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${sessionId}
    `;
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "register_session.close_rejected",
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: sessionId,
      severity: "warning",
      message:
        "A pending register close was rejected; the session is open again for a recount.",
      attributes: {
        attempt: request.attempt,
        varianceGross: request.varianceGross
      },
      correlationId
    });
  }

  const body: CloseRegisterSessionBody = {
    outcome: newDecision === "approved" ? "closed" : "reopened",
    report: (await fetchRegisterCashUpReport(tx, tenantId, sessionId))!
  };
  await saveIdempotencyRecord(
    tx,
    tenantId,
    DECISION_SCOPE,
    input.idempotencyKey,
    requestHash,
    200,
    body
  );
  return { kind: newDecision, body };
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export type RecordRegisterCorrectionOutcome =
  | { kind: "not_found" }
  | { kind: "session_not_closed"; status: RegisterSessionStatus }
  | { kind: "negative_count"; tenderType: PaymentTenderType }
  | { kind: "created" | "replayed"; report: RegisterCashUpReport };

/**
 * Records a compensating correction against a CLOSED session: a signed delta
 * to the counted amount of one or more tenders. The original close request
 * and lines are never touched - the corrected figure is the original plus the
 * sum of its corrections - and the session moves `closed -> corrected`
 * (further corrections keep it `corrected`).
 *
 * @throws {IdempotencyPayloadMismatchError} same key, different payload.
 */
export async function recordRegisterCorrection(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  sessionId: string,
  input: RecordCorrectionInput,
  correlationId?: string
): Promise<RecordRegisterCorrectionOutcome> {
  const session = await lockSessionExclusive(tx, tenantId, sessionId);
  if (!session) return { kind: "not_found" };

  const requestHash = computeRequestHash({
    action: CORRECT_SCOPE,
    actorTenantUserId,
    sessionId,
    reason: input.reason,
    adjustments: input.adjustments
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    CORRECT_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      report: existing.responseBody as RegisterCashUpReport
    };
  }

  if (session.status !== "closed" && session.status !== "corrected") {
    return { kind: "session_not_closed", status: session.status };
  }

  const requests = await listCloseRequests(tx, tenantId, sessionId);
  const finalRequest = requests.find(
    (request) => request.decision === "auto" || request.decision === "approved"
  )!;
  const lines = await readCloseLines(tx, tenantId, finalRequest.id);
  const prior = await listCorrections(tx, tenantId, sessionId);
  try {
    applyCorrections(lines, [
      ...prior.map((correction) => ({
        tenderType: correction.tenderType,
        adjustment: correction.adjustment
      })),
      ...input.adjustments
    ]);
  } catch (error) {
    if (error instanceof NegativeCorrectedCountError) {
      return { kind: "negative_count", tenderType: error.tenderType };
    }
    throw error;
  }

  const correctionId = crypto.randomUUID();
  const sourceKey = `correction:${input.idempotencyKey}`;
  for (const adjustment of input.adjustments) {
    await tx`
      INSERT INTO awcms_commerce_register_corrections (
        tenant_id, session_id, correction_id, tender_type, adjustment, reason,
        actor_tenant_user_id, source_key
      )
      VALUES (
        ${tenantId}, ${sessionId}, ${correctionId}, ${adjustment.tenderType},
        ${adjustment.adjustment}, ${input.reason}, ${actorTenantUserId}, ${sourceKey}
      )
    `;
  }
  if (session.status === "closed") {
    await tx`
      UPDATE awcms_commerce_register_sessions
      SET status = 'corrected', updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${sessionId}
    `;
  }

  const attributes = {
    correctionId,
    adjustments: input.adjustments.map((adjustment) => ({
      tenderType: adjustment.tenderType,
      adjustment: adjustment.adjustment
    }))
  };
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "register_session.correct",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: sessionId,
    severity: "warning",
    message:
      "A compensating correction was recorded against a closed register session.",
    attributes,
    correlationId
  });
  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_REGISTER_SESSION_CORRECTED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_REGISTER_SESSION_AGGREGATE_TYPE,
    aggregateId: sessionId,
    producerModule: PRODUCER_MODULE,
    correlationId,
    actorTenantUserId,
    payload: { sessionId, ...attributes }
  });

  const report = (await fetchRegisterCashUpReport(tx, tenantId, sessionId))!;
  await saveIdempotencyRecord(
    tx,
    tenantId,
    CORRECT_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    report
  );
  return { kind: "created", report };
}
