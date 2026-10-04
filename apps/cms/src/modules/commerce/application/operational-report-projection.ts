/**
 * POS operational-report projection sinks and hooks - Issue #296 (ADR-0035).
 * The DB half of the six `commerce.pos_*` `cursor_table` projections
 * `commerce/module.ts` contributes to the `reporting` engine: every function
 * here takes the ENGINE's transaction (`tx`) and is called by
 * `reporting/application/projection-incremental-worker.ts`,
 * `projection-rebuild.ts`, `projection-reconciliation.ts` and
 * `export-generation.ts` at the points their scalar path already has (see
 * `ProjectionDimensionalSink`/`ProjectionDimensionalContract` in
 * `_shared/module-contract.ts`). No `getDatabaseClient`, no `withTenant`, no
 * cross-module import: as light as a domain file, so `module.ts` can reference
 * it without dragging a connection pool into every registry gate.
 *
 * ## One loader per source, shared by sink AND reconciliation
 *
 * The engine hands a sink the ids of the rows in a batch (every sink asks for
 * `id` only). A `load*Deltas(tx, tenantId, ids)` function re-reads those rows
 * WITH the joins it needs (a leg's register, a close request's lines and
 * session, an expense's category name, a ledger entry's account kind), with
 * every numeric cast to text and every date formatted in SQL so nothing
 * depends on the driver's decoding, and runs the pure delta functions. The sink
 * upserts the result; the reconciliation control total walks the WHOLE source
 * in pages and sums the result of the SAME loader. That is what makes "rebuild
 * equals live equals reconcile" hold by construction.
 *
 * ## The paging key
 *
 * The control-total walk pages by `(cursor, id)`. The cursor is carried as TEXT
 * (`created_at::text`, microsecond precision) and cast back to `timestamptz` in
 * the next query: round-tripping it through a JS `Date` would truncate to
 * milliseconds and re-read the boundary row on the next page (a double count).
 *
 * ## Known limits, inherited from the engine (see its header)
 *
 * Resume is `cursor >= last + 1ms`, so rows sharing the last row's millisecond
 * that did not fit in the page are skipped; the legs of one multi-tender
 * payment share one `now()`. The projection cannot see them, the reconcile
 * report can, and a rebuild repairs. The batch limit (500) makes the split
 * unlikely, not impossible; ADR-0035 records this.
 */
import {
  CASH_UP_CONTROL_KEYS,
  EXPENSE_CONTROL_KEYS,
  LOYALTY_CONTROL_KEYS,
  RETURNS_CONTROL_KEYS,
  STORED_VALUE_CONTROL_KEYS,
  TENDER_CONTROL_KEYS
} from "../domain/operational-report-keys";
import {
  cashUpVarianceCents,
  computeCashUpCorrectionDelta,
  computeCashUpLineDelta,
  computeExpensePostedDelta,
  computeExpenseReversedDelta,
  computeLoyaltyDailyDelta,
  computeRefundLegDelta,
  computeReturnDelta,
  computeReturnLineDelta,
  computeStoredValueDailyDelta,
  computeTenderDailyDelta,
  formatSignedCents,
  type CashUpDelta,
  type CashUpSessionFact,
  type ExpenseDailyDelta,
  type LoyaltyDailyDelta,
  type ReturnsDailyDelta,
  type StoredValueDailyDelta,
  type TenderDailyDelta
} from "../domain/operational-report-deltas";
import { signedToCents } from "../domain/register";
import type {
  ProjectionDimensionalContract,
  ProjectionDimensionalSink,
  ProjectionDimensionalTotals
} from "../../_shared/module-contract";

/** The only column every sink asks the engine to SELECT beyond the cursor: the row id. */
const SINK_SELECT_COLUMNS = ["id"] as const;

/** Bounded page size of the reconciliation's full source walk - a control READ, so it may take several pages, but each page is a bounded statement. */
const CONTROL_TOTAL_PAGE_SIZE = 2000;

type IdRow = { id: string };

function idsOf(rows: readonly Record<string, unknown>[]): string[] {
  return [...new Set(rows.map((row) => String((row as IdRow).id)))];
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toNullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

/** Folds deltas that share a primary key into one, so a batch issues one upsert per key. */
function mergeBy<T>(
  deltas: readonly T[],
  keyOf: (delta: T) => string,
  merge: (into: T, from: T) => void
): T[] {
  const merged = new Map<string, T>();
  for (const delta of deltas) {
    const key = keyOf(delta);
    const existing = merged.get(key);
    if (existing) merge(existing, delta);
    else merged.set(key, { ...delta });
  }
  return [...merged.values()];
}

type SourceWalk = {
  table: string;
  cursorColumn: string;
};

/**
 * Walks every row of `source` (cursor not NULL) for the tenant in
 * `(cursor, id)` order and hands each page's ids to `onPage`. Identifiers are
 * module constants, never request input.
 */
async function walkSource(
  tx: Bun.SQL,
  tenantId: string,
  source: SourceWalk,
  onPage: (ids: string[]) => Promise<void>
): Promise<void> {
  let afterCursor: string | null = null;
  let afterId: string | null = null;
  for (;;) {
    const page = (await tx.unsafe(
      `SELECT id, ${source.cursorColumn}::text AS cursor_text
       FROM ${source.table}
       WHERE tenant_id = $1 AND ${source.cursorColumn} IS NOT NULL
         AND ($2::timestamptz IS NULL
           OR (${source.cursorColumn}, id) > ($2::timestamptz, $3::uuid))
       ORDER BY ${source.cursorColumn} ASC, id ASC
       LIMIT $4`,
      [tenantId, afterCursor, afterId, CONTROL_TOTAL_PAGE_SIZE]
    )) as { id: string; cursor_text: string }[];
    if (page.length === 0) return;
    await onPage(page.map((row) => row.id));
    const last = page[page.length - 1]!;
    afterCursor = last.cursor_text;
    afterId = last.id;
    if (page.length < CONTROL_TOTAL_PAGE_SIZE) return;
  }
}

function sumToNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Number(signedToCents(String(value)));
}

// ---------------------------------------------------------------------------
// tenders - commerce.pos_tender_daily
// ---------------------------------------------------------------------------

type TenderRow = {
  kind: string;
  tender_type: string;
  amount: string;
  status: string;
  settled_at: Date | string | null;
  register_id: string | null;
};

