/**
 * The booking adapter's post-restore reconciliation (Issue #396, epic #280 item
 * 35 adapter half; threat controls C-09 and C-38, ADR-0045). READ-ONLY: every
 * statement is a `SELECT`, every tenant pass runs in a `READ ONLY` transaction,
 * and nothing here repairs anything - an operator decides, exactly as for the
 * C-09 route this builds on.
 *
 * ## Where this sits in the restore drill
 *
 * Upstream's drill (`apps/cms/deploy/backup/restore-drill.sh`, which wraps
 * `restore-postgres.sh`) restores the newest backup into a scratch database,
 * asserts the schema looks like AWCMS and DROPS it again, so it cannot run a
 * query that needs the restored rows, and this repo does not edit it. The adapter
 * half therefore runs between the restore and the drop: restore with `--keep`,
 * point `DATABASE_URL` at the scratch database, run
 * `bun run commerce:booking:reconcile`, drop the database. The procedure is in
 * `docs/deployment.md` ("Booking adapter restore drill").
 *
 * ## What it checks
 *
 *   1. Structure (once per database): the six adapter tables exist with FORCE
 *      ROW LEVEL SECURITY, their tenant-isolation policy, their guard trigger
 *      (enabled) and the unique indexes the invariants stand on. The upstream
 *      drill only asserts that SOME table has FORCE RLS.
 *   2. Per tenant, C-38: orders and reservations point at each other exactly
 *      once (`reconcileBookingReferences`, in the file that may read Booking's
 *      tables).
 *   3. Per tenant, C-09: the order's settlement versus the reservation's state
 *      (`reconcileBookingOrders`), split into findings nobody is looking at
 *      (drift) and findings already in the operator queue (acknowledged).
 *   4. Per tenant, refund decisions versus refund legs: a decision belongs to
 *      the order of its link, its return to that order, the legs never exceed
 *      the decision, and a completed return has settled at least the decision.
 *   5. The extension point below.
 *
 * ## EXTENSION POINT - the cancellation issue (#381)
 *
 * `BOOKING_RESTORE_EXTENSION_CHECKS` is empty on purpose. #381 owns the
 * cancellation quote and the refund-leg planner and writes the first
 * `awcms_commerce_booking_refund_decisions` rows; any further post-restore check
 * that depends on what it adds (for example a decision's return total against
 * the planner's tax split) is registered HERE by that issue, never invented
 * before the code that writes the rows exists. A check returns findings with
 * ids only.
 */

import { fetchActiveTenants } from "../../../lib/jobs/batching";
import { withTenantOrThrow } from "../../../lib/database/tenant-context";
import { normalizeMoney } from "../domain/price-calculation";
import {
  type BookingRestoreReport,
  type DecisionDriftItem,
  type DecisionDriftKind,
  type LedgerFinding,
  type RestoreExtensionFinding,
  type StructureFinding,
  type TenantRestoreCounts,
  type TenantRestoreReport
} from "../domain/booking-restore-drill";
import {
  reconcileBookingOrders,
  reconcileBookingReferences
} from "./booking-reservation-reads";

/** The adapter's eight tables (`sql/1035`-`sql/1038`, `sql/1045`, `sql/1050`); pinned to the lifecycle descriptors by a test. */
export const BOOKING_ADAPTER_RESTORE_TABLES = [
  "awcms_commerce_booking_offering_links",
  "awcms_commerce_booking_reservation_links",
  "awcms_commerce_product_deposit_policies",
  "awcms_commerce_cancellation_policies",
  "awcms_commerce_cancellation_policy_windows",
  "awcms_commerce_booking_refund_decisions",
  "awcms_commerce_booking_reschedules",
  "awcms_commerce_booking_offering_link_resources"
] as const;

/**
 * Unique indexes (and unique-constraint indexes) the adapter's invariants stand
 * on. A restore that drops one leaves the data readable and the guarantee gone.
 */
