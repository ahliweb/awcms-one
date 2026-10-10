/**
 * Customer-retention projection sinks and hooks - Issue #364, ADR-0044. The DB
 * half of the `commerce.customer_retention` `cursor_table` projection that
 * `commerce/module.ts` contributes to the `reporting` engine: every function
 * takes the ENGINE's transaction (`tx`) and is called by the engine's
 * incremental worker, rebuild, reconciliation and export at the points
 * `ProjectionDimensionalSink`/`ProjectionDimensionalContract` define. Like
 * `sales-report-projection.ts` it imports no pool and no `withTenant`, so
 * `module.ts` can reference it without dragging a connection into every pure
 * registry gate that imports `listModules()`.
 *
 * ## What a batch is, and why this sink RECOMPUTES
 *
 * The projection listens to two append-only streams:
 *
 *   * `awcms_commerce_order_events` (cursor `created_at`) - every status
 *     transition. Only the rows that can change whether an order QUALIFIES
 *     matter (a transition into `paid`, a cancellation/refund out of a paid
 *     state, and a `returned` row announcing a return); the rest are dropped
 *     before any query.
 *   * `awcms_commerce_report_src_retention_reversals` (cursor `settled_at`) -
 *     the payment ledger's settled reversal legs. A full refund recorded by
 *     hand moves the order's cached `payment_status` to `refunded` without any
 *     order-status event, and a refund is the thing that removes a customer
 *     from a cohort.
 *
 * A retention row is not additive (a late event moves a customer between
 * cohorts), so the sink never applies a delta. For the customers whose orders
 * the batch touched it re-reads those orders' CURRENT state, runs the pure
 * {@link deriveCustomerRetention}, and writes the row (or deletes it when the
 * customer no longer qualifies). Recomputing from current state is idempotent
 * and order-independent: a rebuild replays the same events and ends on exactly
 * the rows the live pass holds, and a crash-and-retry of a pass re-derives the
 * same rows. Every customer who ever had a relevant event is recomputed at
 * least once after their last one, which is the whole correctness argument.
 *
 * ## What is NOT in the row
 *
 * Whether the customer is blocked, soft-deleted or the walk-in sentinel is
 * mutable state with no event on either stream, so it is NOT baked into the
 * row: the read joins `awcms_commerce_customers` at request time. That keeps
 * "rebuild equals live" independent of when a customer was blocked.
 *
 * ## Restatement
 *
 * On the live path (never during a rebuild run - see sql/1020's header) a
 * recompute that changes a cohort the 35-day window has already closed writes
 * `awcms_commerce_report_retention_restated` (see {@link restatedCohortMonths}).
 */
import {
  RETENTION_CONTROL_KEYS,
  RETENTION_PROJECTION_KEY,
  RETENTION_WINDOW_HOURS,
  accumulateRetentionControlTotals,
  deriveCustomerRetention,
  emptyRetentionControlTotals,
  restatedCohortMonths,
  type CustomerRetention,
  type RetentionOrderFact,
  type RetentionRowState
} from "../domain/retention";
import { resolveSalesDeltaDirection } from "../domain/sales-report-deltas";
import type {
  ProjectionDimensionalContract,
  ProjectionDimensionalSink
} from "../../_shared/module-contract";

/** Columns the order-event stream asks the engine to SELECT beyond the cursor. */
export const RETENTION_EVENT_SELECT_COLUMNS = [
  "id",
  "order_id",
  "from_status",
  "to_status",
  "return_id"
] as const;

/** Columns the reversal-leg stream asks the engine to SELECT beyond the cursor. */
export const RETENTION_REVERSAL_SELECT_COLUMNS = ["id", "order_id"] as const;

type OrderRefRow = {
  order_id?: string;
  from_status?: string | null;
  to_status?: string;
  return_id?: string | null;
};

/**
 * The order ids of a batch whose event can change whether an order qualifies.
 * A row without `to_status` is a reversal leg and always counts.
 */
export function relevantOrderIds(
  rows: readonly Record<string, unknown>[]
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const ref = row as OrderRefRow;
    if (!ref.order_id) continue;
    if (ref.to_status === undefined) {
      ids.add(ref.order_id);
      continue;
    }
    if (ref.return_id) {
      ids.add(ref.order_id);
      continue;
    }
    if (
      resolveSalesDeltaDirection({
        fromStatus: ref.from_status ?? null,
        toStatus: ref.to_status
      }) !== 0
    ) {
      ids.add(ref.order_id);
    }
  }
  return [...ids].sort();
}

