/**
 * `dataLifecycle` and `subjectData` descriptors for the two commission-attribution
 * tables (Issue #391, ADR-0046), declared once here and spread into `module.ts`'s
 * two arrays - the same shape and reasoning as `expense-lifecycle.ts`. Pure data.
 *
 * ## Retention
 *
 * Neither table is purged by age. They are `delegated` with no purge mechanism,
 * which answers the retention question on the record instead of by silence (the
 * pattern `hr_workforce` uses for the tables it keeps for the life of the
 * tenant): a generic age-based purge would delete the settings row and the LIVE
 * staff links of a tenant that configured them a long time ago and has not
 * touched them since - the healthy case - and would silently stop its staff
 * earning commission. A link is also the evidence of who was entitled to be paid
 * for a sale at the time, so a retired link is kept. Both tables are small and
 * human-authored; their ceiling is the number of staff the tenant has.
 *
 * ## Subject data
 *
 * A staff link joins a LOGIN (a data subject) to an opaque employment id. It
 * holds no name, contact, amount or rate. The login is a real subject column;
 * the table is not exportable (the employment id means nothing without the
 * `hr_workforce` record it points at, which that module exports), and is
 * retained under the employer's obligation to be able to explain who was paid
 * commission and why. The settings row names nobody but its last author.
 */
import type {
  HighVolumeTableDescriptor,
  SubjectDataDescriptor
} from "../../_shared/module-contract";

function retained(input: {
  key: string;
  tableName: string;
  why: string;
  deletionWhy: string;
  cursorColumn: string;
}): HighVolumeTableDescriptor {
  return {
    key: input.key,
    tableName: input.tableName,
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: input.cursorColumn,
    retentionClass: "financial_tax",
    retentionMinDays: 1825,
    retentionMaxDays: 3650,
    defaultRetentionDays: 3650,
    partition: { eligible: false, rationale: input.why },
    archive: {
      archivable: false,
      rationale:
        "Tiny, human-authored configuration; ordinary full-database backup/restore is the artefact."
    },
    deletion: { mode: "hard_delete", rationale: input.deletionWhy },
    legalHold: { applicable: false, precedence: "not_applicable" },
    requiredIndexes: [
      {
        columns: ["tenant_id"],
        purpose:
          "Leading column of the table's primary key / tenant indexes (sql/1030); nothing scans this table by age."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes:
      "Included in ordinary full-database backup/restore. Restore with the hr_workforce and hr_commission tables from the same point in time: a link's employment id and the accruals made under it must come back together.",
    executionMode: "delegated",
    existingAdopter: {
      purgeFunctionRef:
        "none - retained for the life of the tenant; see ADR-0046 (commerce) and ADR-0132 section 13.2 (hr_commission)",
      description:
        "There is deliberately no purge mechanism; this descriptor exists so the table answers the retention question on the record rather than by silence."
    }
  };
}

export const COMMISSION_DATA_LIFECYCLE: HighVolumeTableDescriptor[] = [
  retained({
    key: "commerce.commission_settings",
    tableName: "awcms_commerce_commission_settings",
    cursorColumn: "updated_at",
    why: "At most one row per tenant (primary key, sql/1030) - bounded by awcms_tenants.",
    deletionWhy:
      "No purge runs. An age-based delete would remove the settings of a tenant that configured commission attribution long ago and has not touched it since (the healthy case), silently stopping every staff member earning commission."
  }),
  retained({
    key: "commerce.commission_staff_links",
    tableName: "awcms_commerce_commission_staff_links",
    cursorColumn: "created_at",
    why: "Bounded by the number of staff a tenant links (a login has at most one LIVE link and a retired link is kept as history) - authored by an administrator, never by traffic.",
    deletionWhy:
      "No purge runs and no DELETE is possible (awcms_app is REVOKEd it and a trigger refuses it for every role): a link is retired, never deleted, because it is the evidence of who was entitled to commission on a sale at the time."
  })
];

export const COMMISSION_SUBJECT_DATA: SubjectDataDescriptor[] = [
  {
    key: "commerce.commission_settings",
    tableName: "awcms_commerce_commission_settings",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "updated_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale:
      "Issue #391 - one row per tenant: whether commission attribution is on, which hr_commission rule key it applies and the source type that rule declares. The tenant's own business configuration; names nobody but its last author, as a plain tenant-user uuid stamp that resolves to nobody once identity_access.identities anonymises. The change history lives in the audit log."
  },
  {
    key: "commerce.commission_staff_links",
    tableName: "awcms_commerce_commission_staff_links",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "tenant_user_id", references: "tenant_user" },
      { column: "created_by_tenant_user_id", references: "tenant_user" },
      { column: "retired_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale:
      "Issue #391 - which login's counter sales are credited to which employment: two uuids and two actor stamps, no name, contact, amount or rate. The employment id is OPAQUE here (no foreign key, no read of hr_workforce) and is only meaningful with the hr_workforce record it points at, which that module owns and exports; so this table is not exported on its own. Retained, never deleted (a link is retired), because it is the evidence of who was entitled to be paid commission on a sale at the time; after anonymisation the login resolves to nobody and the link remains an explainable fact about an employment."
  }
];
