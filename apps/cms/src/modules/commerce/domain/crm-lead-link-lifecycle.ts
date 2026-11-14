/**
 * `dataLifecycle` and `subjectData` descriptors for the CRM lead link table
 * (Issue #463, ADR-0056 D7), declared once here and spread into `module.ts`'s two
 * arrays - the same shape and reasoning as `customer-subject-lifecycle.ts`.
 * Pure data.
 *
 * ## Retention
 *
 * `awcms_commerce_crm_lead_links` is the evidence that commerce confirmed a
 * conversion on a verified fact and when, and the only handle a reversal has on
 * the CRM conversion it points at. It is `delegated` with no purge, kept for the
 * life of the tenant (an age-based delete would orphan a CRM conversion that
 * still stands, and a guard trigger refuses every delete anyway). The numbers the
 * descriptor declares are the class's bound and are never executed. One ~250-byte
 * row per confirmed conversion, made by hand by a person; the ceiling is the
 * number of conversions ever confirmed.
 *
 * ## Subject data
 *
 * The row carries three staff actor stamps (`linked_by_tenant_user_id`,
 * `reversal_actor_tenant_user_id`, `reversed_by_tenant_user_id`) - real
 * tenant-user subject columns that resolve to nobody once the identity
 * anonymises - and a `customer_id` the engine's vocabulary cannot reach (a
 * commerce customer is not a tenant user, ADR-0016 D1; the shopper's own
 * right is the commerce-owned flow of ADR-0055, whose registry lists this table
 * so the shopper's export names their links and the erasure leaves them in
 * place under the recorded basis). The `lead_id` is an opaque reference into
 * `crm_leads`, which owns the prospect and its own erasure (`/anonymize`); no
 * name, contact, note or stage of the prospect is stored here.
 */
import type {
  HighVolumeTableDescriptor,
  SubjectDataDescriptor
} from "../../_shared/module-contract";

export const CRM_LEAD_LINK_DATA_LIFECYCLE: HighVolumeTableDescriptor[] = [
  {
    key: "commerce.crm_lead_links",
    tableName: "awcms_commerce_crm_lead_links",
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "linked_at",
    retentionClass: "financial_tax",
    retentionMinDays: 1825,
    retentionMaxDays: 3650,
    defaultRetentionDays: 3650,
    partition: {
      eligible: false,
      rationale:
        "One narrow row per confirmed lead-to-customer conversion, made by a person; bounded by the number of conversions ever confirmed, never by traffic."
    },
    archive: {
      archivable: false,
      rationale:
        "Tiny evidence table; ordinary full-database backup/restore is the artefact."
    },
    deletion: {
      mode: "hard_delete",
      rationale:
        "No purge runs and no DELETE is possible (awcms_app is REVOKEd it and a guard trigger refuses it for every role): a link is the evidence of what commerce confirmed and the handle a reversal uses on the CRM conversion; an age-based delete would orphan a conversion that still stands (Issue #463, ADR-0056)."
    },
    legalHold: { applicable: false, precedence: "not_applicable" },
    requiredIndexes: [
      {
        columns: ["tenant_id", "linked_at", "id"],
        purpose:
          "awcms_commerce_crm_lead_links_tenant_linked_idx (sql/1068) - the list, newest first; nothing scans this table by age."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes:
      "Included in ordinary full-database backup/restore. Restore with awcms_commerce_customers and awcms_commerce_orders (composite foreign keys) and, when crm_leads is in use, with its tables from the same point in time: a link's lead and conversion ids are opaque references that mean something only against that restore point.",
    executionMode: "delegated",
    existingAdopter: {
      purgeFunctionRef:
        "none - retained for the life of the tenant; see ADR-0056 (commerce)",
      description:
        "There is deliberately no purge mechanism; this descriptor exists so the table answers the retention question on the record rather than by silence."
    }
  }
];

export const CRM_LEAD_LINK_SUBJECT_DATA: SubjectDataDescriptor[] = [
  {
    key: "commerce.crm_lead_links",
    tableName: "awcms_commerce_crm_lead_links",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "linked_by_tenant_user_id", references: "tenant_user" },
      { column: "reversal_actor_tenant_user_id", references: "tenant_user" },
      { column: "reversed_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale:
      "Issue #463 (ADR-0056) - the record that a CRM lead was confirmed as a commerce customer on a verified fact: opaque ids (lead, customer, order, conversion), an evidence kind, the lead's first source kind and touch id, a state and timestamps. It carries no name, contact, note or stage of the prospect. The three actor columns are staff stamps that resolve to nobody once identity_access.identities anonymises. The customer it concerns is reached through the commerce-owned subject-rights flow (ADR-0055): the shopper's export lists their links and the erasure keeps them, resolving to the anonymised customer, because a link is the handle a reversal needs on a CRM conversion that still stands. The prospect's own personal data lives in crm_leads, which erases it (anonymise) under its own permission. Kept with no purge mechanism; the 3650-day class ceiling of the lifecycle descriptor is a bound, not a schedule."
  }
];
