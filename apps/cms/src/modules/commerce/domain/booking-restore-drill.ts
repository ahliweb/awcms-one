/**
 * The booking adapter's post-restore drill: report shape, verdict, evidence
 * line, CLI arguments and text rendering (Issue #396, epic #280 item 35, adapter
 * half; threat controls C-09 and C-38). Pure - no I/O, no SQL, no clock - so the
 * verdict logic is testable without a database. The queries live in
 * `application/booking-restore-reconciliation.ts` (and, because they read a
 * Booking table, `application/booking-reservation-reads.ts`); the operator
 * entry point is `scripts/commerce-booking-reconcile.ts`.
 *
 * ## What "drift" means here
 *
 * A restore is a point-in-time image. A database that was consistent when
 * `pg_dump` took its snapshot is consistent after `pg_restore`, so the drill's
 * promise is narrow and checkable: every cross-table fact the adapter relies on
 * and that a foreign key cannot see still holds. It reports four classes, and
 * only the first two ever fail a drill:
 *
 *   - `structure`: the adapter's tables lost FORCE ROW LEVEL SECURITY, a
 *     tenant-isolation policy, a guard trigger or a unique index in the round
 *     trip (the upstream drill only asserts that SOME table has FORCE RLS);
 *   - `references` (C-38): an order and a reservation do not point at each other
 *     exactly once each (see `reconcileBookingReferences`);
 *   - `ledger` (C-09): the order's settlement and the reservation's state
 *     disagree AND no operator attention flag is open on the link. A
 *     disagreement that already carries an open flag was in the operator queue
 *     before the backup and is `acknowledged`: reported, never failing;
 *   - `decisions`: a booking refund decision disagrees with the refund legs
 *     that carry it out.
 *
 * ## The extension point for #381
 *
 * `BOOKING_RESTORE_EXTENSION_CHECKS` (application) is where the cancellation
 * issue's own post-restore checks are registered. Nothing in this file names a
 * table that issue adds.
 */

export const RESTORE_DRILL_CHECK_NAME = "commerce:booking:reconcile";

/** The five C-38 kinds, restated so the verdict does not import the SQL file. */
export type ReferenceKind =
  | "back_reference_missing"
  | "back_reference_mismatch"
  | "link_on_rescheduled_reservation"
  | "orphan_back_reference"
  | "order_multiple_references";

export type ReferenceDriftItem = {
  kind: ReferenceKind;
  /** The active link involved; `null` for a reservation or an order with none. */
  linkId: string | null;
  /** The order the link names, or the order id a reservation's reference carries. */
  orderId: string | null;
  reservationId: string | null;
  reservationNo: string | null;
  reservationStatus: string | null;
  /** What Booking's `external_ref_type` / `external_ref` pair holds, when it is the evidence. */
  externalRefType: string | null;
  externalRef: string | null;
  /** `orphan_back_reference` only: whether the order the reference names exists. */
  orderExists: boolean | null;
  /** `order_multiple_references` only. */
  liveReferences: number | null;
  activeLinks: number | null;
};

export const DECISION_DRIFT_KINDS = [
  "decision_order_mismatch",
  "decision_return_order_mismatch",
  "legs_exceed_decision",
  "legs_short_of_decision"
] as const;
export type DecisionDriftKind = (typeof DECISION_DRIFT_KINDS)[number];

export const STRUCTURE_DRIFT_KINDS = [
  "table_missing",
  "rls_not_forced",
  "policy_missing",
  "trigger_missing",
  "trigger_disabled",
  "index_missing"
] as const;
export type StructureDriftKind = (typeof STRUCTURE_DRIFT_KINDS)[number];

export type StructureFinding = {
  kind: StructureDriftKind;
  /** The table, trigger or index name. */
  object: string;
};

export type DecisionDriftItem = {
  kind: DecisionDriftKind;
  decisionId: string;
  reservationLinkId: string;
  orderId: string;
  returnId: string | null;
  /** `numeric(14,2)` strings. */
  finalRefund: string;
  plannedLegs: string;
  settledLegs: string;
};

/** What a follow-up issue's own check reports; ids only, never customer data. */
export type RestoreExtensionFinding = {
  check: string;
  detail: string;
  ids: string[];
};