export async function loadTenderDeltas(
  tx: Bun.SQL,
  tenantId: string,
  ids: readonly string[]
): Promise<TenderDailyDelta[]> {
  if (ids.length === 0) return [];
  const rows = (await tx`
    SELECT a.kind, a.tender_type, a.amount::text AS amount, a.status,
      a.settled_at, s.register_id
    FROM awcms_commerce_payment_allocations a
    LEFT JOIN awcms_commerce_register_sessions s
      ON s.tenant_id = a.tenant_id AND s.id = a.register_session_id
    WHERE a.tenant_id = ${tenantId}
      AND a.id = ANY(${tx.array([...ids], "uuid")}::uuid[])
  `) as TenderRow[];
  const deltas: TenderDailyDelta[] = [];
  for (const row of rows) {
    const delta = computeTenderDailyDelta({
      kind: row.kind,
      tenderType: row.tender_type,
      amount: row.amount,
      status: row.status,
      settledAt: toNullableDate(row.settled_at),
      registerId: row.register_id
    });
    if (delta) deltas.push(delta);
  }
  return mergeBy(
    deltas,
    (d) => `${d.day}|${d.registerId}|${d.tenderType}`,
    (into, from) => {
      into.paymentCount += from.paymentCount;
      into.paymentCents += from.paymentCents;
      into.reversalCount += from.reversalCount;
      into.reversalCents += from.reversalCents;
    }
  );
}

export async function applyTenderBatch(
  tx: Bun.SQL,
  tenantId: string,
  rows: readonly Record<string, unknown>[]
): Promise<void> {
  for (const delta of await loadTenderDeltas(tx, tenantId, idsOf(rows))) {
    await tx`
      INSERT INTO awcms_commerce_report_tender_daily
        (tenant_id, day, register_id, tender_type, payment_count, payments,
         reversal_count, reversals)
      VALUES (
        ${tenantId}, ${delta.day}::date, ${delta.registerId}, ${delta.tenderType},
        ${delta.paymentCount}, ${formatSignedCents(delta.paymentCents)}::numeric,
        ${delta.reversalCount}, ${formatSignedCents(delta.reversalCents)}::numeric
      )
      ON CONFLICT (tenant_id, day, register_id, tender_type) DO UPDATE SET
        payment_count = awcms_commerce_report_tender_daily.payment_count + EXCLUDED.payment_count,
        payments = awcms_commerce_report_tender_daily.payments + EXCLUDED.payments,
        reversal_count = awcms_commerce_report_tender_daily.reversal_count + EXCLUDED.reversal_count,
        reversals = awcms_commerce_report_tender_daily.reversals + EXCLUDED.reversals,
        updated_at = now()
    `;
  }
}

export const TENDER_SINK: ProjectionDimensionalSink = {
  selectColumns: SINK_SELECT_COLUMNS,
  applyBatch: applyTenderBatch
};

const TENDER_SOURCE: SourceWalk = {
  table: "awcms_commerce_report_src_allocations",
  cursorColumn: "settled_at"
};

export const TENDER_DIMENSIONAL: ProjectionDimensionalContract = {
  resetForTenant: async (tx, tenantId) => {
    await tx`DELETE FROM awcms_commerce_report_tender_daily WHERE tenant_id = ${tenantId}`;
  },
  readProjectionTotals: async (tx, tenantId) => {
    const [row] = (await tx`
      SELECT COALESCE(SUM(payment_count), 0)::text AS payment_count,
        COALESCE(SUM(payments), 0)::text AS payments,
        COALESCE(SUM(reversal_count), 0)::text AS reversal_count,
        COALESCE(SUM(reversals), 0)::text AS reversals
      FROM awcms_commerce_report_tender_daily
      WHERE tenant_id = ${tenantId}
    `) as Record<string, unknown>[];
    return {
      [TENDER_CONTROL_KEYS.paymentCount]: Number(row?.payment_count ?? 0),
      [TENDER_CONTROL_KEYS.paymentCents]: sumToNumber(row?.payments),
      [TENDER_CONTROL_KEYS.reversalCount]: Number(row?.reversal_count ?? 0),
      [TENDER_CONTROL_KEYS.reversalCents]: sumToNumber(row?.reversals)
    };
  },
  computeSourceTotals: async (tx, tenantId) => {
    let paymentCount = 0;
    let paymentCents = 0n;
    let reversalCount = 0;
    let reversalCents = 0n;
    await walkSource(tx, tenantId, TENDER_SOURCE, async (ids) => {
      for (const delta of await loadTenderDeltas(tx, tenantId, ids)) {
        paymentCount += delta.paymentCount;
        paymentCents += delta.paymentCents;
        reversalCount += delta.reversalCount;
        reversalCents += delta.reversalCents;
      }
    });
    return {
      [TENDER_CONTROL_KEYS.paymentCount]: paymentCount,
      [TENDER_CONTROL_KEYS.paymentCents]: Number(paymentCents),
      [TENDER_CONTROL_KEYS.reversalCount]: reversalCount,
      [TENDER_CONTROL_KEYS.reversalCents]: Number(reversalCents)
    };
  },
  exportRows: async (tx, tenantId) => {
    const rows = (await tx`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, register_id, tender_type,
        payment_count, payments::text AS payments, reversal_count,
        reversals::text AS reversals, (payments - reversals)::text AS net
      FROM awcms_commerce_report_tender_daily
      WHERE tenant_id = ${tenantId}
      ORDER BY day ASC, register_id ASC, tender_type ASC
    `) as Record<string, unknown>[];
    return {
      columns: [
        "day",
        "register_id",
        "tender_type",
        "payment_count",
        "payments",
        "reversal_count",
        "reversals",
        "net"
      ],
      rows
    };
  }
};

// ---------------------------------------------------------------------------
// cash-ups - commerce.pos_cash_up_variance (two streams)
// ---------------------------------------------------------------------------

type SessionColumns = {
  session_id: string;
  register_id: string;
  cashier: string;
  closed_at: Date | string | null;
};

function toSessionFact(row: SessionColumns): CashUpSessionFact {
  return {
    sessionId: row.session_id,
    registerId: row.register_id,
    cashierTenantUserId: row.cashier,
    closedAt: toNullableDate(row.closed_at)
  };
}

function mergeCashUp(deltas: CashUpDelta[]): CashUpDelta[] {
  return mergeBy(
    deltas,
    (d) => `${d.sessionId}|${d.tenderType}`,
    (into, from) => {
      into.lines += from.lines;
      into.expectedCents += from.expectedCents;
      into.countedCents += from.countedCents;
      into.adjustmentCents += from.adjustmentCents;
    }
  );
}

