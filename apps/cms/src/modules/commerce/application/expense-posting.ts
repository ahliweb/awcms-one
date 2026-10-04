/**
 * Expense posting, approval and reversal (Issue #294, epic #281, ADR-0031) -
 * the half of the expense model that touches the POS register. Drafts, reads
 * and receipts are `expense-directory.ts`.
 *
 * ## The one rule: an expense never edits a cash-up total
 *
 * A cash-up derives its expected cash from `Σ movements in − Σ movements out`
 * (ADR-0028 D2). A drawer-paid expense therefore reaches a cash-up in exactly
 * one way, a register MOVEMENT written through `appendRegisterMovement` - the
 * same writer the manual movement route uses:
 *
 *   - POSTING appends an `expense` cash-OUT movement to the expense's (open)
 *     session;
 *   - REVERSAL appends a `correction` cash-IN movement (the compensating entry;
 *     the original row is untouched - movements are append-only) to the same
 *     session if it is still open, else to the open session of the SAME
 *     register - the cash goes back into whichever drawer is open now, and a
 *     closed shift's numbers are never rewritten.
 *
 * "Reflected exactly once" is mechanical: a movement `source_key`
 * (`expense:<id>:post` / `:reverse`) and `sql/991`'s partial UNIQUE index (at
 * most one out and one in per expense) are the independent guards behind the
 * expense row lock and the idempotency store.
 *
 * ## Approval (segregation of duties)
 *
 * See `domain/expense.ts` (`decidePosting`): within the tenant threshold an
 * expense is posted outright; above it, only someone who holds
 * `commerce.expense_postings.approve` AND did not create the expense may post
 * it in one step, otherwise it waits (`pending_approval`) for an approver who
 * is neither its creator nor its submitter. `workflow_approval` is not used -
 * ADR-0031 D4 records why (its definitions are tenant-authored and its
 * condition/action registry is upstream's source, so a tenant that never
 * published a definition would have no approval at all - fail-open).
 *
 * ## Concurrency
 *
 * Every mutation locks the expense row `FOR NO KEY UPDATE` FIRST, reads the
 * idempotency store AFTER the lock (a retry that waited replays the committed
 * record), then takes the session `FOR SHARE` (many in parallel; a close takes
 * it exclusively, so a close and a posting serialise). The lock order is always
 * expense -> session, and nothing locks a session then an expense, so there is
 * no cycle.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../_shared/idempotency";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_EXPENSE_AGGREGATE_TYPE,
  COMMERCE_EXPENSE_POSTED_EVENT_TYPE,
  COMMERCE_EXPENSE_REVERSED_EVENT_TYPE
} from "../domain/commerce-events";
import {
  approvalSegregationViolation,
  decidePosting,
  exceedsApprovalThreshold,
  expenseMovementReference,
  type ExpenseDecisionInput,
  type ExpenseStatus,
  type ExpenseTenderType,
  type KeyedInput,
  type ReverseExpenseInput
} from "../domain/expense";
import { normalizeMoney } from "../domain/price-calculation";
import { fetchExpenseCategory } from "./expense-category-directory";
import {
  fetchExpense,
  fetchExpenseApprovalThreshold,
  type ExpenseRecord
} from "./expense-directory";
import { IdempotencyPayloadMismatchError } from "./order-directory";
import {
  appendRegisterMovement,
  lockSessionShared
} from "./register-session-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "expense";
const PRODUCER_MODULE = "commerce";

const POST_SCOPE = "commerce.expenses.post";
const DECIDE_SCOPE = "commerce.expenses.decide";
const REVERSE_SCOPE = "commerce.expenses.reverse";

/** What a post / decision / reversal answers (and what an idempotent replay returns). */
export type ExpenseActionResult = {
  expense: ExpenseRecord;
  /** `posted` (in effect), `pending_approval` (waiting for an approver), `rejected` (back to draft), `reversed`. */
  outcome: "posted" | "pending_approval" | "rejected" | "reversed";
};

type LockedExpense = {
  id: string;
  status: ExpenseStatus;
  categoryId: string;
  amount: string;
  tenderType: ExpenseTenderType;
  registerSessionId: string | null;
  createdBy: string;
  submittedBy: string | null;
  postedMovementId: string | null;
};

