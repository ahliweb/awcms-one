/**
 * `dataLifecycle` and `subjectData` descriptors for the two booking-revenue
 * projection tables (Issue #389, ADR-0045 amendment note, `sql/1047`), declared
 * once here and spread into `module.ts`'s two arrays. They are NOT adapter
 * tables (the adapter's own are in `booking-adapter-lifecycle.ts`, whose
 * contract test pins that set): they are the derived read model of the
 * `commerce.booking_revenue` reporting projection, so they follow the sales and
 * retention projections' shape - keyed on their own report date with the
 * 3650-day ceiling of the order ledger they are computed from. Pure data.
 */
import type {
  HighVolumeTableDescriptor,
  SubjectDataDescriptor
} from "../../_shared/module-contract";

const NO_LEGAL_HOLD = {
  applicable: false,
  precedence: "not_applicable"
} as const;

function reportProjectionTable(
  key: string,
  tableName: string,
  cursorColumn: string,
  indexPurpose: string,
  partitionRationale: string
): HighVolumeTableDescriptor {
  return {
    key,
    tableName,
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn,
    retentionClass: "system_event",
    retentionMinDays: 365,
    retentionMaxDays: 3650,
    defaultRetentionDays: 3650,
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
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      { columns: ["tenant_id", cursorColumn], purpose: indexPurpose }
    ],
    batchLimit: 5000,
    backupRestoreNotes:
      "Included in ordinary full-database backup/restore; no standalone archive artifact - a rebuild from the order ledger is the restore path.",
    executionMode: "generic"
  };
}

export const BOOKING_REPORT_DATA_LIFECYCLE: HighVolumeTableDescriptor[] = [
  reportProjectionTable(
    "commerce.booking_revenue",
    "awcms_commerce_report_booking_orders",
    "paid_day",
    "awcms_commerce_report_booking_orders_day_idx (sql/1047) - the (tenant, cursor) composite the generic purge engine filters + orders by and the day-range report read scans.",
    "One row per booking-sourced paid order; bounded by the shop's booking volume and read through (tenant, paid_day)."
  ),
  reportProjectionTable(
    "commerce.booking_revenue_restated",
    "awcms_commerce_report_booking_restated",
    "day",
    "awcms_commerce_report_booking_restated_day_idx (sql/1047) - the (tenant, cursor) composite the generic purge engine filters + orders by.",
    "At most one row per paid day per tenant."
  )
];

export const BOOKING_REPORT_SUBJECT_DATA: SubjectDataDescriptor[] = [
  {
    key: "commerce.booking_revenue",
    tableName: "awcms_commerce_report_booking_orders",
    ownerModuleKey: "commerce",
    unreachableBySubject: true,
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #389 - one derived row per booking-sourced paid order: its paid day, money figures and stay and no-show counts, keyed by the order id. It stores no customer, name, contact or free text (finding X7: the customer is derived through the order and stored nowhere in the adapter), and it is a derived copy of the fiscal order and ledger records, retained under the same obligation.`
  },
  {
    key: "commerce.booking_revenue_restated",
    tableName: "awcms_commerce_report_booking_restated",
    ownerModuleKey: "commerce",
    unreachableBySubject: true,
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale:
      "Issue #389 - one row per paid day recording when a closed day was last restated: a date and an instant, with no customer, account, order or actor. Erasing a person leaves it unchanged, correctly: the report was restated."
  }
];