export type TenantRestoreCounts = {
  offeringLinks: number;
  reservationLinks: number;
  activeReservationLinks: number;
  openAttention: number;
  refundDecisions: number;
  /** Decisions with money to refund and no return yet: transient, never drift. */
  decisionsAwaitingLegs: number;
};

export type LedgerFinding = {
  kind: string;
  linkId: string;
  orderId: string;
  reservationId: string;
  reservationStatus: string;
  attentionOpen: boolean;
};

export type TenantRestoreReport = {
  tenantId: string;
  counts: TenantRestoreCounts;
  references: { items: ReferenceDriftItem[]; truncated: boolean };
  /** C-09 items with NO open attention flag: nobody is looking at them. */
  ledger: { items: LedgerFinding[]; truncated: boolean };
  /** C-09 items already in the operator queue: reported, not drift. */
  ledgerAcknowledged: number;
  decisions: { items: DecisionDriftItem[]; truncated: boolean };
  extensions: RestoreExtensionFinding[];
};

export type BookingRestoreReport = {
  structure: StructureFinding[];
  tenants: TenantRestoreReport[];
};

export type DrillStatus = "pass" | "drift" | "empty";

export type DrillVerdict = {
  status: DrillStatus;
  tenantsChecked: number;
  /** Every finding that fails the drill, by kind (`structure:`, `reference:`, `ledger:`, `decision:`, `extension:` prefixed). */
  driftByKind: Record<string, number>;
  driftTotal: number;
  acknowledgedLedger: number;
  truncated: boolean;
  totals: TenantRestoreCounts;
};

const ZERO_COUNTS: TenantRestoreCounts = {
  offeringLinks: 0,
  reservationLinks: 0,
  activeReservationLinks: 0,
  openAttention: 0,
  refundDecisions: 0,
  decisionsAwaitingLegs: 0
};

function bump(into: Record<string, number>, key: string, by = 1): void {
  into[key] = (into[key] ?? 0) + by;
}

/**
 * The drill's verdict. `requireLinks` makes a database with no reservation link
 * at all an `empty` failure: a drill that checked zero rows proves nothing (the
 * lesson of the upstream host drill, which asks for rows and not only tables).
 */
export function evaluateBookingRestoreReport(
  report: BookingRestoreReport,
  options: { requireLinks?: boolean } = {}
): DrillVerdict {
  const driftByKind: Record<string, number> = {};
  const totals: TenantRestoreCounts = { ...ZERO_COUNTS };
  let acknowledgedLedger = 0;
  let truncated = false;

  for (const finding of report.structure) {
    bump(driftByKind, `structure:${finding.kind}`);
  }

  for (const tenant of report.tenants) {
    for (const key of Object.keys(
      ZERO_COUNTS
    ) as (keyof TenantRestoreCounts)[]) {
      totals[key] += tenant.counts[key];
    }
    for (const item of tenant.references.items) {
      bump(driftByKind, `reference:${item.kind}`);
    }
    for (const item of tenant.ledger.items) {
      bump(driftByKind, `ledger:${item.kind}`);
    }
    for (const item of tenant.decisions.items) {
      bump(driftByKind, `decision:${item.kind}`);
    }
    for (const finding of tenant.extensions) {
      bump(
        driftByKind,
        `extension:${finding.check}`,
        Math.max(1, finding.ids.length)
      );
    }
    acknowledgedLedger += tenant.ledgerAcknowledged;
    truncated =
      truncated ||
      tenant.references.truncated ||
      tenant.ledger.truncated ||
      tenant.decisions.truncated;
  }

  const driftTotal = Object.values(driftByKind).reduce((a, b) => a + b, 0);
  let status: DrillStatus = driftTotal > 0 ? "drift" : "pass";
  if (
    status === "pass" &&
    options.requireLinks &&
    totals.reservationLinks === 0
  ) {
    status = "empty";
  }

  return {
    status,
    tenantsChecked: report.tenants.length,
    driftByKind,
    driftTotal,
    acknowledgedLedger,
    truncated,
    totals
  };
}

export function drillExitCode(status: DrillStatus): number {
  return status === "pass" ? 0 : 1;
}

/**
 * One JSON-lines record for the drill log, shaped like the upstream
 * `restore-drill.sh` evidence line (`startedAt`, `status`, `detail`) plus the
 * counts that make the verdict checkable. Counts and kinds only: no identifier,
 * no amount, no name, so the line is safe to ship to log aggregation or attach
 * to a change ticket.
 */
