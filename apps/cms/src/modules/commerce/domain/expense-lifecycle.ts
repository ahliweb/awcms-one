/**
 * `dataLifecycle` and `subjectData` descriptors for the two expense tables
 * (Issue #294, ADR-0031), declared once here and spread into `module.ts`'s two
 * arrays - the same shape and reasoning as `register-lifecycle.ts`. Pure data.
 *
 * ## Retention
 *
 * An expense is a fiscal record of money that left the business: five-year
 * floor, ten-year ceiling (the window the register tables and the payment
 * ledger use). Both tables are keyed on `deleted_at` like `commerce.orders`
 * and the register parents: this module never sets it (an expense is reversed
 * or cancelled, a category is deactivated), so the purge predicate can never
 * match - which is also what keeps the append-only register movements' foreign
 * key to an expense safe from a purge that would orphan them.
 *
 * ## Subject data
 *
 * The tables name STAFF (creators, posters, approvers) by tenant-user id stamps
 * and carry money plus tenant-typed free text. A payee name can be a person
 * (a market trader paid in cash), so it is a redacted column: never exported.
 */
import type {
  HighVolumeTableDescriptor,
  SubjectDataDescriptor
} from "../../_shared/module-contract";

const WINDOW = {
  retentionClass: "system_event",
  retentionMinDays: 1825,
  retentionMaxDays: 3650,
  defaultRetentionDays: 3650
} as const;

const NO_ARCHIVE = {
  archivable: false,
  rationale:
    "The generic engine's only implemented artefact is ordinary backup/restore; no standalone archive exists yet for this table."
} as const;

const NO_LEGAL_HOLD = {
  applicable: false,
  precedence: "not_applicable"
} as const;

const BACKUP_NOTES =
  "Included in ordinary full-database backup/restore; no standalone archive artifact. Restore the expense tables together with awcms_commerce_register_movements (the rows a posted drawer expense produced) and awcms_news_media_objects (the private receipts they point at).";

export const EXPENSE_DATA_LIFECYCLE: HighVolumeTableDescriptor[] = [
  {
    key: "commerce.expense_categories",
    tableName: "awcms_commerce_expense_categories",
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "deleted_at",
    ...WINDOW,
    partition: {
      eligible: false,
      rationale:
        "A tenant's expense categories are a handful of rows, bounded by its own chart of spending."
    },
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "Technically the generic engine's only mode, but practically UNREACHABLE: this module never soft-deletes a category (deleted_at stays NULL forever; a category is deactivated), and every expense keeps a foreign key to it - the same shape as commerce.registers."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "deleted_at"],
        purpose:
          "awcms_commerce_expense_categories_tenant_deleted_idx (sql/990) - the (tenant, cursor) composite the generic purge engine filters + orders by."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  },
  {
    key: "commerce.expenses",
    tableName: "awcms_commerce_expenses",
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "deleted_at",
    ...WINDOW,
    partition: {
      eligible: false,
      rationale:
        "A petty-cash expense row per spend - bounded by shop activity, nowhere near partition-worthy."
    },
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "Practically UNREACHABLE, like commerce.orders: this module never soft-deletes an expense (deleted_at stays NULL forever; an expense is reversed or cancelled), and the register movements it produced keep a foreign key to it. The fiscal retention this descriptor documents is enforced by never matching the purge predicate."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "deleted_at"],
        purpose:
          "awcms_commerce_expenses_tenant_deleted_idx (sql/990) - the (tenant, cursor) composite the generic purge engine filters + orders by."
      },
      {
        columns: ["tenant_id", "created_at"],
        purpose:
          "awcms_commerce_expenses_tenant_created_idx (sql/990) - the newest-first keyset history."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  }
];

const STAFF_RATIONALE =
  "It names STAFF only (creators, posters, approvers, as plain tenant-user uuid stamps) and carries money and tenant-typed free text - never a customer. It is a fiscal record of money that left the business, retained under the same obligation as commerce.orders and the register tables; a staff stamp resolves to nobody once identity_access.identities anonymises. Free-text descriptions, payee names and reasons are never exported.";

export const EXPENSE_SUBJECT_DATA: SubjectDataDescriptor[] = [
  {
    key: "commerce.expense_categories",
    tableName: "awcms_commerce_expense_categories",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "created_by_tenant_user_id", references: "tenant_user" },
      { column: "updated_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #294 - an expense category (code, name). ${STAFF_RATIONALE}`
  },
  {
    key: "commerce.expenses",
    tableName: "awcms_commerce_expenses",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "created_by_tenant_user_id", references: "tenant_user" },
      { column: "updated_by_tenant_user_id", references: "tenant_user" },
      { column: "submitted_by_tenant_user_id", references: "tenant_user" },
      { column: "decided_by_tenant_user_id", references: "tenant_user" },
      { column: "posted_by_tenant_user_id", references: "tenant_user" },
      { column: "reversed_by_tenant_user_id", references: "tenant_user" },
      { column: "cancelled_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #294 - one expense: amount, tender, date, a free-text reason, an optional free-text payee and a private receipt reference. ${STAFF_RATIONALE}`,
    redactedColumns: [
      "description",
      "payee_name",
      "decision_note",
      "reversal_reason"
    ]
  }
];