async function lockExpense(
  tx: Bun.SQL,
  tenantId: string,
  expenseId: string
): Promise<LockedExpense | null> {
  const rows = (await tx`
    SELECT id, status, category_id, amount, tender_type, register_session_id,
           created_by_tenant_user_id, submitted_by_tenant_user_id, posted_movement_id
    FROM awcms_commerce_expenses
    WHERE tenant_id = ${tenantId} AND id = ${expenseId} AND deleted_at IS NULL
    FOR NO KEY UPDATE
  `) as {
    id: string;
    status: string;
    category_id: string;
    amount: string;
    tender_type: string;
    register_session_id: string | null;
    created_by_tenant_user_id: string;
    submitted_by_tenant_user_id: string | null;
    posted_movement_id: string | null;
  }[];
  const row = rows[0];
  return row
    ? {
        id: row.id,
        status: row.status as ExpenseStatus,
        categoryId: row.category_id,
        amount: normalizeMoney(String(row.amount)),
        tenderType: row.tender_type as ExpenseTenderType,
        registerSessionId: row.register_session_id,
        createdBy: row.created_by_tenant_user_id,
        submittedBy: row.submitted_by_tenant_user_id,
        postedMovementId: row.posted_movement_id
      }
    : null;
}

/** Replays a stored answer for the same key, refuses a different payload under it, else `null`. */
async function replayOrNull(
  tx: Bun.SQL,
  tenantId: string,
  scope: string,
  idempotencyKey: string,
  requestHash: string
): Promise<ExpenseActionResult | null> {
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    scope,
    idempotencyKey
  );
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw new IdempotencyPayloadMismatchError();
  }
  return existing.responseBody as ExpenseActionResult;
}

// ---------------------------------------------------------------------------
// Finalise: the one place an expense becomes `posted`
// ---------------------------------------------------------------------------

type FinalizeOutcome =
  | { kind: "posted"; expense: ExpenseRecord }
  | { kind: "session_not_found" }
  | { kind: "session_not_open" };

async function finalizePosting(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  expense: LockedExpense,
  decision: "auto" | "approved",
  threshold: string,
  correlationId?: string
): Promise<FinalizeOutcome> {
  let movementId: string | null = null;

  if (expense.registerSessionId !== null) {
    // Share-lock the session: a close (exclusive) and this posting serialise,
    // so the movement lands in a session that is open at this very moment.
    const session = await lockSessionShared(
      tx,
      tenantId,
      expense.registerSessionId
    );
    if (!session) return { kind: "session_not_found" };
    if (session.status !== "open") return { kind: "session_not_open" };

    const movement = await appendRegisterMovement(tx, {
      tenantId,
      actorTenantUserId,
      sessionId: session.id,
      movementType: "expense",
      direction: "out",
      amount: expense.amount,
      reference: expenseMovementReference(expense.id),
      note: null,
      sourceKey: `expense:${expense.id}:post`,
      expenseId: expense.id,
      correlationId
    });
    movementId = movement.id;
  }

  await tx`
    UPDATE awcms_commerce_expenses
    SET status = 'posted',
        submitted_by_tenant_user_id = COALESCE(submitted_by_tenant_user_id, ${actorTenantUserId}),
        submitted_at = COALESCE(submitted_at, now()),
        approval_threshold = ${threshold},
        decision = ${decision},
        decided_by_tenant_user_id = CASE WHEN ${decision}::text = 'approved' THEN ${actorTenantUserId}::uuid ELSE NULL END,
        decided_at = CASE WHEN ${decision}::text = 'approved' THEN now() ELSE NULL END,
        decision_note = NULL,
        posted_by_tenant_user_id = ${actorTenantUserId},
        posted_at = now(),
        posted_movement_id = ${movementId},
        updated_by_tenant_user_id = ${actorTenantUserId},
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${expense.id}
  `;

  // Money, ids and the decision only - never the description / payee text.
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "expense.post",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: expense.id,
    message: `Expense posted: ${expense.amount} (${expense.tenderType}), ${decision}.`,
    attributes: {
      categoryId: expense.categoryId,
      amount: expense.amount,
      tenderType: expense.tenderType,
      registerSessionId: expense.registerSessionId,
      movementId,
      decision,
      approvalThreshold: threshold
    },
    correlationId
  });
  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_EXPENSE_POSTED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_EXPENSE_AGGREGATE_TYPE,
    aggregateId: expense.id,
    producerModule: PRODUCER_MODULE,
    correlationId,
    actorTenantUserId,
    payload: {
      expenseId: expense.id,
      categoryId: expense.categoryId,
      amount: expense.amount,
      tenderType: expense.tenderType,
      registerSessionId: expense.registerSessionId,
      movementId,
      decision
    }
  });

  return {
    kind: "posted",
    expense: (await fetchExpense(tx, tenantId, expense.id))!
  };
}

