/**
 * Expenses (Issue #294, epic #281, ADR-0031) - reads and the DRAFT half of the
 * model: create, edit, discard and attach a receipt. Posting, the approval
 * decision and reversal (the half that touches the register) are
 * `expense-posting.ts`; categories are `expense-category-directory.ts`.
 *
 * ## Employee scope
 *
 * An expense draft belongs to the person who created it. Editing, discarding
 * or attaching a receipt to a draft is allowed to its CREATOR, or to a
 * supervisor (a user who also holds `commerce.expense_postings.approve`, which
 * the route resolves through the access chokepoint and hands in as
 * `actorIsSupervisor`) - never to another employee who merely holds
 * `commerce.expenses.update`. Reading stays with `commerce.expenses.read`.
 *
 * ## Tenant isolation
 *
 * Every query filters on `tenant_id` explicitly on top of RLS, and an id from
 * another tenant resolves to nothing, exactly like an unknown id (no BOLA
 * oracle). The register session an expense names is checked by id inside the
 * tenant, so a foreign session id answers `session_not_found`.
 */
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
  fetchNewsMediaObjectById,
  isMediaObjectDownloadable
} from "../../media-library/application/media-object-directory";
import { fetchModuleSettingsView } from "../../module-management/application/module-settings";
import {
  foldExpenseTotals,
  resolveExpenseSettings,
  type CreateExpenseInput,
  type ExpenseDecision,
  type ExpenseListFilters,
  type ExpenseStatus,
  type ExpenseTenderType,
  type UpdateExpenseInput
} from "../domain/expense";
import type { ExpenseCsvRow } from "../domain/expense-csv";
import {
  fromCents,
  normalizeMoney,
  toCents
} from "../domain/price-calculation";
import { IdempotencyPayloadMismatchError } from "./order-directory";
import { fetchExpenseCategory } from "./expense-category-directory";
import { fetchRegisterSession } from "./register-session-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "expense";

const CREATE_SCOPE = "commerce.expenses.create";

export const EXPENSE_LIST_LIMIT = 50;

// ---------------------------------------------------------------------------
// Types and row mapping
// ---------------------------------------------------------------------------

export type ExpenseRecord = {
  id: string;
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  status: ExpenseStatus;
  /** `numeric(14,2)` string. */
  amount: string;
  tenderType: ExpenseTenderType;
  /** `YYYY-MM-DD`. */
  occurredOn: string;
  description: string;
  payeeName: string | null;
  registerSessionId: string | null;
  /** Whether a private receipt is attached - its object id is never exposed; it is reachable only through the permission-gated receipt route. */
  hasReceipt: boolean;
  createdByTenantUserId: string;
  createdAt: string;
  updatedAt: string;
  submittedByTenantUserId: string | null;
  submittedAt: string | null;
  approvalThreshold: string | null;
  decision: ExpenseDecision | null;
  decidedByTenantUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  postedByTenantUserId: string | null;
  postedAt: string | null;
  postedMovementId: string | null;
  reversedByTenantUserId: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  reversalSessionId: string | null;
  reversalMovementId: string | null;
  cancelledByTenantUserId: string | null;
  cancelledAt: string | null;
};

export type ExpenseRow = {
  id: string;
  category_id: string;
  category_code: string;
  category_name: string;
  status: string;
  amount: string;
  tender_type: string;
  occurred_on: string;
  description: string;
  payee_name: string | null;
  register_session_id: string | null;
  has_receipt: boolean;
  created_by_tenant_user_id: string;
  created_at: Date;
  updated_at: Date;
  submitted_by_tenant_user_id: string | null;
  submitted_at: Date | null;
  approval_threshold: string | null;
  decision: string | null;
  decided_by_tenant_user_id: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  posted_by_tenant_user_id: string | null;
  posted_at: Date | null;
  posted_movement_id: string | null;
  reversed_by_tenant_user_id: string | null;
  reversed_at: Date | null;
  reversal_reason: string | null;
  reversal_session_id: string | null;
  reversal_movement_id: string | null;
  cancelled_by_tenant_user_id: string | null;
  cancelled_at: Date | null;
};