type OrderFactRow = {
  id: string;
  customer_id: string;
  paid_at: Date | string | null;
  status: string;
  payment_status: string;
};

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Loads the CURRENT paid-order facts of the given customers, grouped by customer. */
async function loadCustomerFacts(
  tx: Bun.SQL,
  tenantId: string,
  customerIds: readonly string[]
): Promise<Map<string, RetentionOrderFact[]>> {
  const grouped = new Map<string, RetentionOrderFact[]>();
  if (customerIds.length === 0) return grouped;
  const rows = (await tx`
    SELECT id, customer_id, paid_at, status, payment_status
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId}
      AND customer_id = ANY(${tx.array([...customerIds], "uuid")}::uuid[])
      AND paid_at IS NOT NULL
    ORDER BY customer_id ASC, paid_at ASC, id ASC
  `) as OrderFactRow[];
  for (const row of rows) {
    const list = grouped.get(row.customer_id) ?? [];
    list.push({
      orderId: row.id,
      paidAt: row.paid_at === null ? null : toDate(row.paid_at),
      status: row.status,
      paymentStatus: row.payment_status
    });
    grouped.set(row.customer_id, list);
  }
  return grouped;
}

type StoredRow = {
  customer_id: string;
  cohort_month: string;
  first_event_at: Date | string;
  second_event_at: Date | string | null;
};

async function loadStoredRows(
  tx: Bun.SQL,
  tenantId: string,
  customerIds: readonly string[]
): Promise<Map<string, RetentionRowState>> {
  const stored = new Map<string, RetentionRowState>();
  if (customerIds.length === 0) return stored;
  const rows = (await tx`
    SELECT customer_id, to_char(cohort_month, 'YYYY-MM-DD') AS cohort_month,
      first_event_at, second_event_at
    FROM awcms_commerce_report_retention_customers
    WHERE tenant_id = ${tenantId}
      AND customer_id = ANY(${tx.array([...customerIds], "uuid")}::uuid[])
  `) as StoredRow[];
  for (const row of rows) {
    stored.set(row.customer_id, {
      cohortMonth: row.cohort_month,
      firstEventAt: toDate(row.first_event_at),
      secondEventAt:
        row.second_event_at === null ? null : toDate(row.second_event_at)
    });
  }
  return stored;
}