// ---------------------------------------------------------------------------
// Post (submit)
// ---------------------------------------------------------------------------

export type PostExpenseOutcome =
  | { kind: "not_found" }
  | { kind: "not_postable"; status: ExpenseStatus }
  | { kind: "category_inactive" }
  | { kind: "session_not_found" }
  | { kind: "session_not_open" }
  | {
      kind: "posted" | "pending_approval" | "replayed";
      result: ExpenseActionResult;
    };

/**
 * Submits a draft for posting. Within the tenant threshold it posts outright; a
 * poster who holds the approve permission (and did not create the expense)
 * posts an above-threshold one in a single step; anyone else leaves it
 * `pending_approval` for a second person.
 *
 * @param actorCanApprove resolved through the access chokepoint by the route,
 *   and only called when the amount is above the threshold.
 * @throws {IdempotencyPayloadMismatchError} same key, different payload.
 */
export async function postExpense(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  expenseId: string,
  input: KeyedInput,
  actorCanApprove: () => Promise<boolean>,
  correlationId?: string
): Promise<PostExpenseOutcome> {
  const expense = await lockExpense(tx, tenantId, expenseId);
  if (!expense) return { kind: "not_found" };

  const requestHash = computeRequestHash({
    action: POST_SCOPE,
    actorTenantUserId,
    expenseId
  });
  const replay = await replayOrNull(
    tx,
    tenantId,
    POST_SCOPE,
    input.idempotencyKey,
    requestHash
  );
  if (replay) return { kind: "replayed", result: replay };

  if (expense.status !== "draft") {
    return { kind: "not_postable", status: expense.status };
  }
  const category = await fetchExpenseCategory(tx, tenantId, expense.categoryId);
  if (!category?.active) return { kind: "category_inactive" };

  const threshold = await fetchExpenseApprovalThreshold(tx, tenantId);
  // `decidePosting` needs the approve answer only above the threshold; ask the
  // chokepoint lazily so an ordinary small expense costs no extra decision.
  const outcome = decidePosting({
    amount: expense.amount,
    threshold,
    creatorTenantUserId: expense.createdBy,
    actorTenantUserId,
    actorCanApprove: exceedsApprovalThreshold(expense.amount, threshold)
      ? await actorCanApprove()
      : false
  });

  if (outcome === "pending") {
    await tx`
      UPDATE awcms_commerce_expenses
      SET status = 'pending_approval', submitted_by_tenant_user_id = ${actorTenantUserId},
          submitted_at = now(), approval_threshold = ${threshold},
          updated_by_tenant_user_id = ${actorTenantUserId}, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${expenseId}
    `;
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "expense.submit",
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: expenseId,
      message: `Expense submitted for approval: ${expense.amount} is above ${threshold}.`,
      attributes: {
        amount: expense.amount,
        approvalThreshold: threshold,
        createdBy: expense.createdBy
      },
      correlationId
    });
    const result: ExpenseActionResult = {
      expense: (await fetchExpense(tx, tenantId, expenseId))!,
      outcome: "pending_approval"
    };
    await saveIdempotencyRecord(
      tx,
      tenantId,
      POST_SCOPE,
      input.idempotencyKey,
      requestHash,
      200,
      result
    );
    return { kind: "pending_approval", result };
  }

  const finalized = await finalizePosting(
    tx,
    tenantId,
    actorTenantUserId,
    expense,
    outcome,
    threshold,
    correlationId
  );
  if (finalized.kind !== "posted") return finalized;
  const result: ExpenseActionResult = {
    expense: finalized.expense,
    outcome: "posted"
  };
  await saveIdempotencyRecord(
    tx,
    tenantId,
    POST_SCOPE,
    input.idempotencyKey,
    requestHash,
    200,
    result
  );
  return { kind: "posted", result };
}