export const BOOKING_ADAPTER_RESTORE_INDEXES = [
  "awcms_booking_reservations_external_ref_key",
  "awcms_commerce_booking_offering_links_offering_active_key",
  "awcms_commerce_booking_offering_links_product_active_key",
  "awcms_commerce_booking_reservation_links_client_key_key",
  "awcms_commerce_booking_reservation_links_reservation_active_key",
  "awcms_commerce_booking_reservation_links_order_item_active_key",
  "awcms_commerce_booking_refund_decisions_link_key",
  "awcms_commerce_booking_refund_decisions_source_key_key"
] as const;

type TableRow = {
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
};

/**
 * Catalog check of the adapter's structure. Not tenant-scoped (the catalog is
 * not tenant data), so it takes the plain client.
 */
export async function checkBookingAdapterStructure(
  sql: Bun.SQL
): Promise<StructureFinding[]> {
  const tables = [...BOOKING_ADAPTER_RESTORE_TABLES];
  const indexes = [...BOOKING_ADAPTER_RESTORE_INDEXES];
  const findings: StructureFinding[] = [];

  const tableRows = (await sql`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname = ANY(${sql.array(tables, "text")}::text[])
  `) as TableRow[];
  const byName = new Map(tableRows.map((row) => [row.relname, row]));

  const policyRows = (await sql`
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = ANY(${sql.array(tables, "text")}::text[])
  `) as { policyname: string }[];
  const policies = new Set(policyRows.map((row) => row.policyname));

  const triggerRows = (await sql`
    SELECT t.tgname, t.tgenabled
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND NOT t.tgisinternal
      AND c.relname = ANY(${sql.array(tables, "text")}::text[])
  `) as { tgname: string; tgenabled: string }[];
  const triggers = new Map(
    triggerRows.map((row) => [row.tgname, row.tgenabled])
  );

  const indexRows = (await sql`
    SELECT ic.relname
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = ic.relnamespace
    WHERE n.nspname = 'public'
      AND i.indisunique
      AND i.indisvalid
      AND ic.relname = ANY(${sql.array(indexes, "text")}::text[])
  `) as { relname: string }[];
  const presentIndexes = new Set(indexRows.map((row) => row.relname));

  for (const table of tables) {
    const row = byName.get(table);
    if (!row) {
      findings.push({ kind: "table_missing", object: table });
      continue;
    }
    if (!row.relrowsecurity || !row.relforcerowsecurity) {
      findings.push({ kind: "rls_not_forced", object: table });
    }
    if (!policies.has(`${table}_tenant_isolation`)) {
      findings.push({
        kind: "policy_missing",
        object: `${table}_tenant_isolation`
      });
    }
    const guard = `${table}_guard`;
    const state = triggers.get(guard);
    if (state === undefined) {
      findings.push({ kind: "trigger_missing", object: guard });
    } else if (state === "D") {
      findings.push({ kind: "trigger_disabled", object: guard });
    }
  }
  for (const index of indexes) {
    if (!presentIndexes.has(index)) {
      findings.push({ kind: "index_missing", object: index });
    }
  }
  return findings;
}

type CountRow = {
  offering_links: number | string;
  reservation_links: number | string;
  active_reservation_links: number | string;
  open_attention: number | string;
  refund_decisions: number | string;
  decisions_awaiting_legs: number | string;
};