/** The shared SELECT list; `e` is `awcms_commerce_expenses`, `c` its category. */
export const EXPENSE_SELECT = `e.id, e.category_id, c.code AS category_code, c.name AS category_name,
  e.status, e.amount, e.tender_type, to_char(e.occurred_on, 'YYYY-MM-DD') AS occurred_on,
  e.description, e.payee_name, e.register_session_id,
  (e.receipt_media_object_id IS NOT NULL) AS has_receipt,
  e.created_by_tenant_user_id, e.created_at, e.updated_at,
  e.submitted_by_tenant_user_id, e.submitted_at, e.approval_threshold, e.decision,
  e.decided_by_tenant_user_id, e.decided_at, e.decision_note,
  e.posted_by_tenant_user_id, e.posted_at, e.posted_movement_id,
  e.reversed_by_tenant_user_id, e.reversed_at, e.reversal_reason,
  e.reversal_session_id, e.reversal_movement_id,
  e.cancelled_by_tenant_user_id, e.cancelled_at`;

const iso = (value: Date | null): string | null =>
  value ? value.toISOString() : null;

export function toExpenseRecord(row: ExpenseRow): ExpenseRecord {
  return {
    id: row.id,
    categoryId: row.category_id,
    categoryCode: row.category_code,
    categoryName: row.category_name,
    status: row.status as ExpenseStatus,
    amount: normalizeMoney(String(row.amount)),
    tenderType: row.tender_type as ExpenseTenderType,
    occurredOn: row.occurred_on,
    description: row.description,
    payeeName: row.payee_name,
    registerSessionId: row.register_session_id,
    hasReceipt: row.has_receipt,
    createdByTenantUserId: row.created_by_tenant_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    submittedByTenantUserId: row.submitted_by_tenant_user_id,
    submittedAt: iso(row.submitted_at),
    approvalThreshold:
      row.approval_threshold === null
        ? null
        : normalizeMoney(String(row.approval_threshold)),
    decision: row.decision as ExpenseDecision | null,
    decidedByTenantUserId: row.decided_by_tenant_user_id,
    decidedAt: iso(row.decided_at),
    decisionNote: row.decision_note,
    postedByTenantUserId: row.posted_by_tenant_user_id,
    postedAt: iso(row.posted_at),
    postedMovementId: row.posted_movement_id,
    reversedByTenantUserId: row.reversed_by_tenant_user_id,
    reversedAt: iso(row.reversed_at),
    reversalReason: row.reversal_reason,
    reversalSessionId: row.reversal_session_id,
    reversalMovementId: row.reversal_movement_id,
    cancelledByTenantUserId: row.cancelled_by_tenant_user_id,
    cancelledAt: iso(row.cancelled_at)
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchExpense(
  tx: Bun.SQL,
  tenantId: string,
  expenseId: string
): Promise<ExpenseRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(EXPENSE_SELECT)}
    FROM awcms_commerce_expenses e
    JOIN awcms_commerce_expense_categories c
      ON c.tenant_id = e.tenant_id AND c.id = e.category_id
    WHERE e.tenant_id = ${tenantId} AND e.id = ${expenseId} AND e.deleted_at IS NULL
  `) as ExpenseRow[];
  return rows[0] ? toExpenseRecord(rows[0]) : null;
}

export type ExpenseListPage = {
  items: ExpenseRecord[];
  nextCursor: string | null;
};

/** Keyset history, newest first, over `(tenant_id, created_at, id)`-indexed columns. */
export async function listExpenses(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null,
  filters: ExpenseListFilters = {}
): Promise<ExpenseListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const status = filters.status ?? null;
  const categoryId = filters.categoryId ?? null;
  const sessionId = filters.registerSessionId ?? null;
  const from = filters.from ?? null;
  const to = filters.to ?? null;

  const rows = (await tx`
    SELECT ${tx.unsafe(EXPENSE_SELECT)},
           ${tx.unsafe(keysetCursorCreatedAtSql("e"))} AS created_at_cursor
    FROM awcms_commerce_expenses e
    JOIN awcms_commerce_expense_categories c
      ON c.tenant_id = e.tenant_id AND c.id = e.category_id
    WHERE e.tenant_id = ${tenantId}
      AND e.deleted_at IS NULL
      AND (${status}::text IS NULL OR e.status = ${status})
      AND (${categoryId}::uuid IS NULL OR e.category_id = ${categoryId})
      AND (${sessionId}::uuid IS NULL OR e.register_session_id = ${sessionId})
      AND (${from}::date IS NULL OR e.occurred_on >= ${from}::date)
      AND (${to}::date IS NULL OR e.occurred_on <= ${to}::date)
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (e.created_at, e.id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ${EXPENSE_LIST_LIMIT}
  `) as (ExpenseRow & { created_at_cursor: string })[];

  const last = rows[rows.length - 1];
  return {
    items: rows.map(toExpenseRecord),
    nextCursor:
      rows.length === EXPENSE_LIST_LIMIT && last
        ? encodeKeysetCursor(last.created_at_cursor, last.id)
        : null
  };
}

/** The tenant's expense approval threshold (`expenses.approvalThreshold`, strict `0.00` default). */
export async function fetchExpenseApprovalThreshold(
  tx: Bun.SQL,
  tenantId: string
): Promise<string> {
  const view = await fetchModuleSettingsView(tx, tenantId, "commerce");
  return resolveExpenseSettings(view?.effective).approvalThreshold;
}

// ---------------------------------------------------------------------------
// Draft create
// ---------------------------------------------------------------------------

export type CreateExpenseOutcome =
  | { kind: "category_not_found" }
  | { kind: "category_inactive" }
  | { kind: "session_not_found" }
  | { kind: "session_not_open" }
  | { kind: "created" | "replayed"; expense: ExpenseRecord };

/**
 * Creates a DRAFT. Idempotent on `Idempotency-Key` (shared store): the same key
 * with the same body replays the stored record, with a different body is a
 * conflict. A draft touches no register and no cash-up.
 *
 * @throws {IdempotencyPayloadMismatchError} same key, different payload.
 */
export async function createExpenseDraft(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateExpenseInput,
  correlationId?: string
): Promise<CreateExpenseOutcome> {
  const requestHash = computeRequestHash({
    action: CREATE_SCOPE,
    actorTenantUserId,
    categoryId: input.categoryId,
    amount: input.amount,
    tenderType: input.tenderType,
    occurredOn: input.occurredOn,
    description: input.description,
    payeeName: input.payeeName,
    registerSessionId: input.registerSessionId
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    CREATE_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      expense: existing.responseBody as ExpenseRecord
    };
  }

  const category = await fetchExpenseCategory(tx, tenantId, input.categoryId);
  if (!category) return { kind: "category_not_found" };
  if (!category.active) return { kind: "category_inactive" };

  if (input.registerSessionId !== null) {
    const session = await fetchRegisterSession(
      tx,
      tenantId,
      input.registerSessionId
    );
    if (!session) return { kind: "session_not_found" };
    if (session.status !== "open") return { kind: "session_not_open" };
  }

  const rows = (await tx`
    INSERT INTO awcms_commerce_expenses (
      tenant_id, category_id, amount, tender_type, occurred_on, description,
      payee_name, register_session_id, created_by_tenant_user_id,
      updated_by_tenant_user_id
    )
    VALUES (
      ${tenantId}, ${input.categoryId}, ${input.amount}, ${input.tenderType},
      ${input.occurredOn}::date, ${input.description}, ${input.payeeName},
      ${input.registerSessionId}, ${actorTenantUserId}, ${actorTenantUserId}
    )
    RETURNING id
  `) as { id: string }[];
  const id = rows[0]!.id;

  // Money, ids and the tender only - never the free-text description / payee.
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "expense.create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    message: `Draft expense recorded: ${input.amount} (${input.tenderType}).`,
    attributes: {
      categoryId: input.categoryId,
      amount: input.amount,
      tenderType: input.tenderType,
      registerSessionId: input.registerSessionId
    },
    correlationId
  });

  const expense = (await fetchExpense(tx, tenantId, id))!;
  await saveIdempotencyRecord(
    tx,
    tenantId,
    CREATE_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    expense
  );
  return { kind: "created", expense };
}

// ---------------------------------------------------------------------------
// Draft update / discard
// ---------------------------------------------------------------------------

export type DraftMutationGuard =
  | { kind: "not_found" }
  | { kind: "not_draft"; status: ExpenseStatus }
  | { kind: "forbidden" };

export type UpdateExpenseOutcome =
  | DraftMutationGuard
  | { kind: "category_not_found" }
  | { kind: "category_inactive" }
  | { kind: "session_not_found" }
  | { kind: "session_not_open" }
  | { kind: "drawer_requires_cash" }
  | { kind: "updated"; expense: ExpenseRecord };

type DraftRow = {
  id: string;
  status: string;
  category_id: string;
  amount: string;
  tender_type: string;
  occurred_on: string;
  description: string;
  payee_name: string | null;
  register_session_id: string | null;
  created_by_tenant_user_id: string;
};

async function lockDraftRow(
  tx: Bun.SQL,
  tenantId: string,
  expenseId: string
): Promise<DraftRow | null> {
  const rows = (await tx`
    SELECT id, status, category_id, amount, tender_type,
           to_char(occurred_on, 'YYYY-MM-DD') AS occurred_on, description,
           payee_name, register_session_id, created_by_tenant_user_id
    FROM awcms_commerce_expenses
    WHERE tenant_id = ${tenantId} AND id = ${expenseId} AND deleted_at IS NULL
    FOR NO KEY UPDATE
  `) as DraftRow[];
  return rows[0] ?? null;
}

/** Edits a DRAFT (any subset of its fields). Creator or supervisor only. */
export async function updateExpenseDraft(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  expenseId: string,
  input: UpdateExpenseInput,
  actorIsSupervisor: () => Promise<boolean>,
  correlationId?: string
): Promise<UpdateExpenseOutcome> {
  const current = await lockDraftRow(tx, tenantId, expenseId);
  if (!current) return { kind: "not_found" };
  if (current.status !== "draft") {
    return { kind: "not_draft", status: current.status as ExpenseStatus };
  }
  if (
    current.created_by_tenant_user_id !== actorTenantUserId &&
    !(await actorIsSupervisor())
  ) {
    return { kind: "forbidden" };
  }

  const next = {
    categoryId: input.categoryId ?? current.category_id,
    amount: input.amount ?? normalizeMoney(String(current.amount)),
    tenderType: (input.tenderType ?? current.tender_type) as ExpenseTenderType,
    occurredOn: input.occurredOn ?? current.occurred_on,
    description: input.description ?? current.description,
    payeeName:
      input.payeeName !== undefined ? input.payeeName : current.payee_name,
    registerSessionId:
      input.registerSessionId !== undefined
        ? input.registerSessionId
        : current.register_session_id
  };

  if (next.registerSessionId !== null && next.tenderType !== "cash") {
    return { kind: "drawer_requires_cash" };
  }
  if (
    input.categoryId !== undefined &&
    input.categoryId !== current.category_id
  ) {
    const category = await fetchExpenseCategory(tx, tenantId, next.categoryId);
    if (!category) return { kind: "category_not_found" };
    if (!category.active) return { kind: "category_inactive" };
  }
  if (
    input.registerSessionId !== undefined &&
    next.registerSessionId !== null &&
    next.registerSessionId !== current.register_session_id
  ) {
    const session = await fetchRegisterSession(
      tx,
      tenantId,
      next.registerSessionId
    );
    if (!session) return { kind: "session_not_found" };
    if (session.status !== "open") return { kind: "session_not_open" };
  }

  await tx`
    UPDATE awcms_commerce_expenses
    SET category_id = ${next.categoryId}, amount = ${next.amount},
        tender_type = ${next.tenderType}, occurred_on = ${next.occurredOn}::date,
        description = ${next.description}, payee_name = ${next.payeeName},
        register_session_id = ${next.registerSessionId},
        updated_by_tenant_user_id = ${actorTenantUserId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${expenseId}
  `;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "expense.update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: expenseId,
    message: `Draft expense updated: ${next.amount} (${next.tenderType}).`,
    attributes: {
      categoryId: next.categoryId,
      amount: next.amount,
      tenderType: next.tenderType,
      registerSessionId: next.registerSessionId,
      changed: Object.keys(input).sort()
    },
    correlationId
  });

  return {
    kind: "updated",
    expense: (await fetchExpense(tx, tenantId, expenseId))!
  };
}

export type CancelExpenseOutcome =
  | DraftMutationGuard
  | { kind: "cancelled" | "replayed"; expense: ExpenseRecord };

const CANCEL_SCOPE = "commerce.expenses.cancel";

/** Discards a DRAFT (terminal `cancelled`). Idempotent; creator or supervisor only. */
export async function cancelExpenseDraft(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  expenseId: string,
  idempotencyKey: string,
  actorIsSupervisor: () => Promise<boolean>,
  correlationId?: string
): Promise<CancelExpenseOutcome> {
  const current = await lockDraftRow(tx, tenantId, expenseId);
  if (!current) return { kind: "not_found" };

  const requestHash = computeRequestHash({
    action: CANCEL_SCOPE,
    actorTenantUserId,
    expenseId
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    CANCEL_SCOPE,
    idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      expense: existing.responseBody as ExpenseRecord
    };
  }

  if (current.status !== "draft") {
    return { kind: "not_draft", status: current.status as ExpenseStatus };
  }
  if (
    current.created_by_tenant_user_id !== actorTenantUserId &&
    !(await actorIsSupervisor())
  ) {
    return { kind: "forbidden" };
  }

  await tx`
    UPDATE awcms_commerce_expenses
    SET status = 'cancelled', cancelled_by_tenant_user_id = ${actorTenantUserId},
        cancelled_at = now(), updated_by_tenant_user_id = ${actorTenantUserId},
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${expenseId}
  `;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "expense.cancel",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: expenseId,
    message: "Draft expense discarded.",
    attributes: { amount: normalizeMoney(String(current.amount)) },
    correlationId
  });

  const expense = (await fetchExpense(tx, tenantId, expenseId))!;
  await saveIdempotencyRecord(
    tx,
    tenantId,
    CANCEL_SCOPE,
    idempotencyKey,
    requestHash,
    200,
    expense
  );
  return { kind: "cancelled", expense };
}

// ---------------------------------------------------------------------------
// Receipt (a PRIVATE media-library object)
// ---------------------------------------------------------------------------

export type AttachReceiptOutcome =
  | { kind: "not_found" }
  | { kind: "not_attachable"; status: ExpenseStatus }
  | { kind: "forbidden" }
  | { kind: "receipt_already_attached" }
  | { kind: "media_not_found" }
  | { kind: "media_not_eligible" }
  | { kind: "media_already_used" }
  | { kind: "attached"; expense: ExpenseRecord };

/**
 * Attaches a private receipt. Rules, each one a guard against a different
 * misuse (ADR-0031 D5):
 *
 *   - the object must exist in this tenant, be `visibility = private` and be
 *     downloadable (verified) - a PUBLIC object would leak through a permanent
 *     URL the registry already hands out;
 *   - the ATTACHER must be the object's uploader - otherwise `receipts.create`
 *     would let an employee attach any private object whose id they learned
 *     (a product's protected PDF, a colleague's file) and read it back through
 *     the receipt route;
 *   - an object that gates a product download is refused, and the table's
 *     UNIQUE index lets one object serve one expense only;
 *   - a draft's receipt may be replaced by its creator or a supervisor; a
 *     posted/reversed expense accepts one ONCE (a receipt often arrives after
 *     the cash left) and is never replaced - the table's trigger agrees.
 */
export async function attachExpenseReceipt(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  expenseId: string,
  mediaObjectId: string,
  actorIsSupervisor: () => Promise<boolean>,
  correlationId?: string
): Promise<AttachReceiptOutcome> {
  const rows = (await tx`
    SELECT status, created_by_tenant_user_id, receipt_media_object_id
    FROM awcms_commerce_expenses
    WHERE tenant_id = ${tenantId} AND id = ${expenseId} AND deleted_at IS NULL
    FOR NO KEY UPDATE
  `) as {
    status: string;
    created_by_tenant_user_id: string;
    receipt_media_object_id: string | null;
  }[];
  const current = rows[0];
  if (!current) return { kind: "not_found" };
  const status = current.status as ExpenseStatus;

  if (status === "draft") {
    if (
      current.created_by_tenant_user_id !== actorTenantUserId &&
      !(await actorIsSupervisor())
    ) {
      return { kind: "forbidden" };
    }
  } else if (status === "posted" || status === "reversed") {
    if (current.receipt_media_object_id !== null) {
      return { kind: "receipt_already_attached" };
    }
  } else {
    return { kind: "not_attachable", status };
  }

  const media = await fetchNewsMediaObjectById(tx, tenantId, mediaObjectId);
  if (!media) return { kind: "media_not_found" };
  if (
    media.visibility !== "private" ||
    !isMediaObjectDownloadable(media.status) ||
    media.createdByTenantUserId !== actorTenantUserId
  ) {
    return { kind: "media_not_eligible" };
  }

  const gated = (await tx`
    SELECT 1 AS present FROM awcms_commerce_protected_media_links
    WHERE tenant_id = ${tenantId} AND media_object_id = ${mediaObjectId}
    LIMIT 1
  `) as { present: number }[];
  const used = (await tx`
    SELECT 1 AS present FROM awcms_commerce_expenses
    WHERE tenant_id = ${tenantId} AND receipt_media_object_id = ${mediaObjectId}
      AND id <> ${expenseId}
    LIMIT 1
  `) as { present: number }[];
  if (gated.length > 0 || used.length > 0)
    return { kind: "media_already_used" };

  await tx`
    UPDATE awcms_commerce_expenses
    SET receipt_media_object_id = ${mediaObjectId},
        updated_by_tenant_user_id = ${actorTenantUserId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${expenseId}
  `;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "expense.receipt_attach",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: expenseId,
    message: "Private receipt attached to an expense.",
    attributes: { mediaObjectId, status },
    correlationId
  });

  return {
    kind: "attached",
    expense: (await fetchExpense(tx, tenantId, expenseId))!
  };
}

/** The one fact the receipt-issuance route needs: which media object, if any, the expense's receipt is. */
export async function fetchExpenseReceiptObjectId(
  tx: Bun.SQL,
  tenantId: string,
  expenseId: string
): Promise<{ found: false } | { found: true; mediaObjectId: string | null }> {
  const rows = (await tx`
    SELECT receipt_media_object_id
    FROM awcms_commerce_expenses
    WHERE tenant_id = ${tenantId} AND id = ${expenseId} AND deleted_at IS NULL
  `) as { receipt_media_object_id: string | null }[];
  const row = rows[0];
  return row
    ? { found: true, mediaObjectId: row.receipt_media_object_id }
    : { found: false };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export type ExpenseSummary = {
  from: string;
  to: string;
  /** Σ posted expenses still in effect, exact `numeric(14,2)`. */
  postedTotal: string;
  /** Σ expenses that were posted and then reversed. */
  reversedTotal: string;
  byCategory: {
    categoryId: string;
    categoryCode: string;
    categoryName: string;
    postedTotal: string;
    postedCount: number;
    reversedTotal: string;
    reversedCount: number;
  }[];
  byTender: {
    tenderType: ExpenseTenderType;
    postedTotal: string;
    postedCount: number;
  }[];
  /** How many drafts / pending expenses fall in the range (not in any total). */
  draftCount: number;
  pendingApprovalCount: number;
};

/**
 * The expense summary of a date range (`occurred_on`), aggregated in the
 * database over `(tenant_id, occurred_on)`: only `posted` expenses count as
 * spent, `reversed` ones are reported beside them (never netted away), drafts
 * and pending approvals are counted but belong to no total.
 */
export async function fetchExpenseSummary(
  tx: Bun.SQL,
  tenantId: string,
  range: { from: string; to: string }
): Promise<ExpenseSummary> {
  const totals = (await tx`
    SELECT e.category_id, e.tender_type, e.status,
           sum(e.amount)::text AS amount, count(*)::int AS count
    FROM awcms_commerce_expenses e
    WHERE e.tenant_id = ${tenantId} AND e.deleted_at IS NULL
      AND e.occurred_on >= ${range.from}::date AND e.occurred_on <= ${range.to}::date
      AND e.status IN ('posted', 'reversed')
    GROUP BY e.category_id, e.tender_type, e.status
  `) as {
    category_id: string;
    tender_type: ExpenseTenderType;
    status: "posted" | "reversed";
    amount: string;
    count: number;
  }[];
  const open = (await tx`
    SELECT
      count(*) FILTER (WHERE status = 'draft')::int AS drafts,
      count(*) FILTER (WHERE status = 'pending_approval')::int AS pending
    FROM awcms_commerce_expenses
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
      AND occurred_on >= ${range.from}::date AND occurred_on <= ${range.to}::date
  `) as { drafts: number; pending: number }[];
  const categories = (await tx`
    SELECT id, code, name FROM awcms_commerce_expense_categories
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
  `) as { id: string; code: string; name: string }[];
  const categoryById = new Map(categories.map((c) => [c.id, c]));

  const folded = foldExpenseTotals(
    totals.map((row) => ({
      categoryId: row.category_id,
      tenderType: row.tender_type,
      status: row.status,
      amount: normalizeMoney(row.amount),
      count: row.count
    }))
  );

  const tenderTotals = new Map<
    ExpenseTenderType,
    { cents: bigint; count: number }
  >();
  for (const row of totals) {
    if (row.status !== "posted") continue;
    const entry = tenderTotals.get(row.tender_type) ?? { cents: 0n, count: 0 };
    entry.cents += toCents(normalizeMoney(row.amount));
    entry.count += row.count;
    tenderTotals.set(row.tender_type, entry);
  }

  return {
    from: range.from,
    to: range.to,
    postedTotal: folded.postedTotal,
    reversedTotal: folded.reversedTotal,
    byCategory: folded.byCategory.map((entry) => ({
      ...entry,
      categoryCode: categoryById.get(entry.categoryId)?.code ?? "",
      categoryName: categoryById.get(entry.categoryId)?.name ?? ""
    })),
    byTender: [...tenderTotals.entries()]
      .map(([tenderType, entry]) => ({
        tenderType,
        postedTotal: fromCents(entry.cents),
        postedCount: entry.count
      }))
      .sort((a, b) => a.tenderType.localeCompare(b.tenderType)),
    draftCount: open[0]?.drafts ?? 0,
    pendingApprovalCount: open[0]?.pending ?? 0
  };
}

export type ExpenseExport = { rows: ExpenseCsvRow[]; truncated: boolean };

/** The rows of the CSV export for a date range, oldest first, at most `limit` (+ a truncation flag, never a silent cut). */
export async function listExpensesForExport(
  tx: Bun.SQL,
  tenantId: string,
  range: { from: string; to: string },
  limit: number
): Promise<ExpenseExport> {
  const rows = (await tx`
    SELECT e.id, to_char(e.occurred_on, 'YYYY-MM-DD') AS occurred_on, e.status,
           c.code AS category_code, c.name AS category_name, e.amount, e.tender_type,
           e.register_session_id, e.payee_name, e.description,
           e.created_by_tenant_user_id, e.posted_at, e.decision, e.reversed_at,
           e.reversal_reason, (e.receipt_media_object_id IS NOT NULL) AS has_receipt
    FROM awcms_commerce_expenses e
    JOIN awcms_commerce_expense_categories c
      ON c.tenant_id = e.tenant_id AND c.id = e.category_id
    WHERE e.tenant_id = ${tenantId} AND e.deleted_at IS NULL
      AND e.occurred_on >= ${range.from}::date AND e.occurred_on <= ${range.to}::date
    ORDER BY e.occurred_on ASC, e.created_at ASC, e.id ASC
    LIMIT ${limit + 1}
  `) as {
    id: string;
    occurred_on: string;
    status: ExpenseStatus;
    category_code: string;
    category_name: string;
    amount: string;
    tender_type: string;
    register_session_id: string | null;
    payee_name: string | null;
    description: string;
    created_by_tenant_user_id: string;
    posted_at: Date | null;
    decision: string | null;
    reversed_at: Date | null;
    reversal_reason: string | null;
    has_receipt: boolean;
  }[];
  const truncated = rows.length > limit;
  return {
    truncated,
    rows: rows.slice(0, limit).map((row) => ({
      id: row.id,
      occurredOn: row.occurred_on,
      status: row.status,
      categoryCode: row.category_code,
      categoryName: row.category_name,
      amount: normalizeMoney(String(row.amount)),
      tenderType: row.tender_type,
      registerSessionId: row.register_session_id,
      payeeName: row.payee_name,
      description: row.description,
      createdByTenantUserId: row.created_by_tenant_user_id,
      postedAt: iso(row.posted_at),
      decision: row.decision,
      reversedAt: iso(row.reversed_at),
      reversalReason: row.reversal_reason,
      hasReceipt: row.has_receipt
    }))
  };
}