/** Close-request stream: the lines of every `auto`/`approved` request in `ids`. */
export async function loadCashUpCloseDeltas(
  tx: Bun.SQL,
  tenantId: string,
  ids: readonly string[]
): Promise<CashUpDelta[]> {
  if (ids.length === 0) return [];
  const requests = (await tx`
    SELECT r.id, r.session_id, r.decided_at,
      s.register_id, s.current_cashier_tenant_user_id AS cashier, s.closed_at
    FROM awcms_commerce_register_close_requests r
    JOIN awcms_commerce_register_sessions s
      ON s.tenant_id = r.tenant_id AND s.id = r.session_id
    WHERE r.tenant_id = ${tenantId}
      AND r.id = ANY(${tx.array([...ids], "uuid")}::uuid[])
      AND r.decision IN ('auto', 'approved')
      AND r.decided_at IS NOT NULL
  `) as (SessionColumns & { id: string; decided_at: Date | string })[];
  if (requests.length === 0) return [];
  const lines = (await tx`
    SELECT close_request_id, tender_type, expected::text AS expected,
      counted::text AS counted
    FROM awcms_commerce_register_close_lines
    WHERE tenant_id = ${tenantId}
      AND close_request_id = ANY(${tx.array(
        requests.map((request) => request.id),
        "uuid"
      )}::uuid[])
  `) as {
    close_request_id: string;
    tender_type: string;
    expected: string;
    counted: string;
  }[];
  const deltas: CashUpDelta[] = [];
  for (const request of requests) {
    const session = toSessionFact(request);
    const decidedAt = toDate(request.decided_at);
    for (const line of lines) {
      if (line.close_request_id !== request.id) continue;
      deltas.push(
        computeCashUpLineDelta(session, decidedAt, {
          tenderType: line.tender_type,
          expected: line.expected,
          counted: line.counted
        })
      );
    }
  }
  return mergeCashUp(deltas);
}

/** Corrections stream: one signed adjustment per (session, tender). */
export async function loadCashUpCorrectionDeltas(
  tx: Bun.SQL,
  tenantId: string,
  ids: readonly string[]
): Promise<CashUpDelta[]> {
  if (ids.length === 0) return [];
  const rows = (await tx`
    SELECT c.session_id, c.tender_type, c.adjustment::text AS adjustment,
      c.created_at, s.register_id,
      s.current_cashier_tenant_user_id AS cashier, s.closed_at
    FROM awcms_commerce_register_corrections c
    JOIN awcms_commerce_register_sessions s
      ON s.tenant_id = c.tenant_id AND s.id = c.session_id
    WHERE c.tenant_id = ${tenantId}
      AND c.id = ANY(${tx.array([...ids], "uuid")}::uuid[])
  `) as (SessionColumns & {
    tender_type: string;
    adjustment: string;
    created_at: Date | string;
  })[];
  return mergeCashUp(
    rows.map((row) =>
      computeCashUpCorrectionDelta(toSessionFact(row), toDate(row.created_at), {
        tenderType: row.tender_type,
        adjustment: row.adjustment
      })
    )
  );
}

export async function applyCashUpDeltas(
  tx: Bun.SQL,
  tenantId: string,
  deltas: readonly CashUpDelta[]
): Promise<void> {
  for (const delta of deltas) {
    await tx`
      INSERT INTO awcms_commerce_report_cash_up_tenders
        (tenant_id, session_id, tender_type, register_id, cashier_tenant_user_id,
         day, line_count, expected, counted, adjustment)
      VALUES (
        ${tenantId}, ${delta.sessionId}, ${delta.tenderType}, ${delta.registerId},
        ${delta.cashierTenantUserId}, ${delta.day}::date, ${delta.lines},
        ${formatSignedCents(delta.expectedCents)}::numeric,
        ${formatSignedCents(delta.countedCents)}::numeric,
        ${formatSignedCents(delta.adjustmentCents)}::numeric
      )
      ON CONFLICT (tenant_id, session_id, tender_type) DO UPDATE SET
        line_count = awcms_commerce_report_cash_up_tenders.line_count + EXCLUDED.line_count,
        expected = awcms_commerce_report_cash_up_tenders.expected + EXCLUDED.expected,
        counted = awcms_commerce_report_cash_up_tenders.counted + EXCLUDED.counted,
        adjustment = awcms_commerce_report_cash_up_tenders.adjustment + EXCLUDED.adjustment,
        updated_at = now()
    `;
  }
}

export const CASH_UP_CLOSE_SINK: ProjectionDimensionalSink = {
  selectColumns: SINK_SELECT_COLUMNS,
  applyBatch: async (tx, tenantId, rows) =>
    applyCashUpDeltas(
      tx,
      tenantId,
      await loadCashUpCloseDeltas(tx, tenantId, idsOf(rows))
    )
};

export const CASH_UP_CORRECTION_SINK: ProjectionDimensionalSink = {
  selectColumns: SINK_SELECT_COLUMNS,
  applyBatch: async (tx, tenantId, rows) =>
    applyCashUpDeltas(
      tx,
      tenantId,
      await loadCashUpCorrectionDeltas(tx, tenantId, idsOf(rows))
    )
};

const CASH_UP_CLOSE_SOURCE: SourceWalk = {
  table: "awcms_commerce_report_src_close_decisions",
  cursorColumn: "decided_at"
};

const CASH_UP_CORRECTION_SOURCE: SourceWalk = {
  table: "awcms_commerce_register_corrections",
  cursorColumn: "created_at"
};

