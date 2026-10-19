/**
 * `dataLifecycle` and `subjectData` descriptors for the six booking-commerce
 * adapter tables (Issue #378, ADR-0045; `sql/1035`-`sql/1038`), declared once
 * here and spread into `module.ts`'s two arrays - the same shape and reasoning
 * as `segment-lifecycle.ts` and `returns-lifecycle.ts`. A later adapter issue
 * that adds a table appends to THIS file, never to `module.ts`. Pure data.
 *
 * ## Every table has an `id`
 *
 * The generic purge deletes `WHERE id IN (SELECT id ... LIMIT n)` (the lesson of
 * `sql/1034`), so every table below has a surrogate `id` primary key.
 *
 * ## Retention
 *
 * - The link, deposit-policy and cancellation-policy tables carry no personal
 *   data and no money amounts of their own; they are the explanation of what was
 *   sold as what and under which rules. Five-year floor, ten-year ceiling
 *   (`system_event`, the segment tables' window). Their cursor is `deleted_at`,
 *   which this module NEVER sets (a link is unlinked, a policy retired, through
 *   a status), so the purge predicate can never match a live row and a referenced
 *   policy version or link is never purged out from under a decision.
 * - The refund decision is a fiscal record of why money left the business
 *   (`financial_tax`, like `commerce.refunds`): five-year floor, ten-year
 *   ceiling, append-only, cursor `created_at`, no DELETE for the application
 *   role (`sql/1038`), only the retention worker (`sql/1040`).
 *
 * ## Subject data
 *
 * No adapter table stores a customer (finding X7): the customer of a reservation
 * is derived through the order its active link points to, and reaches a person
 * only through `commerce.customers`, which carries no tenant-user / identity id
 * (ADR-0016 D1). Only the refund decision names STAFF, by tenant-user uuid
 * (the actor and the override actor), and carries one staff-authored reason.
 */
import type {
  HighVolumeTableDescriptor,
  SubjectDataDescriptor
} from "../../_shared/module-contract";

const SYSTEM_WINDOW = {
  retentionClass: "system_event",
  retentionMinDays: 1825,
  retentionMaxDays: 3650,
  defaultRetentionDays: 3650
} as const;

const FINANCIAL_WINDOW = {
  retentionClass: "financial_tax",
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
  "Included in ordinary full-database backup/restore; no standalone archive artifact. Restore the adapter tables together with awcms_booking_reservations and awcms_booking_service_offerings (the rows the links point at), awcms_commerce_orders and awcms_commerce_order_items.";

function deletedAtTable(
  key: string,
  tableName: string,
  indexName: string,
  deletionRationale: string,
  partitionRationale: string
): HighVolumeTableDescriptor {
  return {
    key,
    tableName,
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "deleted_at",
    ...SYSTEM_WINDOW,
    partition: { eligible: false, rationale: partitionRationale },
    archive: NO_ARCHIVE,
    deletion: { mode: "hard_delete", rationale: deletionRationale },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "deleted_at"],
        purpose: `${indexName} - the (tenant, cursor) composite the generic purge engine filters + orders by.`
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  };
}