export async function readBookingRestoreCounts(
  tx: Bun.SQL,
  tenantId: string
): Promise<TenantRestoreCounts> {
  const rows = (await tx`
    SELECT
      (SELECT count(*) FROM awcms_commerce_booking_offering_links
        WHERE tenant_id = ${tenantId} AND status = 'active')::int AS offering_links,
      (SELECT count(*) FROM awcms_commerce_booking_reservation_links
        WHERE tenant_id = ${tenantId})::int AS reservation_links,
      (SELECT count(*) FROM awcms_commerce_booking_reservation_links
        WHERE tenant_id = ${tenantId} AND status = 'active')::int AS active_reservation_links,
      (SELECT count(*) FROM awcms_commerce_booking_reservation_links
        WHERE tenant_id = ${tenantId}
          AND attention_reason IS NOT NULL AND attention_resolved_at IS NULL)::int AS open_attention,
      (SELECT count(*) FROM awcms_commerce_booking_refund_decisions
        WHERE tenant_id = ${tenantId})::int AS refund_decisions,
      (SELECT count(*) FROM awcms_commerce_booking_refund_decisions
        WHERE tenant_id = ${tenantId} AND final_refund > 0 AND return_id IS NULL)::int AS decisions_awaiting_legs
  `) as CountRow[];
  const row = rows[0]!;
  return {
    offeringLinks: Number(row.offering_links),
    reservationLinks: Number(row.reservation_links),
    activeReservationLinks: Number(row.active_reservation_links),
    openAttention: Number(row.open_attention),
    refundDecisions: Number(row.refund_decisions),
    decisionsAwaitingLegs: Number(row.decisions_awaiting_legs)
  };
}

export const DECISION_DRIFT_LIMIT = 200;

type DecisionRow = {
  kind: DecisionDriftKind;
  decision_id: string;
  reservation_link_id: string;
  order_id: string;
  return_id: string | null;
  final_refund: string;
  planned: string;
  settled: string;
};

/**
 * Booking refund decisions versus the refund legs that carry them out
 * (`awcms_commerce_refunds` legs of the decision's return, ADR-0033). Only
 * invariants the schema and the data model fix are asserted:
 *
 *   - `decision_order_mismatch`: the decision's order is not its link's order;
 *   - `decision_return_order_mismatch`: its return belongs to another order;
 *   - `legs_exceed_decision`: the live legs (pending, processing, succeeded) add
 *     up to MORE than the decision refunds (a zero decision with any leg lands
 *     here), the money-out direction the decision's own CHECK exists to cap;
 *   - `legs_short_of_decision`: the return is `completed` (every leg settled)
 *     yet the succeeded legs add up to LESS than the decision refunds.
 *
 * A decision with money to refund and no return yet is a normal in-flight state
 * and is only counted (`decisionsAwaitingLegs`). On a database with no #381
 * traffic the table is empty and this returns nothing.
 */
export async function reconcileBookingRefundDecisions(
  tx: Bun.SQL,
  tenantId: string,
  limit: number = DECISION_DRIFT_LIMIT
): Promise<{ items: DecisionDriftItem[]; truncated: boolean }> {
  const rows = (await tx`
    WITH legs AS (
      SELECT f.return_id,
             COALESCE(SUM(f.amount) FILTER (
               WHERE f.status IN ('pending', 'processing', 'succeeded')), 0) AS planned,
             COALESCE(SUM(f.amount) FILTER (WHERE f.status = 'succeeded'), 0) AS settled
      FROM awcms_commerce_refunds f
      WHERE f.tenant_id = ${tenantId}
      GROUP BY f.return_id
    ),
    joined AS (
      SELECT d.id AS decision_id, d.reservation_link_id, d.order_id, d.return_id,
             d.final_refund, d.created_at,
             COALESCE(legs.planned, 0) AS planned,
             COALESCE(legs.settled, 0) AS settled,
             CASE
               WHEN d.order_id <> l.order_id THEN 'decision_order_mismatch'
               WHEN d.return_id IS NOT NULL AND ret.order_id <> d.order_id
                 THEN 'decision_return_order_mismatch'
               WHEN d.return_id IS NOT NULL
                    AND COALESCE(legs.planned, 0) > d.final_refund
                 THEN 'legs_exceed_decision'
               WHEN d.return_id IS NOT NULL AND ret.status = 'completed'
                    AND COALESCE(legs.settled, 0) < d.final_refund
                 THEN 'legs_short_of_decision'
             END AS kind
      FROM awcms_commerce_booking_refund_decisions d
      JOIN awcms_commerce_booking_reservation_links l
        ON l.tenant_id = d.tenant_id AND l.id = d.reservation_link_id
      LEFT JOIN awcms_commerce_returns ret
        ON ret.tenant_id = d.tenant_id AND ret.id = d.return_id
      LEFT JOIN legs ON legs.return_id = d.return_id
      WHERE d.tenant_id = ${tenantId}
    )
    SELECT * FROM joined
    WHERE kind IS NOT NULL
    ORDER BY created_at DESC, decision_id DESC
    LIMIT ${limit + 1}
  `) as DecisionRow[];

  const truncated = rows.length > limit;
  const items = rows.slice(0, limit).map((row): DecisionDriftItem => ({
    kind: row.kind,
    decisionId: row.decision_id,
    reservationLinkId: row.reservation_link_id,
    orderId: row.order_id,
    returnId: row.return_id,
    finalRefund: normalizeMoney(row.final_refund),
    plannedLegs: normalizeMoney(row.planned),
    settledLegs: normalizeMoney(row.settled)
  }));
  return { items, truncated };
}

