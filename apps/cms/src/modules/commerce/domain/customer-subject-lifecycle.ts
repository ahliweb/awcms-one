/**
 * `dataLifecycle` and `subjectData` descriptors for the shopper data-subject
 * request table (Issue #529, ADR-0055), plus the helper that points every other
 * customer-keyed commerce descriptor at the flow that actually answers it.
 *
 * ## Retention
 *
 * `awcms_commerce_customer_subject_requests` is evidence of what a shopper asked
 * for and what the store did, so it is `delegated` with no purge, kept for the
 * life of the tenant (the pattern `commission-lifecycle.ts` uses). One narrow row
 * per request; the ceiling is the number of requests ever made, which a person
 * makes by hand. A guard trigger refuses every delete and every change to a
 * decided row, so a purge could not run even if one were written.
 *
 * ## Subject data
 *
 * The row carries two staff actor stamps (`requested_by_tenant_user_id`,
 * `decided_by_tenant_user_id`) - real tenant-user subject columns - and a
 * `customer_id` the engine's vocabulary cannot reach. It is not exportable
 * (an export of the requester's own staff history is not what a data-subject
 * export is), and it is retained under the obligation to be able to show that a
 * shopper's request was honoured.
 *
 * ## `withCommerceSubjectFlow`
 *
 * The upstream engine cannot bind a commerce customer (ADR-0055 D1), so every
 * customer-keyed commerce descriptor keeps `unreachableBySubject`. Its rationale
 * used to say only that. This helper appends, for each descriptor whose table is
 * in `domain/customer-subject-data.ts`, the one sentence that says what the
 * commerce-owned flow does to that table - single-sourced from the registry, so
 * the rationale cannot drift from what the export and the erasure really do.
 */
import type {
  HighVolumeTableDescriptor,
  SubjectDataDescriptor
} from "../../_shared/module-contract";
import { SUBJECT_TABLES } from "./customer-subject-data";

export const CUSTOMER_SUBJECT_DATA_LIFECYCLE: HighVolumeTableDescriptor[] = [
  {
    key: "commerce.customer_subject_requests",
    tableName: "awcms_commerce_customer_subject_requests",
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "created_at",
    retentionClass: "financial_tax",
    retentionMinDays: 1825,
    retentionMaxDays: 3650,
    defaultRetentionDays: 3650,
    partition: {
      eligible: false,
      rationale:
        "One narrow row per data-subject request, written by a person or a shopper by hand; bounded by the number of requests ever made, never by traffic."
    },
    archive: {
      archivable: false,
      rationale:
        "Tiny evidence table; ordinary full-database backup/restore is the artefact."
    },
    deletion: {
      mode: "hard_delete",
      rationale:
        "No purge runs and no DELETE is possible (awcms_app is REVOKEd it and a guard trigger refuses it for every role): a request row is the evidence that a shopper's right was honoured and what the erasure left in place (Issue #529, ADR-0055)."
    },
    legalHold: { applicable: false, precedence: "not_applicable" },
    requiredIndexes: [
      {
        columns: ["tenant_id", "created_at", "id"],
        purpose:
          "awcms_commerce_customer_subject_requests_tenant_created_idx (sql/1065) - the admin list, newest first; nothing scans this table by age."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes:
      "Included in ordinary full-database backup/restore. Restore with awcms_commerce_customers: a request's customer_id is a foreign key to the (anonymised, never deleted) customer.",
    executionMode: "delegated",
    existingAdopter: {
      purgeFunctionRef:
        "none - retained for the life of the tenant; see ADR-0055 (commerce)",
      description:
        "There is deliberately no purge mechanism; this descriptor exists so the table answers the retention question on the record rather than by silence."
    }
  }
];

export const CUSTOMER_SUBJECT_DATA: SubjectDataDescriptor[] = [
  {
    key: "commerce.customer_subject_requests",
    tableName: "awcms_commerce_customer_subject_requests",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "requested_by_tenant_user_id", references: "tenant_user" },
      { column: "decided_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale:
      "Issue #529 (ADR-0055) - the evidence row of a shopper's export or erasure request: a request type, a surface, a status, a refusal code, counts and the retained summary. It carries no name, contact, bundle or token. The two actor columns are staff stamps that resolve to nobody once identity_access.identities anonymises; the customer it concerns is reached through the commerce-owned subject-rights flow (and appears in that customer's own export). Retained for the life of the tenant: it is how the store shows a request was honoured."
  }
];

const FAMILY_TEXT: Record<string, string> = {
  delete:
    "The commerce-owned subject-rights flow (ADR-0055, Issue #529) DELETES these rows on an erasure and exports them on an access request.",
  anonymize:
    "The commerce-owned subject-rights flow (ADR-0055, Issue #529) ANONYMISES the named columns of these rows on an erasure (per-row-unique sentinels) and exports them on an access request.",
  retain:
    "The commerce-owned subject-rights flow (ADR-0055, Issue #529) RETAINS these rows through an erasure under the recorded bookkeeping basis (they resolve to the anonymised customer) and exports them on an access request.",
  handled_by:
    "The commerce-owned subject-rights flow (ADR-0055, Issue #529) erases and exports these rows through the push data functions (application/customer-push-erasure.ts)."
};

const NOT_EXPORTED_TEXT =
  " The rows are not disclosed in the bundle (they name staff or an opaque employment, not the shopper).";

const byTable = new Map(SUBJECT_TABLES.map((entry) => [entry.table, entry]));

/**
 * Appends the flow sentence to the rationale of every descriptor whose table the
 * registry covers. Descriptors for other tables pass through unchanged, and a
 * rationale is never appended to twice.
 */
export function withCommerceSubjectFlow(
  descriptors: SubjectDataDescriptor[]
): SubjectDataDescriptor[] {
  return descriptors.map((descriptor) => {
    const entry = byTable.get(descriptor.tableName);
    if (!entry || descriptor.rationale.includes("ADR-0055")) return descriptor;
    const text =
      FAMILY_TEXT[entry.erasure.action] +
      (entry.exported ? "" : NOT_EXPORTED_TEXT);
    return { ...descriptor, rationale: `${descriptor.rationale} ${text}` };
  });
}