export const CASH_UP_DIMENSIONAL: ProjectionDimensionalContract = {
  resetForTenant: async (tx, tenantId) => {
    await tx`DELETE FROM awcms_commerce_report_cash_up_tenders WHERE tenant_id = ${tenantId}`;
  },
  readProjectionTotals: async (tx, tenantId) => {
    const [row] = (await tx`
      SELECT COALESCE(SUM(line_count), 0)::text AS line_count,
        COALESCE(SUM(expected), 0)::text AS expected,
        COALESCE(SUM(counted), 0)::text AS counted,
        COALESCE(SUM(adjustment), 0)::text AS adjustment
      FROM awcms_commerce_report_cash_up_tenders
      WHERE tenant_id = ${tenantId}
    `) as Record<string, unknown>[];
    return {
      [CASH_UP_CONTROL_KEYS.lines]: Number(row?.line_count ?? 0),
      [CASH_UP_CONTROL_KEYS.expectedCents]: sumToNumber(row?.expected),
      [CASH_UP_CONTROL_KEYS.countedCents]: sumToNumber(row?.counted),
      [CASH_UP_CONTROL_KEYS.adjustmentCents]: sumToNumber(row?.adjustment)
    };
  },
  computeSourceTotals: async (tx, tenantId) => {
    let lines = 0;
    let expected = 0n;
    let counted = 0n;
    let adjustment = 0n;
    const fold = (deltas: readonly CashUpDelta[]) => {
      for (const delta of deltas) {
        lines += delta.lines;
        expected += delta.expectedCents;
        counted += delta.countedCents;
        adjustment += delta.adjustmentCents;
      }
    };
    await walkSource(tx, tenantId, CASH_UP_CLOSE_SOURCE, async (ids) =>
      fold(await loadCashUpCloseDeltas(tx, tenantId, ids))
    );
    await walkSource(tx, tenantId, CASH_UP_CORRECTION_SOURCE, async (ids) =>
      fold(await loadCashUpCorrectionDeltas(tx, tenantId, ids))
    );
    return {
      [CASH_UP_CONTROL_KEYS.lines]: lines,
      [CASH_UP_CONTROL_KEYS.expectedCents]: Number(expected),
      [CASH_UP_CONTROL_KEYS.countedCents]: Number(counted),
      [CASH_UP_CONTROL_KEYS.adjustmentCents]: Number(adjustment)
    };
  },
  exportRows: async (tx, tenantId) => {
    const rows = (await tx`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, session_id, register_id,
        cashier_tenant_user_id, tender_type, expected::text AS expected,
        counted::text AS counted, adjustment::text AS adjustment
      FROM awcms_commerce_report_cash_up_tenders
      WHERE tenant_id = ${tenantId}
      ORDER BY day ASC, session_id ASC, tender_type ASC
    `) as { expected: string; counted: string; adjustment: string }[];
    return {
      columns: [
        "day",
        "session_id",
        "register_id",
        "cashier_tenant_user_id",
        "tender_type",
        "expected",
        "counted",
        "adjustment",
        "variance"
      ],
      rows: rows.map((row) => ({
        ...row,
        variance: formatSignedCents(
          cashUpVarianceCents({
            expectedCents: signedToCents(row.expected),
            countedCents: signedToCents(row.counted),
            adjustmentCents: signedToCents(row.adjustment)
          })
        )
      }))
    };
  }
};

// ---------------------------------------------------------------------------
// expenses - commerce.pos_expense_daily (two streams)
// ---------------------------------------------------------------------------

type ExpenseRow = {
  occurred_on: string;
  category_id: string;
  category_name: string;
  tender_type: string;
  amount: string;
};

async function loadExpenseRows(
  tx: Bun.SQL,
  tenantId: string,
  ids: readonly string[],
  stampColumn: "posted_at" | "reversed_at"
): Promise<ExpenseRow[]> {
  if (ids.length === 0) return [];
  // The two stamp columns are module constants; the template literal only
  // selects between two fixed predicates, never interpolates input.
  const rows =
    stampColumn === "posted_at"
      ? await tx`
          SELECT to_char(e.occurred_on, 'YYYY-MM-DD') AS occurred_on,
            e.category_id, c.name AS category_name, e.tender_type,
            e.amount::text AS amount
          FROM awcms_commerce_expenses e
          JOIN awcms_commerce_expense_categories c
            ON c.tenant_id = e.tenant_id AND c.id = e.category_id
          WHERE e.tenant_id = ${tenantId}
            AND e.id = ANY(${tx.array([...ids], "uuid")}::uuid[])
            AND e.posted_at IS NOT NULL
        `
      : await tx`
          SELECT to_char(e.occurred_on, 'YYYY-MM-DD') AS occurred_on,
            e.category_id, c.name AS category_name, e.tender_type,
            e.amount::text AS amount
          FROM awcms_commerce_expenses e
          JOIN awcms_commerce_expense_categories c
            ON c.tenant_id = e.tenant_id AND c.id = e.category_id
          WHERE e.tenant_id = ${tenantId}
            AND e.id = ANY(${tx.array([...ids], "uuid")}::uuid[])
            AND e.reversed_at IS NOT NULL
        `;
  return rows as ExpenseRow[];
}

function mergeExpenses(deltas: ExpenseDailyDelta[]): ExpenseDailyDelta[] {
  return mergeBy(
    deltas,
    (d) => `${d.day}|${d.categoryId}|${d.tenderType}`,
    (into, from) => {
      into.postedCount += from.postedCount;
      into.postedCents += from.postedCents;
      into.reversedCount += from.reversedCount;
      into.reversedCents += from.reversedCents;
    }
  );
}

function toExpenseFact(row: ExpenseRow) {
  return {
    occurredOn: row.occurred_on,
    categoryId: row.category_id,
    categoryName: row.category_name,
    tenderType: row.tender_type,
    amount: row.amount
  };
}

export async function loadExpensePostedDeltas(
  tx: Bun.SQL,
  tenantId: string,
  ids: readonly string[]
): Promise<ExpenseDailyDelta[]> {
  const rows = await loadExpenseRows(tx, tenantId, ids, "posted_at");
  return mergeExpenses(
    rows.map((row) => computeExpensePostedDelta(toExpenseFact(row)))
  );
}

export async function loadExpenseReversedDeltas(
  tx: Bun.SQL,
  tenantId: string,
  ids: readonly string[]
): Promise<ExpenseDailyDelta[]> {
  const rows = await loadExpenseRows(tx, tenantId, ids, "reversed_at");
  return mergeExpenses(
    rows.map((row) => computeExpenseReversedDelta(toExpenseFact(row)))
  );
}

