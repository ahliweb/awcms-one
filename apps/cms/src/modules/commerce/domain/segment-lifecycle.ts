/**
 * `dataLifecycle` and `subjectData` descriptors for the two CRM segment tables
 * (Issue #360, ADR-0042), declared once here and spread into `module.ts`'s two
 * arrays - the same shape and reasoning as `expense-lifecycle.ts`. Pure data.
 *
 * ## Retention
 *
 * A segment definition carries no personal data - rules are a closed vocabulary
 * of typed scalars (levels, counts, money, instants), never free text and never
 * a customer. What makes a version worth keeping is that a past campaign or
 * loyalty earn records `(segment_id, version)` and must stay explainable
 * (control C-29), so the window is long: five-year floor, ten-year ceiling,
 * like the fiscal records the consumers sit beside.
 *
 * Both tables are keyed on `deleted_at`, which this module NEVER sets (a
 * segment is retired through `retired_at`; a version is immutable), so the
 * purge predicate can never match - the same "practically unreachable" shape
 * the register and expense tables use. That is also what keeps a referenced
 * version from ever being purged out from under a consumer.
 *
 * ## Subject data
 *
 * The tables name STAFF only (the creator of a segment or version, as plain
 * tenant-user uuid stamps) - never a customer: a segment stores no member.
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
  "Included in ordinary full-database backup/restore; no standalone archive artifact. Restore the segment head and its versions together: a version without its head is unreachable.";

export const SEGMENT_DATA_LIFECYCLE: HighVolumeTableDescriptor[] = [
  {
    key: "commerce.segments",
    tableName: "awcms_commerce_segments",
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "deleted_at",
    ...WINDOW,
    partition: {
      eligible: false,
      rationale:
        "A tenant defines a handful of segments; the table is bounded by marketing effort, nowhere near partition-worthy."
    },
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "Practically UNREACHABLE: this module never sets deleted_at (a segment is retired through retired_at), and every version keeps a foreign key to its head. A past consumer's (segment, version) must stay explainable, so the purge predicate never matches."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "deleted_at"],
        purpose:
          "awcms_commerce_segments_tenant_deleted_idx (sql/1001) - the (tenant, cursor) composite the generic purge engine filters + orders by."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  },
  {
    key: "commerce.segment_versions",
    tableName: "awcms_commerce_segment_versions",
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "deleted_at",
    ...WINDOW,
    partition: {
      eligible: false,
      rationale:
        "A handful of versions per segment, each a few hundred bytes of JSON - bounded by editing effort."
    },
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "Practically UNREACHABLE: a version is immutable and this module never sets deleted_at, so a version a past campaign or earn recorded is never purged (delete keeps referenced versions)."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "deleted_at"],
        purpose:
          "awcms_commerce_segment_versions_tenant_deleted_idx (sql/1001) - the (tenant, cursor) composite the generic purge engine filters + orders by."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  }
];

const STAFF_RATIONALE =
  "It names STAFF only (the author of a segment or a version, as plain tenant-user uuid stamps) and holds a closed-vocabulary rule tree of typed scalars - never a customer and never free text about one. A staff stamp resolves to nobody once identity_access.identities anonymises. Retained so a past campaign or earn that recorded (segment, version) stays explainable.";

export const SEGMENT_SUBJECT_DATA: SubjectDataDescriptor[] = [
  {
    key: "commerce.segments",
    tableName: "awcms_commerce_segments",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "created_by_tenant_user_id", references: "tenant_user" },
      { column: "updated_by_tenant_user_id", references: "tenant_user" },
      { column: "retired_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #360 - a CRM segment head: a name, a description and the latest version number. ${STAFF_RATIONALE}`
  },
  {
    key: "commerce.segment_versions",
    tableName: "awcms_commerce_segment_versions",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "created_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #360 - one immutable version of a segment's rules. ${STAFF_RATIONALE}`
  }
];