// ---------------------------------------------------------------------------
// Decision (approve / reject)
// ---------------------------------------------------------------------------

export type DecideExpenseOutcome =
  | { kind: "not_found" }
  | { kind: "not_pending"; status: ExpenseStatus }
  | { kind: "segregation_violation"; reason: "creator" | "submitter" }
  | { kind: "session_not_found" }
  | { kind: "session_not_open" }
  | { kind: "approved" | "rejected" | "replayed"; result: ExpenseActionResult };

/**
 * Approves or rejects a `pending_approval` expense. The caller already holds
 * `commerce.expense_postings.approve` (the route's guard). Approving is refused
 * to the expense's creator and to whoever submitted it; approving posts it (and
 * writes the drawer movement, with the APPROVER as the movement's actor);
 * rejecting needs a note and returns the expense to `draft`.
 */
export async function decideExpense(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  expenseId: string,
  input: ExpenseDecisionInput,
  correlationId?: string
): Promise<DecideExpenseOutcome> {
  const expense = await lockExpense(tx, tenantId, expenseId);
  if (!expense) return { kind: "not_found" };

  const requestHash = computeRequestHash({
    action: DECIDE_SCOPE,
    actorTenantUserId,
    expenseId,
    decision: input.decision,
    note: input.note
  });
  const replay = await replayOrNull(
    tx,
    tenantId,
    DECIDE_SCOPE,
    input.idempotencyKey,
    requestHash
  );
  if (replay) return { kind: "replayed", result: replay };

  if (expense.status !== "pending_approval") {
    return { kind: "not_pending", status: expense.status };
  }

  if (input.decision === "reject") {
    await tx`
      UPDATE awcms_commerce_expenses
      SET status = 'draft', decision = 'rejected',
          decided_by_tenant_user_id = ${actorTenantUserId}, decided_at = now(),
          decision_note = ${input.note},
          updated_by_tenant_user_id = ${actorTenantUserId}, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${expenseId}
    `;
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "expense.reject",
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: expenseId,
      message: `Expense rejected: ${expense.amount}.`,
      attributes: { amount: expense.amount },
      correlationId
    });
    const result: ExpenseActionResult = {
      expense: (await fetchExpense(tx, tenantId, expenseId))!,
      outcome: "rejected"
    };
    await saveIdempotencyRecord(
      tx,
      tenantId,
      DECIDE_SCOPE,
      input.idempotencyKey,
      requestHash,
      200,
      result
    );
    return { kind: "rejected", result };
  }

  const violation = approvalSegregationViolation({
    creatorTenantUserId: expense.createdBy,
    submitterTenantUserId: expense.submittedBy,
    approverTenantUserId: actorTenantUserId
  });
  if (violation) return { kind: "segregation_violation", reason: violation };

  const threshold = await fetchExpenseApprovalThreshold(tx, tenantId);
  const finalized = await finalizePosting(
    tx,
    tenantId,
    actorTenantUserId,
    expense,
    "approved",
    threshold,
    correlationId
  );
  if (finalized.kind !== "posted") return finalized;
  const result: ExpenseActionResult = {
    expense: finalized.expense,
    outcome: "posted"
  };
  await saveIdempotencyRecord(
    tx,
    tenantId,
    DECIDE_SCOPE,
    input.idempotencyKey,
    requestHash,
    200,
    result
  );
  return { kind: "approved", result };
}

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

export type ReverseExpenseOutcome =
  | { kind: "not_found" }
  | { kind: "not_reversible"; status: ExpenseStatus }
  | { kind: "no_open_session" }
  | { kind: "reversed" | "replayed"; result: ExpenseActionResult };