export async function applyExpenseDeltas(
  tx: Bun.SQL,
  tenantId: string,
  deltas: readonly ExpenseDailyDelta[]
): Promise<void> {
  for (const delta of deltas) {
    await tx`
      INSERT INTO awcms_commerce_report_expense_daily
        (tenant_id, day, category_id, tender_type, category_name,
         posted_count, posted, reversed_count, reversed)
      VALUES (
        ${tenantId}, ${delta.day}::date, ${delta.categoryId}, ${delta.tenderType},
        ${delta.categoryName}, ${delta.postedCount},
        ${formatSignedCents(delta.postedCents)}::numeric, ${delta.reversedCount},
        ${formatSignedCents(delta.reversedCents)}::numeric
      )
      ON CONFLICT (tenant_id, day, category_id, tender_type) DO UPDATE SET
        posted_count = awcms_commerce_report_expense_daily.posted_count + EXCLUDED.posted_count,
        posted = awcms_commerce_report_expense_daily.posted + EXCLUDED.posted,
        reversed_count = awcms_commerce_report_expense_daily.reversed_count + EXCLUDED.reversed_count,
        reversed = awcms_commerce_report_expense_daily.reversed + EXCLUDED.reversed,
        category_name = EXCLUDED.category_name,
        updated_at = now()
    `;
  }
}

export const EXPENSE_POSTED_SINK: ProjectionDimensionalSink = {
  selectColumns: SINK_SELECT_COLUMNS,
  applyBatch: async (tx, tenantId, rows) =>
    applyExpenseDeltas(
      tx,
      tenantId,
      await loadExpensePostedDeltas(tx, tenantId, idsOf(rows))
    )
};

export const EXPENSE_REVERSED_SINK: ProjectionDimensionalSink = {
  selectColumns: SINK_SELECT_COLUMNS,
  applyBatch: async (tx, tenantId, rows) =>
    applyExpenseDeltas(
      tx,
      tenantId,
      await loadExpenseReversedDeltas(tx, tenantId, idsOf(rows))
    )
};

const EXPENSE_POSTED_SOURCE: SourceWalk = {
  table: "awcms_commerce_report_src_expenses_posted",
  cursorColumn: "posted_at"
};

const EXPENSE_REVERSED_SOURCE: SourceWalk = {
  table: "awcms_commerce_report_src_expenses_reversed",
  cursorColumn: "reversed_at"
};

export const EXPENSE_DIMENSIONAL: ProjectionDimensionalContract = {
  resetForTenant: async (tx, tenantId) => {
    await tx`DELETE FROM awcms_commerce_report_expense_daily WHERE tenant_id = ${tenantId}`;
  },
  readProjectionTotals: async (tx, tenantId) => {
    const [row] = (await tx`
      SELECT COALESCE(SUM(posted_count), 0)::text AS posted_count,
        COALESCE(SUM(posted), 0)::text AS posted,
        COALESCE(SUM(reversed_count), 0)::text AS reversed_count,
        COALESCE(SUM(reversed), 0)::text AS reversed
      FROM awcms_commerce_report_expense_daily
      WHERE tenant_id = ${tenantId}
    `) as Record<string, unknown>[];
    return {
      [EXPENSE_CONTROL_KEYS.postedCount]: Number(row?.posted_count ?? 0),
      [EXPENSE_CONTROL_KEYS.postedCents]: sumToNumber(row?.posted),
      [EXPENSE_CONTROL_KEYS.reversedCount]: Number(row?.reversed_count ?? 0),
      [EXPENSE_CONTROL_KEYS.reversedCents]: sumToNumber(row?.reversed)
    };
  },
  computeSourceTotals: async (tx, tenantId) => {
    let postedCount = 0;
    let postedCents = 0n;
    let reversedCount = 0;
    let reversedCents = 0n;
    const fold = (deltas: readonly ExpenseDailyDelta[]) => {
      for (const delta of deltas) {
        postedCount += delta.postedCount;
        postedCents += delta.postedCents;
        reversedCount += delta.reversedCount;
        reversedCents += delta.reversedCents;
      }
    };
    await walkSource(tx, tenantId, EXPENSE_POSTED_SOURCE, async (ids) =>
      fold(await loadExpensePostedDeltas(tx, tenantId, ids))
    );
    await walkSource(tx, tenantId, EXPENSE_REVERSED_SOURCE, async (ids) =>
      fold(await loadExpenseReversedDeltas(tx, tenantId, ids))
    );
    return {
      [EXPENSE_CONTROL_KEYS.postedCount]: postedCount,
      [EXPENSE_CONTROL_KEYS.postedCents]: Number(postedCents),
      [EXPENSE_CONTROL_KEYS.reversedCount]: reversedCount,
      [EXPENSE_CONTROL_KEYS.reversedCents]: Number(reversedCents)
    };
  },
  exportRows: async (tx, tenantId) => {
    const rows = (await tx`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, category_id, category_name,
        tender_type, posted_count, posted::text AS posted, reversed_count,
        reversed::text AS reversed, (posted - reversed)::text AS net
      FROM awcms_commerce_report_expense_daily
      WHERE tenant_id = ${tenantId}
      ORDER BY day ASC, category_name ASC, category_id ASC, tender_type ASC
    `) as Record<string, unknown>[];
    return {
      columns: [
        "day",
        "category_id",
        "category_name",
        "tender_type",
        "posted_count",
        "posted",
        "reversed_count",
        "reversed",
        "net"
      ],
      rows
    };
  }
};

// ---------------------------------------------------------------------------
// loyalty - commerce.pos_loyalty_daily
// ---------------------------------------------------------------------------

export async function loadLoyaltyDeltas(
  tx: Bun.SQL,
  tenantId: string,
  ids: readonly string[]
): Promise<LoyaltyDailyDelta[]> {
  if (ids.length === 0) return [];
  const rows = (await tx`
    SELECT kind, points::text AS points, created_at
    FROM awcms_commerce_loyalty_ledger
    WHERE tenant_id = ${tenantId}
      AND id = ANY(${tx.array([...ids], "uuid")}::uuid[])
  `) as { kind: string; points: string; created_at: Date | string }[];
  const deltas: LoyaltyDailyDelta[] = [];
  for (const row of rows) {
    const delta = computeLoyaltyDailyDelta({
      kind: row.kind,
      points: BigInt(row.points),
      createdAt: toDate(row.created_at)
    });
    if (delta) deltas.push(delta);
  }
  return mergeBy(
    deltas,
    (d) => `${d.day}|${d.bucket}`,
    (into, from) => {
      into.entries += from.entries;
      into.points += from.points;
    }
  );
}

