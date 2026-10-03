/**
 * `dataLifecycle` and `subjectData` descriptors for the six POS register
 * tables (Issue #284, ADR-0028), declared once here and spread into
 * `module.ts`'s two arrays - six near-identical 40-line literals would be six
 * places to forget one field. Pure data, no imports beyond types.
 *
 * ## Retention
 *
 * Every row is a fiscal record of a cash shift: five-year floor, ten-year
 * ceiling (the same window `commerce.payment_allocations` uses, because a
 * cash-up is the reconciliation of those payments). The two parent tables
 * (`registers`, `sessions`) are keyed on `deleted_at` like
 * `commerce.orders`: this module never sets it (a register is deactivated, a
 * session is closed), so the purge predicate can never match them - the same
 * "unreachable by construction" shape, which is what keeps the append-only
 * children's foreign keys safe from a purge that would orphan them. The four
 * append-only tables key on `created_at`; `awcms_app` has no DELETE on any of
 * them (`sql/970`'s REVOKEs), only the retention worker does (`sql/973`).
 *
 * ## Subject data
 *
 * The tables name STAFF (cashiers, approvers) by tenant-user id stamps and
 * carry money - never a customer. Staff stamps are subject columns
 * (`tenant_user`); the rows are retained under the fiscal obligation, like
 * `commerce.orders`' own cashier stamp.
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

const NO_PARTITION = (rationale: string) =>
  ({ eligible: false, rationale }) as const;

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
  "Included in ordinary full-database backup/restore; no standalone archive artifact. Restore the six register tables together with awcms_commerce_orders and awcms_commerce_payment_allocations (the stamped legs a cash-up sums).";

export const REGISTER_DATA_LIFECYCLE: HighVolumeTableDescriptor[] = [
  {
    key: "commerce.registers",
    tableName: "awcms_commerce_registers",
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "deleted_at",
    ...WINDOW,
    partition: NO_PARTITION(
      "A tenant's tills are a handful of rows, bounded by its own shop floor."
    ),
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "Technically the generic engine's only mode, but practically UNREACHABLE: this module never soft-deletes a register (deleted_at stays NULL forever; a register is deactivated), and every session keeps a foreign key to it - the same shape as commerce.orders."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "deleted_at"],
        purpose:
          "awcms_commerce_registers_tenant_deleted_idx (sql/970) - the (tenant, cursor) composite the generic purge engine filters + orders by."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  },
  {
    key: "commerce.register_sessions",
    tableName: "awcms_commerce_register_sessions",
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "deleted_at",
    ...WINDOW,
    partition: NO_PARTITION(
      "One row per shift per register - bounded by shop opening hours, nowhere near partition-worthy."
    ),
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "Practically UNREACHABLE, like commerce.orders: this module never soft-deletes a session (deleted_at stays NULL forever; a session is closed, then at most corrected), and orders, ledger legs, movements and close requests keep foreign keys to it. The fiscal retention this descriptor documents is enforced by never matching the purge predicate."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "deleted_at"],
        purpose:
          "awcms_commerce_register_sessions_tenant_deleted_idx (sql/970) - the (tenant, cursor) composite the generic purge engine filters + orders by."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  },
  {
    key: "commerce.register_movements",
    tableName: "awcms_commerce_register_movements",
    ownerModuleKey: "commerce",
    scope: "tenant",
    // Append-only - no `deleted_at`, the cursor is `created_at` (the same
    // exception commerce.order_events documents).
    cursorColumn: "created_at",
    ...WINDOW,
    partition: NO_PARTITION(
      "A handful of drawer movements per shift - bounded by shop activity."
    ),
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "The generic engine's only mode. Reachable only past the ten-year ceiling and only by the retention worker: awcms_app has no DELETE (sql/970's REVOKE) and a trigger forbids every UPDATE, so the table is append-only for every runtime path."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "created_at"],
        purpose:
          "awcms_commerce_register_movements_tenant_created_idx (sql/970) - the (tenant, cursor) composite the generic purge engine filters + orders by."
      },
      {
        columns: ["tenant_id", "session_id", "created_at"],
        purpose:
          "awcms_commerce_register_movements_tenant_session_idx (sql/970) - a session's own movement read and expected-total sum."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  },
  {
    key: "commerce.register_close_requests",
    tableName: "awcms_commerce_register_close_requests",
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "created_at",
    ...WINDOW,
    partition: NO_PARTITION(
      "One row per close attempt of a shift - bounded by shop opening hours."
    ),
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "The generic engine's only mode. Reachable only past the ten-year ceiling and only by the retention worker; the only legal UPDATE is the pending -> approved/rejected decision (sql/970's trigger) and awcms_app has no DELETE. Deleting a request cascades to its close lines (an FK ON DELETE CASCADE, so a purge can never orphan them)."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "created_at"],
        purpose:
          "awcms_commerce_register_close_requests_tenant_created_idx (sql/970) - the (tenant, cursor) composite the generic purge engine filters + orders by, and the pending-approvals scan."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  },
  {
    key: "commerce.register_close_lines",
    tableName: "awcms_commerce_register_close_lines",
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "created_at",
    ...WINDOW,
    partition: NO_PARTITION(
      "At most one row per tender per close attempt - a handful per shift."
    ),
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "The generic engine's only mode, past the ten-year ceiling and only by the retention worker; a trigger forbids every UPDATE and awcms_app has no DELETE."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "created_at"],
        purpose:
          "awcms_commerce_register_close_lines_tenant_created_idx (sql/970) - the (tenant, cursor) composite the generic purge engine filters + orders by."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  },
  {
    key: "commerce.register_corrections",
    tableName: "awcms_commerce_register_corrections",
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "created_at",
    ...WINDOW,
    partition: NO_PARTITION(
      "Rare, supervisor-only amendments - nowhere near partition-worthy."
    ),
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "The generic engine's only mode, past the ten-year ceiling and only by the retention worker; a trigger forbids every UPDATE and awcms_app has no DELETE."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "created_at"],
        purpose:
          "awcms_commerce_register_corrections_tenant_created_idx (sql/970) - the (tenant, cursor) composite the generic purge engine filters + orders by."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  }
];

const STAFF_RATIONALE =
  "It names STAFF only (cashiers/approvers, as plain tenant-user uuid stamps) and carries money and a shift's reconciliation - never a customer. It is a fiscal record of a cash shift, retained under the same obligation as commerce.orders and commerce.payment_allocations; a staff stamp resolves to nobody once identity_access.identities anonymises. Free-text reasons/notes are tenant-typed and are never exported.";

export const REGISTER_SUBJECT_DATA: SubjectDataDescriptor[] = [
  {
    key: "commerce.registers",
    tableName: "awcms_commerce_registers",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "created_by_tenant_user_id", references: "tenant_user" },
      { column: "updated_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #284 - a till definition (code, name, location label). ${STAFF_RATIONALE}`
  },
  {
    key: "commerce.register_sessions",
    tableName: "awcms_commerce_register_sessions",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "opened_by_tenant_user_id", references: "tenant_user" },
      { column: "current_cashier_tenant_user_id", references: "tenant_user" },
      { column: "closed_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #284 - one cash shift: opening float, status, who opened/ran/closed it. ${STAFF_RATIONALE}`
  },
  {
    key: "commerce.register_movements",
    tableName: "awcms_commerce_register_movements",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "actor_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #284 - a drawer movement (type, direction, amount, a free-text reference and note). ${STAFF_RATIONALE}`,
    redactedColumns: ["reference", "note"]
  },
  {
    key: "commerce.register_close_requests",
    tableName: "awcms_commerce_register_close_requests",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "requested_by_tenant_user_id", references: "tenant_user" },
      { column: "decided_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #284 - a cash-up attempt: variance, threshold, the variance reason, the approval decision. ${STAFF_RATIONALE}`,
    redactedColumns: ["variance_reason", "decision_note"]
  },
  {
    key: "commerce.register_close_lines",
    tableName: "awcms_commerce_register_close_lines",
    ownerModuleKey: "commerce",
    unreachableBySubject: true,
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale:
      "Issue #284 - the per-tender expected/counted/variance snapshot of one close request. It carries no person at all (the staff stamps live on its close request); it inherits that table's fiscal-record retention."
  },
  {
    key: "commerce.register_corrections",
    tableName: "awcms_commerce_register_corrections",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "actor_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #284 - a compensating correction to a closed shift (tender, signed adjustment, a free-text reason). ${STAFF_RATIONALE}`,
    redactedColumns: ["reason"]
  }
];