async function isRebuildRunning(
  tx: Bun.SQL,
  tenantId: string
): Promise<boolean> {
  const rows = (await tx`
    SELECT 1 AS running
    FROM awcms_reporting_rebuild_runs
    WHERE tenant_id = ${tenantId}
      AND projection_key = ${RETENTION_PROJECTION_KEY}
      AND status = 'running'
    LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}

async function recordRestatement(
  tx: Bun.SQL,
  tenantId: string,
  cohortMonth: string
): Promise<void> {
  await tx`
    INSERT INTO awcms_commerce_report_retention_restated
      (tenant_id, cohort_month, restated_at)
    VALUES (${tenantId}, ${cohortMonth}::date, now())
    ON CONFLICT (tenant_id, cohort_month) DO UPDATE SET
      restated_at = EXCLUDED.restated_at
  `;
}

/**
 * Recomputes the retention rows of every customer owning one of `orderIds`.
 * Exported for the integration tests; the engine only ever reaches it through
 * {@link applyRetentionBatch}.
 */
export async function recomputeCustomersOfOrders(
  tx: Bun.SQL,
  tenantId: string,
  orderIds: readonly string[]
): Promise<void> {
  if (orderIds.length === 0) return;
  const owners = (await tx`
    SELECT DISTINCT customer_id
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId}
      AND id = ANY(${tx.array([...orderIds], "uuid")}::uuid[])
    ORDER BY customer_id ASC
  `) as { customer_id: string }[];
  const customerIds = owners.map((owner) => owner.customer_id);
  if (customerIds.length === 0) return;

  const facts = await loadCustomerFacts(tx, tenantId, customerIds);
  const previous = await loadStoredRows(tx, tenantId, customerIds);
  const live = !(await isRebuildRunning(tx, tenantId));
  const clock = (await tx`SELECT now() AS now`) as { now: Date | string }[];
  const now = toDate(clock[0]!.now);

  for (const customerId of customerIds) {
    const next: CustomerRetention | null = deriveCustomerRetention(
      facts.get(customerId) ?? []
    );
    const before = previous.get(customerId) ?? null;
    if (next === null) {
      if (before !== null) {
        await tx`
          DELETE FROM awcms_commerce_report_retention_customers
          WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
        `;
      }
    } else {
      await tx`
        INSERT INTO awcms_commerce_report_retention_customers
          (tenant_id, customer_id, cohort_month, first_event_at,
           second_event_at, qualifying_order_count)
        VALUES (${tenantId}, ${customerId}, ${next.cohortMonth}::date,
          ${next.firstEventAt}, ${next.secondEventAt}, ${next.qualifyingOrderCount})
        ON CONFLICT (tenant_id, customer_id) DO UPDATE SET
          cohort_month = EXCLUDED.cohort_month,
          first_event_at = EXCLUDED.first_event_at,
          second_event_at = EXCLUDED.second_event_at,
          qualifying_order_count = EXCLUDED.qualifying_order_count,
          updated_at = now()
      `;
    }
    if (live) {
      for (const month of restatedCohortMonths(before, next, now)) {
        await recordRestatement(tx, tenantId, month);
      }
    }
  }
}

export async function applyRetentionBatch(
  tx: Bun.SQL,
  tenantId: string,
  rows: readonly Record<string, unknown>[]
): Promise<void> {
  await recomputeCustomersOfOrders(tx, tenantId, relevantOrderIds(rows));
}

export const RETENTION_EVENT_SINK: ProjectionDimensionalSink = {
  selectColumns: RETENTION_EVENT_SELECT_COLUMNS,
  applyBatch: applyRetentionBatch
};

export const RETENTION_REVERSAL_SINK: ProjectionDimensionalSink = {
  selectColumns: RETENTION_REVERSAL_SELECT_COLUMNS,
  applyBatch: applyRetentionBatch
};

// ---------------------------------------------------------------------------
// Control totals (reconciliation)
// ---------------------------------------------------------------------------

/** Customers per page of the reconciliation's full source walk. */
const CONTROL_TOTAL_PAGE_SIZE = 1000;

/**
 * Walks every customer that has a paid order (keyset by id, paged) and sums the
 * output of the same {@link deriveCustomerRetention} the sink applies - the
 * reconciliation's source control total. Read-only; unbounded by design like
 * the engine's own `COUNT(*)` totals; runs in the reconcile route's own
 * transaction.
 */
export async function computeRetentionSourceTotals(
  tx: Bun.SQL,
  tenantId: string
) {
  const totals = emptyRetentionControlTotals();
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const page = (await tx`
      SELECT DISTINCT customer_id
      FROM awcms_commerce_orders
      WHERE tenant_id = ${tenantId}
        AND paid_at IS NOT NULL
        AND customer_id > ${after}::uuid
      ORDER BY customer_id ASC
      LIMIT ${CONTROL_TOTAL_PAGE_SIZE}
    `) as { customer_id: string }[];
    if (page.length === 0) break;
    const ids = page.map((row) => row.customer_id);
    const facts = await loadCustomerFacts(tx, tenantId, ids);
    for (const id of ids) {
      const derived = deriveCustomerRetention(facts.get(id) ?? []);
      if (derived !== null) accumulateRetentionControlTotals(totals, derived);
    }
    after = ids[ids.length - 1]!;
    if (page.length < CONTROL_TOTAL_PAGE_SIZE) break;
  }
  return totals;
}

export const RETENTION_DIMENSIONAL: ProjectionDimensionalContract = {
  resetForTenant: async (tx, tenantId) => {
    // The restatement log is evidence of WHEN a cohort changed, not a
    // derivation, so a rebuild leaves it alone (sql/1020's header).
    await tx`DELETE FROM awcms_commerce_report_retention_customers WHERE tenant_id = ${tenantId}`;
  },
  readProjectionTotals: async (tx, tenantId) => {
    const rows = (await tx`
      SELECT count(*)::int AS customers,
        (count(*) FILTER (
          WHERE second_event_at IS NOT NULL
            AND second_event_at > first_event_at
            AND second_event_at <= first_event_at + make_interval(hours => ${RETENTION_WINDOW_HOURS})
        ))::int AS repeaters,
        COALESCE(sum(qualifying_order_count), 0)::int AS qualifying_orders
      FROM awcms_commerce_report_retention_customers
      WHERE tenant_id = ${tenantId}
    `) as Record<string, unknown>[];
    const row = rows[0] ?? {};
    return {
      [RETENTION_CONTROL_KEYS.customers]: Number(row.customers ?? 0),
      [RETENTION_CONTROL_KEYS.repeaters]: Number(row.repeaters ?? 0),
      [RETENTION_CONTROL_KEYS.qualifyingOrders]: Number(
        row.qualifying_orders ?? 0
      )
    };
  },
  computeSourceTotals: async (tx, tenantId) => {
    const totals = await computeRetentionSourceTotals(tx, tenantId);
    return {
      [RETENTION_CONTROL_KEYS.customers]: totals.customers,
      [RETENTION_CONTROL_KEYS.repeaters]: totals.repeaters,
      [RETENTION_CONTROL_KEYS.qualifyingOrders]: totals.qualifyingOrders
    };
  },
  // Aggregates only: the export carries cohort counts, never a customer.
  exportRows: async (tx, tenantId) => {
    const rows = (await tx`
      SELECT to_char(cohort_month, 'YYYY-MM-DD') AS cohort_month,
        count(*)::int AS customers,
        (count(*) FILTER (
          WHERE second_event_at IS NOT NULL
            AND second_event_at > first_event_at
            AND second_event_at <= first_event_at + make_interval(hours => ${RETENTION_WINDOW_HOURS})
        ))::int AS repeaters
      FROM awcms_commerce_report_retention_customers
      WHERE tenant_id = ${tenantId}
      GROUP BY cohort_month
      ORDER BY cohort_month ASC
    `) as Record<string, unknown>[];
    return { columns: ["cohort_month", "customers", "repeaters"], rows };
  }
};