export async function applyLoyaltyBatch(
  tx: Bun.SQL,
  tenantId: string,
  rows: readonly Record<string, unknown>[]
): Promise<void> {
  for (const delta of await loadLoyaltyDeltas(tx, tenantId, idsOf(rows))) {
    await tx`
      INSERT INTO awcms_commerce_report_loyalty_daily
        (tenant_id, day, bucket, entries, points)
      VALUES (
        ${tenantId}, ${delta.day}::date, ${delta.bucket}, ${delta.entries},
        ${delta.points.toString()}::bigint
      )
      ON CONFLICT (tenant_id, day, bucket) DO UPDATE SET
        entries = awcms_commerce_report_loyalty_daily.entries + EXCLUDED.entries,
        points = awcms_commerce_report_loyalty_daily.points + EXCLUDED.points,
        updated_at = now()
    `;
  }
}

export const LOYALTY_SINK: ProjectionDimensionalSink = {
  selectColumns: SINK_SELECT_COLUMNS,
  applyBatch: applyLoyaltyBatch
};

const LOYALTY_SOURCE: SourceWalk = {
  table: "awcms_commerce_loyalty_ledger",
  cursorColumn: "created_at"
};

export const LOYALTY_DIMENSIONAL: ProjectionDimensionalContract = {
  resetForTenant: async (tx, tenantId) => {
    await tx`DELETE FROM awcms_commerce_report_loyalty_daily WHERE tenant_id = ${tenantId}`;
  },
  readProjectionTotals: async (tx, tenantId) => {
    const [row] = (await tx`
      SELECT COALESCE(SUM(entries), 0)::text AS entries,
        COALESCE(SUM(points), 0)::text AS points
      FROM awcms_commerce_report_loyalty_daily
      WHERE tenant_id = ${tenantId}
    `) as Record<string, unknown>[];
    return {
      [LOYALTY_CONTROL_KEYS.entries]: Number(row?.entries ?? 0),
      [LOYALTY_CONTROL_KEYS.pointsNet]: Number(row?.points ?? 0)
    };
  },
  computeSourceTotals: async (tx, tenantId) => {
    let entries = 0;
    let points = 0n;
    await walkSource(tx, tenantId, LOYALTY_SOURCE, async (ids) => {
      for (const delta of await loadLoyaltyDeltas(tx, tenantId, ids)) {
        entries += delta.entries;
        points += delta.points;
      }
    });
    return {
      [LOYALTY_CONTROL_KEYS.entries]: entries,
      [LOYALTY_CONTROL_KEYS.pointsNet]: Number(points)
    };
  },
  exportRows: async (tx, tenantId) => {
    const rows = (await tx`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, bucket, entries,
        points::text AS points
      FROM awcms_commerce_report_loyalty_daily
      WHERE tenant_id = ${tenantId}
      ORDER BY day ASC, bucket ASC
    `) as Record<string, unknown>[];
    return { columns: ["day", "bucket", "entries", "points"], rows };
  }
};

// ---------------------------------------------------------------------------
// stored value - commerce.pos_stored_value_daily
// ---------------------------------------------------------------------------

export async function loadStoredValueDeltas(
  tx: Bun.SQL,
  tenantId: string,
  ids: readonly string[]
): Promise<StoredValueDailyDelta[]> {
  if (ids.length === 0) return [];
  const rows = (await tx`
    SELECT l.kind, l.amount::text AS amount, a.kind AS account_kind, l.created_at
    FROM awcms_commerce_stored_value_ledger l
    JOIN awcms_commerce_stored_value_accounts a
      ON a.tenant_id = l.tenant_id AND a.id = l.account_id
    WHERE l.tenant_id = ${tenantId}
      AND l.id = ANY(${tx.array([...ids], "uuid")}::uuid[])
  `) as {
    kind: string;
    amount: string;
    account_kind: string;
    created_at: Date | string;
  }[];
  const deltas: StoredValueDailyDelta[] = [];
  for (const row of rows) {
    const delta = computeStoredValueDailyDelta({
      kind: row.kind,
      amount: row.amount,
      accountKind: row.account_kind,
      createdAt: toDate(row.created_at)
    });
    if (delta) deltas.push(delta);
  }
  return mergeBy(
    deltas,
    (d) => `${d.day}|${d.accountKind}|${d.bucket}`,
    (into, from) => {
      into.entries += from.entries;
      into.cents += from.cents;
    }
  );
}

export async function applyStoredValueBatch(
  tx: Bun.SQL,
  tenantId: string,
  rows: readonly Record<string, unknown>[]
): Promise<void> {
  for (const delta of await loadStoredValueDeltas(tx, tenantId, idsOf(rows))) {
    await tx`
      INSERT INTO awcms_commerce_report_stored_value_daily
        (tenant_id, day, account_kind, bucket, entries, amount)
      VALUES (
        ${tenantId}, ${delta.day}::date, ${delta.accountKind}, ${delta.bucket},
        ${delta.entries}, ${formatSignedCents(delta.cents)}::numeric
      )
      ON CONFLICT (tenant_id, day, account_kind, bucket) DO UPDATE SET
        entries = awcms_commerce_report_stored_value_daily.entries + EXCLUDED.entries,
        amount = awcms_commerce_report_stored_value_daily.amount + EXCLUDED.amount,
        updated_at = now()
    `;
  }
}

export const STORED_VALUE_SINK: ProjectionDimensionalSink = {
  selectColumns: SINK_SELECT_COLUMNS,
  applyBatch: applyStoredValueBatch
};

const STORED_VALUE_SOURCE: SourceWalk = {
  table: "awcms_commerce_stored_value_ledger",
  cursorColumn: "created_at"
};

export const STORED_VALUE_DIMENSIONAL: ProjectionDimensionalContract = {
  resetForTenant: async (tx, tenantId) => {
    await tx`DELETE FROM awcms_commerce_report_stored_value_daily WHERE tenant_id = ${tenantId}`;
  },
  readProjectionTotals: async (tx, tenantId) => {
    const [row] = (await tx`
      SELECT COALESCE(SUM(entries), 0)::text AS entries,
        COALESCE(SUM(amount), 0)::text AS amount
      FROM awcms_commerce_report_stored_value_daily
      WHERE tenant_id = ${tenantId}
    `) as Record<string, unknown>[];
    return {
      [STORED_VALUE_CONTROL_KEYS.entries]: Number(row?.entries ?? 0),
      [STORED_VALUE_CONTROL_KEYS.netCents]: sumToNumber(row?.amount)
    };
  },
  computeSourceTotals: async (
    tx,
    tenantId
  ): Promise<ProjectionDimensionalTotals> => {
    let entries = 0;
    let cents = 0n;
    await walkSource(tx, tenantId, STORED_VALUE_SOURCE, async (ids) => {
      for (const delta of await loadStoredValueDeltas(tx, tenantId, ids)) {
        entries += delta.entries;
        cents += delta.cents;
      }
    });
    return {
      [STORED_VALUE_CONTROL_KEYS.entries]: entries,
      [STORED_VALUE_CONTROL_KEYS.netCents]: Number(cents)
    };
  },
  exportRows: async (tx, tenantId) => {
    const rows = (await tx`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, account_kind, bucket, entries,
        amount::text AS amount
      FROM awcms_commerce_report_stored_value_daily
      WHERE tenant_id = ${tenantId}
      ORDER BY day ASC, account_kind ASC, bucket ASC
    `) as Record<string, unknown>[];
    return {
      columns: ["day", "account_kind", "bucket", "entries", "amount"],
      rows
    };
  }
};