/**
 * Reverses a POSTED expense with a compensating entry. A drawer-paid expense
 * appends a `correction` cash-IN movement for the same amount (never an edit of
 * the original movement or of a closed cash-up); with no open session on the
 * register there is nowhere to put the cash back, so the reversal is refused
 * (`no_open_session`) rather than silently skipping the drawer.
 */
export async function reverseExpense(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  expenseId: string,
  input: ReverseExpenseInput,
  correlationId?: string
): Promise<ReverseExpenseOutcome> {
  const expense = await lockExpense(tx, tenantId, expenseId);
  if (!expense) return { kind: "not_found" };

  const requestHash = computeRequestHash({
    action: REVERSE_SCOPE,
    actorTenantUserId,
    expenseId,
    reason: input.reason
  });
  const replay = await replayOrNull(
    tx,
    tenantId,
    REVERSE_SCOPE,
    input.idempotencyKey,
    requestHash
  );
  if (replay) return { kind: "replayed", result: replay };

  if (expense.status !== "posted") {
    return { kind: "not_reversible", status: expense.status };
  }

  let reversalSessionId: string | null = null;
  let reversalMovementId: string | null = null;
  if (expense.registerSessionId !== null) {
    const original = await lockSessionShared(
      tx,
      tenantId,
      expense.registerSessionId
    );
    if (!original) return { kind: "no_open_session" };
    let target: string | null = original.status === "open" ? original.id : null;
    if (target === null) {
      const open = (await tx`
        SELECT id FROM awcms_commerce_register_sessions
        WHERE tenant_id = ${tenantId} AND register_id = ${original.registerId}
          AND status = 'open' AND deleted_at IS NULL
        FOR SHARE
      `) as { id: string }[];
      target = open[0]?.id ?? null;
    }
    if (target === null) return { kind: "no_open_session" };

    const reference = expenseMovementReference(expense.id);
    const movement = await appendRegisterMovement(tx, {
      tenantId,
      actorTenantUserId,
      sessionId: target,
      movementType: "correction",
      direction: "in",
      amount: expense.amount,
      reference,
      // System-generated, never the user's reason text (that stays on the
      // expense and out of every cash-up report and event).
      note: `Reversal of expense ${reference}`,
      sourceKey: `expense:${expense.id}:reverse`,
      expenseId: expense.id,
      correlationId
    });
    reversalSessionId = target;
    reversalMovementId = movement.id;
  }

  await tx`
    UPDATE awcms_commerce_expenses
    SET status = 'reversed', reversed_by_tenant_user_id = ${actorTenantUserId},
        reversed_at = now(), reversal_reason = ${input.reason},
        reversal_session_id = ${reversalSessionId},
        reversal_movement_id = ${reversalMovementId},
        updated_by_tenant_user_id = ${actorTenantUserId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${expenseId}
  `;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "expense.reverse",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: expenseId,
    severity: "warning",
    message: `Expense reversed: ${expense.amount} (${expense.tenderType}).`,
    attributes: {
      categoryId: expense.categoryId,
      amount: expense.amount,
      tenderType: expense.tenderType,
      registerSessionId: expense.registerSessionId,
      reversalSessionId,
      movementId: reversalMovementId
    },
    correlationId
  });
  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_EXPENSE_REVERSED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_EXPENSE_AGGREGATE_TYPE,
    aggregateId: expenseId,
    producerModule: PRODUCER_MODULE,
    correlationId,
    actorTenantUserId,
    payload: {
      expenseId,
      categoryId: expense.categoryId,
      amount: expense.amount,
      tenderType: expense.tenderType,
      registerSessionId: expense.registerSessionId,
      reversalSessionId,
      movementId: reversalMovementId
    }
  });

  const result: ExpenseActionResult = {
    expense: (await fetchExpense(tx, tenantId, expenseId))!,
    outcome: "reversed"
  };
  await saveIdempotencyRecord(
    tx,
    tenantId,
    REVERSE_SCOPE,
    input.idempotencyKey,
    requestHash,
    200,
    result
  );
  return { kind: "reversed", result };
}
