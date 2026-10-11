/**
 * `dataLifecycle` and `subjectData` descriptors for the two customer-retention
 * projection tables (Issue #364, ADR-0044, sql/1020), spread into
 * `module.ts`'s two arrays the way `operational-report-lifecycle.ts` does for
 * the POS report tables. Pure data, no imports beyond types.
 *
 * ## Retention
 *
 * Derived and fully rebuildable, keyed on `cohort_month` like the sales
 * projections key on `day`: the same 3650-day ceiling as the order ledger the
 * rows are computed from, so a row can never outlive the facts behind it, and a
 * rebuild after the source's own purge recomputes from what survives.
 *
 * ## Subject data
 *
 * `awcms_commerce_report_retention_customers` holds a commerce `customer_id`
 * plus two instants and a count - no name, phone, e-mail or order id. The
 * commerce customer is unreachable by the engine's tenant_user/identity/
 * profile vocabulary (the same gap `commerce.customers` documents), so the
 * honest descriptor is `unreachableBySubject: true`; the row is a derived copy
 * of the fiscal order records and is retained under the same obligation. The
 * restatement log holds a month and an instant and no person at all.
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

function descriptor(
  key: string,
  tableName: string,
  partitionRationale: string,
  indexPurpose: string
): HighVolumeTableDescriptor {
  return {
    key,
    tableName,
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "cohort_month",
    ...WINDOW,
    partition: { eligible: false, rationale: partitionRationale },
    archive: {
      archivable: false,
      rationale:
        "A derived aggregate; the evidence is the order and payment ledgers it is computed from, which have their own descriptors."
    },
    deletion: {
      mode: "hard_delete",
      rationale:
        "The generic engine's only implemented mode; a projection row older than its own source's retention can never be rebuilt and is safe to purge."
    },
    legalHold: { applicable: false, precedence: "not_applicable" },
    requiredIndexes: [
      {
        columns: ["tenant_id", "cohort_month"],
        purpose: indexPurpose
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes:
      "Included in ordinary full-database backup/restore; no standalone archive artifact - a rebuild from the order ledger is the restore path.",
    executionMode: "generic"
  };
}

export const RETENTION_DATA_LIFECYCLE: HighVolumeTableDescriptor[] = [
  descriptor(
    "commerce.customer_retention",
    "awcms_commerce_report_retention_customers",
    "One row per customer with a qualifying order - bounded by the tenant's customer count, not by traffic.",
    "awcms_commerce_report_retention_customers_month_idx (sql/1020) - the (tenant, cursor) composite the generic purge engine filters + orders by and the cohort-range report read scans."
  ),
  descriptor(
    "commerce.customer_retention_restated",
    "awcms_commerce_report_retention_restated",
    "At most one row per cohort month per tenant.",
    "the primary key's own leading columns (sql/1020)."
  )
];

export const RETENTION_SUBJECT_DATA: SubjectDataDescriptor[] = [
  {
    key: "commerce.customer_retention",
    tableName: "awcms_commerce_report_retention_customers",
    ownerModuleKey: "commerce",
    unreachableBySubject: true,
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale:
      "Issue #364 (ADR-0044). A derived per-customer pair of order instants and an order count, keyed by the commerce customer id with no name, phone, e-mail or order id. The commerce customer is unreachable by this engine's tenant_user/identity/profile vocabulary (the same gap commerce.customers documents), and the row is a derived copy of the fiscal order records retained under the same obligation; the customer leaves the report at once when blocked or purged (the read joins commerce.customers) and the row itself at the next rebuild."
  },
  {
    key: "commerce.customer_retention_restated",
    tableName: "awcms_commerce_report_retention_restated",
    ownerModuleKey: "commerce",
    unreachableBySubject: true,
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale:
      "Issue #364 (ADR-0044). One row per cohort month recording when a closed cohort was last restated: a month and an instant, with no customer, account, order or actor. Erasing a person leaves it unchanged, correctly: the report was restated."
  }
];