// ---------------------------------------------------------------------------
// returns & refunds - commerce.pos_returns_daily (three streams, Issue #316)
// ---------------------------------------------------------------------------

function mergeReturns(deltas: ReturnsDailyDelta[]): ReturnsDailyDelta[] {
  return mergeBy(
    deltas,
    (d) => `${d.day}|${d.registerId}|${d.section}|${d.bucket}|${d.detail}`,
    (into, from) => {
      into.count += from.count;
      into.units += from.units;
      into.cents += from.cents;
    }
  );
}

/** Returns stream: one `return`/`exchange` row per return, on the register of the original sale. */
export async function loadReturnDeltas(
  tx: Bun.SQL,
  tenantId: string,
  ids: readonly string[]
): Promise<ReturnsDailyDelta[]> {
  if (ids.length === 0) return [];
  const rows = (await tx`
    SELECT r.kind, r.refund_total::text AS refund_total, r.created_at,
      s.register_id
    FROM awcms_commerce_returns r
    JOIN awcms_commerce_orders o
      ON o.tenant_id = r.tenant_id AND o.id = r.order_id
    LEFT JOIN awcms_commerce_register_sessions s
      ON s.tenant_id = o.tenant_id AND s.id = o.register_session_id
    WHERE r.tenant_id = ${tenantId}
      AND r.id = ANY(${tx.array([...ids], "uuid")}::uuid[])
  `) as {
    kind: string;
    refund_total: string;
    created_at: Date | string;
    register_id: string | null;
  }[];
  const deltas: ReturnsDailyDelta[] = [];
  for (const row of rows) {
    const delta = computeReturnDelta({
      kind: row.kind,
      refundTotal: row.refund_total,
      createdAt: toDate(row.created_at),
      registerId: row.register_id
    });
    if (delta) deltas.push(delta);
  }
  return mergeReturns(deltas);
}

/** Return-lines stream: one `disposition` row per returned line. */
export async function loadReturnLineDeltas(
  tx: Bun.SQL,
  tenantId: string,
  ids: readonly string[]
): Promise<ReturnsDailyDelta[]> {
  if (ids.length === 0) return [];
  const rows = (await tx`
    SELECT l.disposition, l.quantity, l.refund_amount::text AS refund_amount,
      l.created_at, s.register_id
    FROM awcms_commerce_return_lines l
    JOIN awcms_commerce_orders o
      ON o.tenant_id = l.tenant_id AND o.id = l.order_id
    LEFT JOIN awcms_commerce_register_sessions s
      ON s.tenant_id = o.tenant_id AND s.id = o.register_session_id
    WHERE l.tenant_id = ${tenantId}
      AND l.id = ANY(${tx.array([...ids], "uuid")}::uuid[])
  `) as {
    disposition: string;
    quantity: number;
    refund_amount: string;
    created_at: Date | string;
    register_id: string | null;
  }[];
  const deltas: ReturnsDailyDelta[] = [];
  for (const row of rows) {
    const delta = computeReturnLineDelta({
      disposition: row.disposition,
      quantity: Number(row.quantity),
      refundAmount: row.refund_amount,
      createdAt: toDate(row.created_at),
      registerId: row.register_id
    });
    if (delta) deltas.push(delta);
  }
  return mergeReturns(deltas);
}

/**
 * Refund-leg stream: the ids are payment-ledger legs (the sql/998 view, cursor
 * `settled_at`); only a succeeded REVERSAL that a refund points at counts. The
 * destination comes from that refund, the register from the leg's own session.
 */
export async function loadRefundLegDeltas(
  tx: Bun.SQL,
  tenantId: string,
  ids: readonly string[]
): Promise<ReturnsDailyDelta[]> {
  if (ids.length === 0) return [];
  const rows = (await tx`
    SELECT a.kind, a.status, a.settled_at, a.tender_type,
      a.amount::text AS amount, f.destination, s.register_id
    FROM awcms_commerce_payment_allocations a
    JOIN awcms_commerce_refunds f
      ON f.tenant_id = a.tenant_id AND f.reversal_allocation_id = a.id
    LEFT JOIN awcms_commerce_register_sessions s
      ON s.tenant_id = a.tenant_id AND s.id = a.register_session_id
    WHERE a.tenant_id = ${tenantId}
      AND a.id = ANY(${tx.array([...ids], "uuid")}::uuid[])
  `) as {
    kind: string;
    status: string;
    settled_at: Date | string | null;
    tender_type: string;
    amount: string;
    destination: string | null;
    register_id: string | null;
  }[];
  const deltas: ReturnsDailyDelta[] = [];
  for (const row of rows) {
    const delta = computeRefundLegDelta({
      kind: row.kind,
      status: row.status,
      settledAt: toNullableDate(row.settled_at),
      tenderType: row.tender_type,
      amount: row.amount,
      destination: row.destination,
      registerId: row.register_id
    });
    if (delta) deltas.push(delta);
  }
  return mergeReturns(deltas);
}

export async function applyReturnsDeltas(
  tx: Bun.SQL,
  tenantId: string,
  deltas: readonly ReturnsDailyDelta[]
): Promise<void> {
  for (const delta of deltas) {
    await tx`
      INSERT INTO awcms_commerce_report_returns_daily
        (tenant_id, day, register_id, section, bucket, detail, entry_count,
         units, amount)
      VALUES (
        ${tenantId}, ${delta.day}::date, ${delta.registerId}, ${delta.section},
        ${delta.bucket}, ${delta.detail}, ${delta.count}, ${delta.units},
        ${formatSignedCents(delta.cents)}::numeric
      )
      ON CONFLICT (tenant_id, day, register_id, section, bucket, detail) DO UPDATE SET
        entry_count = awcms_commerce_report_returns_daily.entry_count + EXCLUDED.entry_count,
        units = awcms_commerce_report_returns_daily.units + EXCLUDED.units,
        amount = awcms_commerce_report_returns_daily.amount + EXCLUDED.amount,
        updated_at = now()
    `;
  }
}