export type BookingRestoreExtensionCheck = {
  /** A stable name; it becomes the `extension:<key>` drift kind in the evidence line. */
  key: string;
  run: (tx: Bun.SQL, tenantId: string) => Promise<RestoreExtensionFinding[]>;
};

/**
 * EXTENSION POINT (see the file header): empty until the cancellation issue
 * (#381) registers the checks that depend on what it adds.
 */
export const BOOKING_RESTORE_EXTENSION_CHECKS: readonly BookingRestoreExtensionCheck[] =
  [];

export type TenantReconcileOptions = {
  extensions?: readonly BookingRestoreExtensionCheck[];
};

/** One tenant's pass. The caller supplies a tenant transaction (`withTenantOrThrow`). */
export async function reconcileBookingRestoreForTenant(
  tx: Bun.SQL,
  tenantId: string,
  options: TenantReconcileOptions = {}
): Promise<TenantRestoreReport> {
  // A drill must not be able to change the database it is judging, whatever the
  // role it runs as can do.
  await tx`SET LOCAL transaction_read_only = on`;

  const counts = await readBookingRestoreCounts(tx, tenantId);
  const references = await reconcileBookingReferences(tx, tenantId);
  const ledger = await reconcileBookingOrders(tx, tenantId);
  const decisions = await reconcileBookingRefundDecisions(tx, tenantId);

  const unacknowledged: LedgerFinding[] = [];
  let acknowledged = 0;
  for (const item of ledger.items) {
    if (item.attentionOpen) {
      acknowledged += 1;
      continue;
    }
    unacknowledged.push({
      kind: item.kind,
      linkId: item.linkId,
      orderId: item.orderId,
      reservationId: item.reservationId,
      reservationStatus: item.reservationStatus,
      attentionOpen: item.attentionOpen
    });
  }

  const extensions: RestoreExtensionFinding[] = [];
  for (const check of options.extensions ?? BOOKING_RESTORE_EXTENSION_CHECKS) {
    extensions.push(...(await check.run(tx, tenantId)));
  }

  return {
    tenantId,
    counts,
    references,
    ledger: { items: unacknowledged, truncated: ledger.truncated },
    ledgerAcknowledged: acknowledged,
    decisions,
    extensions
  };
}

/**
 * The whole drill: the structure check once, then each requested tenant (or
 * every active tenant) in its own tenant transaction.
 */
export async function runBookingRestoreReconciliation(
  sql: Bun.SQL,
  options: {
    tenantId?: string | null;
    extensions?: readonly BookingRestoreExtensionCheck[];
  } = {}
): Promise<BookingRestoreReport> {
  const structure = await checkBookingAdapterStructure(sql);
  const tenantIds = options.tenantId
    ? [options.tenantId]
    : (await fetchActiveTenants(sql)).map((tenant) => tenant.id);

  const tenants: TenantRestoreReport[] = [];
  for (const tenantId of tenantIds) {
    tenants.push(
      await withTenantOrThrow(
        sql,
        tenantId,
        (tx) =>
          reconcileBookingRestoreForTenant(tx, tenantId, {
            ...(options.extensions ? { extensions: options.extensions } : {})
          }),
        { workClass: "background_sync" }
      )
    );
  }
  return { structure, tenants };
}