export const BOOKING_ADAPTER_DATA_LIFECYCLE: HighVolumeTableDescriptor[] = [
  deletedAtTable(
    "commerce.booking_offering_links",
    "awcms_commerce_booking_offering_links",
    "awcms_commerce_booking_offering_links_tenant_deleted_idx (sql/1035)",
    "Practically UNREACHABLE: this module never sets deleted_at (an unlink is a status change), so the purge predicate never matches and a link a reservation link points at is never purged.",
    "A tenant links a handful of offerings; the table is bounded by catalogue effort."
  ),
  deletedAtTable(
    "commerce.booking_offering_link_resources",
    "awcms_commerce_booking_offering_link_resources",
    "awcms_commerce_booking_offering_link_resources_tenant_deleted_idx (sql/1050)",
    "Practically UNREACHABLE: this module never sets deleted_at (the rows are written once with the link and awcms_app has neither UPDATE nor DELETE), so the purge predicate never matches and a binding a sold reservation was made from is never purged.",
    "At most ten rows per offering link; bounded by catalogue effort."
  ),
  deletedAtTable(
    "commerce.booking_reservation_links",
    "awcms_commerce_booking_reservation_links",
    "awcms_commerce_booking_reservation_links_tenant_deleted_idx (sql/1035)",
    "Practically UNREACHABLE: this module never sets deleted_at (a link is superseded or released through a status), so the purge predicate never matches and a link a refund decision points at is never purged.",
    "One row per booking sold; bounded by the shop's booking volume and read through (tenant, order) indexes."
  ),
  deletedAtTable(
    "commerce.product_deposit_policies",
    "awcms_commerce_product_deposit_policies",
    "awcms_commerce_product_deposit_policies_tenant_deleted_idx (sql/1036)",
    "Practically UNREACHABLE: this module never sets deleted_at (a policy is retired through retired_at), so the purge predicate never matches.",
    "At most a few rows per product; bounded by catalogue effort."
  ),
  deletedAtTable(
    "commerce.cancellation_policies",
    "awcms_commerce_cancellation_policies",
    "awcms_commerce_cancellation_policies_tenant_deleted_idx (sql/1037)",
    "Practically UNREACHABLE: this module never sets deleted_at (a version is retired through a status), so a version a past refund decision names is never purged.",
    "A handful of versions per product; bounded by editing effort."
  ),
  deletedAtTable(
    "commerce.cancellation_policy_windows",
    "awcms_commerce_cancellation_policy_windows",
    "awcms_commerce_cancellation_policy_windows_tenant_deleted_idx (sql/1037)",
    "Practically UNREACHABLE: windows are immutable and this module never sets deleted_at, so the rules a past decision applied are never purged.",
    "A handful of windows per policy version; bounded by editing effort."
  ),
  {
    key: "commerce.booking_refund_decisions",
    tableName: "awcms_commerce_booking_refund_decisions",
    ownerModuleKey: "commerce",
    scope: "tenant",
    // Append-only - no `deleted_at`; the cursor is `created_at` (the exception
    // commerce.returns documents).
    cursorColumn: "created_at",
    ...FINANCIAL_WINDOW,
    partition: {
      eligible: false,
      rationale:
        "One row per cancelled or no-show booking; bounded by the shop's cancellation volume, and the (tenant, created_at) index serves the purge."
    },
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "Reachable only past the ten-year ceiling and only by the retention worker: awcms_app has no DELETE and a trigger freezes every column but the one-time return link (sql/1038)."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "created_at"],
        purpose:
          "awcms_commerce_booking_refund_decisions_tenant_created_idx (sql/1038) - the (tenant, cursor) composite the generic purge engine filters + orders by."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  }
];

const NO_PERSON_RATIONALE =
  "It stores identifiers, closed codes and money-free rule data only - no customer, no name, no contact, no free text about a person (finding X7: the customer is derived through the order and stored nowhere in the adapter). The order's customer reaches a person only through commerce.customers (ADR-0016 D1).";

export const BOOKING_ADAPTER_SUBJECT_DATA: SubjectDataDescriptor[] = [
  {
    key: "commerce.booking_offering_links",
    tableName: "awcms_commerce_booking_offering_links",
    ownerModuleKey: "commerce",
    unreachableBySubject: true,
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #378 - which Booking offering is sold as which service product. ${NO_PERSON_RATIONALE}`
  },
  {
    key: "commerce.booking_offering_link_resources",
    tableName: "awcms_commerce_booking_offering_link_resources",
    ownerModuleKey: "commerce",
    unreachableBySubject: true,
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #437 - which Booking resource(s) an offering link sells. ${NO_PERSON_RATIONALE}`
  },
  {
    key: "commerce.booking_reservation_links",
    tableName: "awcms_commerce_booking_reservation_links",
    ownerModuleKey: "commerce",
    unreachableBySubject: true,
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #378 - which Booking reservation was sold on which order line, with a lifecycle flag, an attention flag and a keyed hash of the creating request. ${NO_PERSON_RATIONALE}`
  },
  {
    key: "commerce.product_deposit_policies",
    tableName: "awcms_commerce_product_deposit_policies",
    ownerModuleKey: "commerce",
    unreachableBySubject: true,
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #378 - a product's deposit rule (a percent or a fixed amount per unit). ${NO_PERSON_RATIONALE}`
  },
  {
    key: "commerce.cancellation_policies",
    tableName: "awcms_commerce_cancellation_policies",
    ownerModuleKey: "commerce",
    unreachableBySubject: true,
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #378 - a versioned cancellation refund policy head. ${NO_PERSON_RATIONALE}`
  },
  {
    key: "commerce.cancellation_policy_windows",
    tableName: "awcms_commerce_cancellation_policy_windows",
    ownerModuleKey: "commerce",
    unreachableBySubject: true,
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #378 - one notice window of a cancellation policy version. ${NO_PERSON_RATIONALE}`
  },
  {
    key: "commerce.booking_refund_decisions",
    tableName: "awcms_commerce_booking_refund_decisions",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "actor_tenant_user_id", references: "tenant_user" },
      { column: "override_actor_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale:
      "Issue #378 - the append-only record of a booking cancellation's refund: the policy version applied, the computed and final amounts and, for an override, the staff approver, the step-up time and a staff-authored reason. It names STAFF only (as plain tenant-user uuid stamps); a customer cancel stores no customer id (X7). A fiscal record of money leaving the business, retained under the same obligation as commerce.refunds; a staff stamp resolves to nobody once identity_access.identities anonymises.",
    redactedColumns: ["override_reason"]
  }
];