export const RETURNS_SINK: ProjectionDimensionalSink = {
  selectColumns: SINK_SELECT_COLUMNS,
  applyBatch: async (tx, tenantId, rows) =>
    applyReturnsDeltas(
      tx,
      tenantId,
      await loadReturnDeltas(tx, tenantId, idsOf(rows))
    )
};

export const RETURN_LINES_SINK: ProjectionDimensionalSink = {
  selectColumns: SINK_SELECT_COLUMNS,
  applyBatch: async (tx, tenantId, rows) =>
    applyReturnsDeltas(
      tx,
      tenantId,
      await loadReturnLineDeltas(tx, tenantId, idsOf(rows))
    )
};

export const REFUND_LEGS_SINK: ProjectionDimensionalSink = {
  selectColumns: SINK_SELECT_COLUMNS,
  applyBatch: async (tx, tenantId, rows) =>
    applyReturnsDeltas(
      tx,
      tenantId,
      await loadRefundLegDeltas(tx, tenantId, idsOf(rows))
    )
};

const RETURNS_SOURCE: SourceWalk = {
  table: "awcms_commerce_returns",
  cursorColumn: "created_at"
};

const RETURN_LINES_SOURCE: SourceWalk = {
  table: "awcms_commerce_return_lines",
  cursorColumn: "created_at"
};

const REFUND_LEGS_SOURCE: SourceWalk = {
  table: "awcms_commerce_report_src_allocations",
  cursorColumn: "settled_at"
};

export const RETURNS_DIMENSIONAL: ProjectionDimensionalContract = {
  resetForTenant: async (tx, tenantId) => {
    await tx`DELETE FROM awcms_commerce_report_returns_daily WHERE tenant_id = ${tenantId}`;
  },
  readProjectionTotals: async (tx, tenantId) => {
    const [row] = (await tx`
      SELECT
        COALESCE(SUM(entry_count) FILTER (WHERE section = 'return'), 0)::text AS return_count,
        COALESCE(SUM(amount) FILTER (WHERE section = 'return'), 0)::text AS return_amount,
        COALESCE(SUM(entry_count) FILTER (WHERE section = 'disposition'), 0)::text AS line_count,
        COALESCE(SUM(units) FILTER (WHERE section = 'disposition'), 0)::text AS line_units,
        COALESCE(SUM(amount) FILTER (WHERE section = 'disposition'), 0)::text AS line_amount,
        COALESCE(SUM(entry_count) FILTER (WHERE section = 'refund'), 0)::text AS refund_count,
        COALESCE(SUM(amount) FILTER (WHERE section = 'refund'), 0)::text AS refund_amount
      FROM awcms_commerce_report_returns_daily
      WHERE tenant_id = ${tenantId}
    `) as Record<string, unknown>[];
    return {
      [RETURNS_CONTROL_KEYS.returnCount]: Number(row?.return_count ?? 0),
      [RETURNS_CONTROL_KEYS.returnCents]: sumToNumber(row?.return_amount),
      [RETURNS_CONTROL_KEYS.lineCount]: Number(row?.line_count ?? 0),
      [RETURNS_CONTROL_KEYS.lineUnits]: Number(row?.line_units ?? 0),
      [RETURNS_CONTROL_KEYS.lineCents]: sumToNumber(row?.line_amount),
      [RETURNS_CONTROL_KEYS.refundCount]: Number(row?.refund_count ?? 0),
      [RETURNS_CONTROL_KEYS.refundCents]: sumToNumber(row?.refund_amount)
    };
  },
  computeSourceTotals: async (tx, tenantId) => {
    const totals = {
      returnCount: 0,
      returnCents: 0n,
      lineCount: 0,
      lineUnits: 0,
      lineCents: 0n,
      refundCount: 0,
      refundCents: 0n
    };
    const fold = (deltas: readonly ReturnsDailyDelta[]) => {
      for (const delta of deltas) {
        if (delta.section === "return") {
          totals.returnCount += delta.count;
          totals.returnCents += delta.cents;
        } else if (delta.section === "disposition") {
          totals.lineCount += delta.count;
          totals.lineUnits += delta.units;
          totals.lineCents += delta.cents;
        } else {
          totals.refundCount += delta.count;
          totals.refundCents += delta.cents;
        }
      }
    };
    await walkSource(tx, tenantId, RETURNS_SOURCE, async (ids) =>
      fold(await loadReturnDeltas(tx, tenantId, ids))
    );
    await walkSource(tx, tenantId, RETURN_LINES_SOURCE, async (ids) =>
      fold(await loadReturnLineDeltas(tx, tenantId, ids))
    );
    await walkSource(tx, tenantId, REFUND_LEGS_SOURCE, async (ids) =>
      fold(await loadRefundLegDeltas(tx, tenantId, ids))
    );
    return {
      [RETURNS_CONTROL_KEYS.returnCount]: totals.returnCount,
      [RETURNS_CONTROL_KEYS.returnCents]: Number(totals.returnCents),
      [RETURNS_CONTROL_KEYS.lineCount]: totals.lineCount,
      [RETURNS_CONTROL_KEYS.lineUnits]: totals.lineUnits,
      [RETURNS_CONTROL_KEYS.lineCents]: Number(totals.lineCents),
      [RETURNS_CONTROL_KEYS.refundCount]: totals.refundCount,
      [RETURNS_CONTROL_KEYS.refundCents]: Number(totals.refundCents)
    };
  },
  exportRows: async (tx, tenantId) => {
    const rows = (await tx`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, register_id, section, bucket,
        detail, entry_count, units, amount::text AS amount
      FROM awcms_commerce_report_returns_daily
      WHERE tenant_id = ${tenantId}
      ORDER BY day ASC, register_id ASC, section ASC, bucket ASC, detail ASC
    `) as Record<string, unknown>[];
    return {
      columns: [
        "day",
        "register_id",
        "section",
        "bucket",
        "detail",
        "entry_count",
        "units",
        "amount"
      ],
      rows
    };
  }
};