export function buildDrillEvidenceLine(input: {
  startedAt: Date;
  durationMs: number;
  verdict: DrillVerdict;
}): string {
  const { verdict } = input;
  const detail =
    verdict.status === "pass"
      ? "booking adapter reconciliation found zero drift"
      : verdict.status === "empty"
        ? "no reservation link was present: the drill checked nothing"
        : `booking adapter reconciliation found ${verdict.driftTotal} drifted item(s)`;
  return JSON.stringify({
    startedAt: input.startedAt.toISOString(),
    check: RESTORE_DRILL_CHECK_NAME,
    status: verdict.status === "pass" ? "pass" : "fail",
    outcome: verdict.status,
    detail,
    durationMs: input.durationMs,
    tenantsChecked: verdict.tenantsChecked,
    counts: verdict.totals,
    drift: verdict.driftByKind,
    acknowledgedLedger: verdict.acknowledgedLedger,
    truncated: verdict.truncated
  });
}

export type ReconcileCliArgs = {
  tenantId: string | null;
  json: boolean;
  requireLinks: boolean;
  evidenceLog: string | null;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RECONCILE_USAGE =
  "usage: bun run commerce:booking:reconcile [--tenant <uuid>] [--json] [--require-links] [--evidence-log <path>]";

/** Throws a plain `Error` naming the offending flag. */
export function parseReconcileArgs(argv: string[]): ReconcileCliArgs {
  const args: ReconcileCliArgs = {
    tenantId: null,
    json: false,
    requireLinks: false,
    evidenceLog: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === "--json") {
      args.json = true;
    } else if (flag === "--require-links") {
      args.requireLinks = true;
    } else if (flag === "--tenant" || flag === "--evidence-log") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} needs a value. ${RECONCILE_USAGE}`);
      }
      i += 1;
      if (flag === "--tenant") {
        if (!UUID_PATTERN.test(value)) {
          throw new Error(`--tenant must be a UUID, received: ${value}`);
        }
        args.tenantId = value.toLowerCase();
      } else {
        args.evidenceLog = value;
      }
    } else {
      throw new Error(`Unknown argument ${flag}. ${RECONCILE_USAGE}`);
    }
  }
  return args;
}

/** The human-readable report: a verdict line, then one line per drift kind. */
export function formatDrillText(
  report: BookingRestoreReport,
  verdict: DrillVerdict
): string[] {
  const lines: string[] = [];
  lines.push(
    `${RESTORE_DRILL_CHECK_NAME}: ${verdict.status.toUpperCase()} - ${verdict.tenantsChecked} tenant(s), ` +
      `${verdict.totals.reservationLinks} reservation link(s) (${verdict.totals.activeReservationLinks} active), ` +
      `${verdict.totals.refundDecisions} refund decision(s)`
  );
  for (const [kind, count] of Object.entries(verdict.driftByKind).sort()) {
    lines.push(`  drift ${kind}: ${count}`);
  }
  for (const finding of report.structure) {
    lines.push(`  structure ${finding.kind}: ${finding.object}`);
  }
  for (const tenant of report.tenants) {
    const found =
      tenant.references.items.length +
      tenant.ledger.items.length +
      tenant.decisions.items.length +
      tenant.extensions.length;
    if (found > 0) {
      lines.push(
        `  tenant ${tenant.tenantId}: ${found} finding group(s); re-run with --json for the ids`
      );
    }
  }
  if (verdict.acknowledgedLedger > 0) {
    lines.push(
      `  note: ${verdict.acknowledgedLedger} C-09 disagreement(s) already carry an open attention flag (in the operator queue before the backup); not counted as drift`
    );
  }
  if (verdict.totals.decisionsAwaitingLegs > 0) {
    lines.push(
      `  note: ${verdict.totals.decisionsAwaitingLegs} refund decision(s) have money to refund and no return yet (transient while a cancel is in flight); not counted as drift`
    );
  }
  if (verdict.truncated) {
    lines.push(
      "  note: at least one finding list hit its bound; resolve what is shown and run again"
    );
  }
  if (verdict.status === "empty") {
    lines.push(
      "  --require-links was given and the database holds no reservation link: the drill checked nothing"
    );
  }
  return lines;
}
