/**
 * `dataLifecycle` and `subjectData` descriptors for the three closed-loop
 * stored-value tables (Issue #288, ADR-0029), declared once here and spread
 * into `module.ts`'s two arrays (the shape `register-lifecycle.ts` set).
 * Pure data, no imports beyond types.
 *
 * ## Retention
 *
 * A gift card / store credit is a LIABILITY and its ledger a fiscal record:
 * five-year floor, ten-year ceiling (the window `commerce.payment_allocations`
 * uses, because every redemption is one of those payments). The parents
 * (`programs`, `accounts`) are keyed on `deleted_at`, which `sql/980`'s guard
 * trigger FORBIDS ever setting - so the purge predicate can never match a live
 * liability, the same "unreachable by construction" shape `commerce.orders`
 * and the register parents use. The ledger is append-only and keyed on
 * `created_at`; `awcms_app` has no DELETE on any of the three, only the
 * retention worker does (`sql/983`).
 *
 * The honest consequence, recorded in ADR-0029: a ledger row past the ceiling
 * is deleted even when its account still holds a balance (a card unspent for
 * ten years), after which that account no longer sums to its projection and
 * reconcile reports it. Ten years makes that a deliberate operator choice
 * (a tenant that wants it never to happen keeps `retentionMaxDays` above the
 * longest expiry it issues, or sets accounts to expire).
 *
 * ## Subject data
 *
 * The tables name STAFF (issuer, actor) by tenant-user id stamps and carry
 * money. The owning CUSTOMER of an account (`customer_id`, optional) reaches a
 * person only through `commerce.customers`, which carries no tenant-user /
 * identity id (ADR-0016 D1), so it is not a subject column here. The redeemable
 * code is never stored (only its hash and last four), and free-text reasons are
 * tenant-typed and never exported.
 */
import type {
  HighVolumeTableDescriptor,
  SubjectDataDescriptor
} from "../../_shared/module-contract";

const WINDOW = {
  retentionClass: "financial_tax",
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
  "Included in ordinary full-database backup/restore; no standalone archive artifact. Restore the three stored-value tables together with awcms_commerce_payment_allocations (the legs every redemption/refund entry mirrors) - the ledger is the source of truth for an account's balance (balance/version are a projection of it).";

export const STORED_VALUE_DATA_LIFECYCLE: HighVolumeTableDescriptor[] = [
  {
    key: "commerce.stored_value_programs",
    tableName: "awcms_commerce_stored_value_programs",
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "deleted_at",
    ...WINDOW,
    partition: NO_PARTITION(
      "At most two rows per tenant (one per kind) - configuration, not volume."
    ),
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "Technically the generic engine's only mode, but practically UNREACHABLE: a program is configured, never soft-deleted (deleted_at stays NULL forever - sql/980's guard forbids setting it), and every account keeps a foreign key to it."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "deleted_at"],
        purpose:
          "awcms_commerce_stored_value_programs_tenant_deleted_idx (sql/980) - the (tenant, cursor) composite the generic purge engine filters + orders by."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  },
  {
    key: "commerce.stored_value_accounts",
    tableName: "awcms_commerce_stored_value_accounts",
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "deleted_at",
    ...WINDOW,
    partition: NO_PARTITION(
      "One row per issued card/credit - bounded by what a shop sells, nowhere near partition-worthy."
    ),
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "Practically UNREACHABLE, like commerce.orders: an account is never soft-deleted (deleted_at stays NULL forever - sql/980's guard forbids setting it; an account is disabled or expires), and its ledger, payment legs keep foreign keys to it. A live liability can therefore never match the purge predicate."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "deleted_at"],
        purpose:
          "awcms_commerce_stored_value_accounts_tenant_deleted_idx (sql/980) - the (tenant, cursor) composite the generic purge engine filters + orders by."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  },
  {
    key: "commerce.stored_value_ledger",
    tableName: "awcms_commerce_stored_value_ledger",
    ownerModuleKey: "commerce",
    scope: "tenant",
    // Append-only - no `deleted_at`, the cursor is `created_at` (the same
    // exception commerce.order_events documents).
    cursorColumn: "created_at",
    ...WINDOW,
    partition: NO_PARTITION(
      "A few rows per card over its life - bounded by shop activity; the (tenant, created_at) index serves the purge and the report."
    ),
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "The generic engine's only mode. Reachable only past the ten-year ceiling and only by the retention worker: awcms_app has no UPDATE or DELETE (sql/980's REVOKE) and a trigger forbids every UPDATE, so the table is append-only for every runtime path. A row past the ceiling is deleted even if its account still holds a balance (ADR-0029 records the consequence: reconcile then reports that account)."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "created_at"],
        purpose:
          "awcms_commerce_stored_value_ledger_tenant_created_idx (sql/980) - the (tenant, cursor) composite the generic purge engine filters + orders by, and the liability report's range scan."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  }
];

const STAFF_RATIONALE =
  "It names STAFF only (issuer/actor, as plain tenant-user uuid stamps) and carries money - the redeemable code is never stored (only its tenant-scoped hash and last four characters) and free-text reasons are never exported. It is a fiscal record of a liability, retained under the same obligation as commerce.orders and commerce.payment_allocations; a staff stamp resolves to nobody once identity_access.identities anonymises.";

export const STORED_VALUE_SUBJECT_DATA: SubjectDataDescriptor[] = [
  {
    key: "commerce.stored_value_programs",
    tableName: "awcms_commerce_stored_value_programs",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "updated_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #288 - per-tenant configuration of a kind of stored value (enabled, expiry, refund policy, ceiling). ${STAFF_RATIONALE}`
  },
  {
    key: "commerce.stored_value_accounts",
    tableName: "awcms_commerce_stored_value_accounts",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "issued_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #288 - one gift card / store credit: kind, status, projected balance, expiry, an optional customer reference (reachable only through commerce.customers, which carries no tenant-user/identity id - ADR-0016 D1) and the masked code. ${STAFF_RATIONALE}`,
    redactedColumns: ["code_hash"]
  },
  {
    key: "commerce.stored_value_ledger",
    tableName: "awcms_commerce_stored_value_ledger",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "actor_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #288 - one signed liability entry (issue, load, redeem, refund, adjust, expire, disable, enable) with its running balance and an optional free-text reason. ${STAFF_RATIONALE}`,
    redactedColumns: ["reason"]
  }
];
