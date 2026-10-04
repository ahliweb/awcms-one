/**
 * `dataLifecycle` and `subjectData` descriptors for the six POS
 * operational-report projection tables (Issue #296, ADR-0035, sql/998; the returns table is sql/945, Issue
 * #316), declared once here and spread into `module.ts`'s two arrays - six
 * near-identical 40-line literals would be six places to forget one field.
 * Pure data, no imports beyond types.
 *
 * ## Retention
 *
 * Derived, fully rebuildable aggregates, keyed on their report `day` like the
 * sales projections (`commerce.sales_daily`): the same 3650-day ceiling as the
 * ledgers they are computed from, so a row can never outlive the facts behind
 * it, and a rebuild after a source's own purge recomputes from what survives.
 * `awcms_app` keeps DELETE (the rebuild reset runs in the API route's
 * transaction); `awcms_worker` holds the purge grants (sql/998).
 *
 * ## Subject data
 *
 * Five of the six carry no person at all: per-day, per-bucket sums. The
 * cash-up table names the cashier of record - STAFF, as a plain tenant-user
 * uuid stamp, never a customer - exactly as the register session it
 * summarises does, and is retained under the same fiscal obligation.
 */
import type {
  HighVolumeTableDescriptor,
  SubjectDataDescriptor
} from "../../_shared/module-contract";

const WINDOW = {
  retentionClass: "system_event",
  retentionMinDays: 365,
  retentionMaxDays: 3650,
  defaultRetentionDays: 3650
} as const;

const BACKUP_NOTES =
  "Included in ordinary full-database backup/restore; no standalone archive artifact - a rebuild from the source ledger is the restore path.";

function descriptor(
  key: string,
  tableName: string,
  indexName: string,
  partitionRationale: string
): HighVolumeTableDescriptor {
  return {
    key,
    tableName,
    ownerModuleKey: "commerce",
    scope: "tenant",
    // A DERIVED reporting projection (sql/998): the cursor is the report `day`
    // itself, as `commerce.sales_daily` does.
    cursorColumn: "day",
    ...WINDOW,
    partition: { eligible: false, rationale: partitionRationale },
    archive: {
      archivable: false,
      rationale:
        "A derived aggregate; the evidence is the source ledger it is computed from, which has its own descriptor."
    },
    deletion: {
      mode: "hard_delete",
      rationale:
        "The generic engine's only implemented mode; a projection row older than its own source's retention can never be rebuilt and is safe to purge."
    },
    legalHold: { applicable: false, precedence: "not_applicable" },
    requiredIndexes: [
      {
        columns: ["tenant_id", "day"],
        purpose: `${indexName} - the (tenant, cursor) composite the generic purge engine filters + orders by and the day-range report read scans.`
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  };
}

export const OPERATIONAL_REPORT_DATA_LIFECYCLE: HighVolumeTableDescriptor[] = [
  descriptor(
    "commerce.pos_tender_daily",
    "awcms_commerce_report_tender_daily",
    "the primary key's own leading columns (sql/998)",
    "Bounded by days x registers x tenders - a few rows per trading day per tenant."
  ),
  descriptor(
    "commerce.pos_cash_up_variance",
    "awcms_commerce_report_cash_up_tenders",
    "awcms_commerce_report_cash_up_tenders_day_idx (sql/998)",
    "One row per closed shift per tender - bounded by shop opening hours."
  ),
  descriptor(
    "commerce.pos_expense_daily",
    "awcms_commerce_report_expense_daily",
    "the primary key's own leading columns (sql/998)",
    "Bounded by days x expense categories x tenders."
  ),
  descriptor(
    "commerce.pos_loyalty_daily",
    "awcms_commerce_report_loyalty_daily",
    "the primary key's own leading columns (sql/998)",
    "At most seven buckets per day per tenant."
  ),
  descriptor(
    "commerce.pos_stored_value_daily",
    "awcms_commerce_report_stored_value_daily",
    "the primary key's own leading columns (sql/998)",
    "At most fourteen rows per day per tenant (two account kinds x seven buckets)."
  ),
  descriptor(
    "commerce.pos_returns_daily",
    "awcms_commerce_report_returns_daily",
    "the primary key's own leading columns (sql/945)",
    "Bounded by days x registers x (two return kinds + three dispositions + tenders x two destinations)."
  )
];

const NO_PERSON_RATIONALE =
  "Issue #296 (ADR-0035). A derived per-day aggregate over a ledger: sums and counts keyed by day and a bucket, with no customer, account, order, actor or author column - an aggregate cannot be traced back to any one person, and the subject-facing rows it summarises are answered by their own descriptors. Erasing a person leaves a day's total unchanged, correctly: the movement happened.";

function unreachable(key: string, tableName: string): SubjectDataDescriptor {
  return {
    key,
    tableName,
    ownerModuleKey: "commerce",
    unreachableBySubject: true,
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: NO_PERSON_RATIONALE
  };
}

export const OPERATIONAL_REPORT_SUBJECT_DATA: SubjectDataDescriptor[] = [
  unreachable(
    "commerce.pos_tender_daily",
    "awcms_commerce_report_tender_daily"
  ),
  {
    key: "commerce.pos_cash_up_variance",
    tableName: "awcms_commerce_report_cash_up_tenders",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "cashier_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale:
      "Issue #296 (ADR-0035). The per-tender expected/counted/adjustment figures of one closed cash shift and the cashier of record, a plain tenant-user uuid stamp that resolves to nobody once identity_access.identities anonymises. It names STAFF only, never a customer, and is a derived copy of the fiscal register records (commerce.register_close_lines, commerce.register_sessions) retained under the same obligation."
  },
  unreachable(
    "commerce.pos_expense_daily",
    "awcms_commerce_report_expense_daily"
  ),
  unreachable(
    "commerce.pos_loyalty_daily",
    "awcms_commerce_report_loyalty_daily"
  ),
  unreachable(
    "commerce.pos_stored_value_daily",
    "awcms_commerce_report_stored_value_daily"
  ),
  unreachable(
    "commerce.pos_returns_daily",
    "awcms_commerce_report_returns_daily"
  )
];
