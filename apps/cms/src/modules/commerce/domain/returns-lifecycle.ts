/**
 * `dataLifecycle` and `subjectData` descriptors for the four returns / refunds
 * tables (Issue #287, ADR-0033), declared once here and spread into
 * `module.ts`'s two arrays (the shape `stored-value-lifecycle.ts` set). Pure
 * data, no imports beyond types.
 *
 * ## Retention
 *
 * A refund is a fiscal record of money leaving the business, and a return is
 * the document that justifies it: five-year floor, ten-year ceiling, the
 * window `commerce.payment_allocations` uses (every refund settles as one of
 * those payment-ledger reversals). All four tables are append-only or
 * history-only and keyed on `created_at`; `awcms_app` has no DELETE on any of
 * them (`sql/994`'s REVOKE), only the retention worker does (`sql/997`).
 *
 * The honest consequence, recorded in ADR-0033: the refund and compensation
 * tables cascade from the payment allocation / return they hang off
 * (`ON DELETE CASCADE`, so a purge batch can never split a pair or trip a
 * foreign key), which means a refund of an order whose ORIGINAL payment is
 * older than the ceiling is purged with that payment even if the refund itself
 * is younger. A tenant that needs the refund kept longer keeps
 * `retentionMaxDays` above the longest return window it offers.
 *
 * ## Subject data
 *
 * The tables name STAFF (actor, offline approver) by tenant-user uuid stamps
 * and carry money, reasons and free-text notes. The customer of the order
 * reaches a person only through `commerce.customers`, which carries no
 * tenant-user / identity id (ADR-0016 D1), so no customer column is a subject
 * column here. Free-text notes are tenant-typed and never exported.
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
  "Included in ordinary full-database backup/restore; no standalone archive artifact. Restore the four returns/refunds tables together with awcms_commerce_payment_allocations (every settled refund is one of its reversal rows) and awcms_commerce_order_items (the lines a return points at).";

function table(
  key: string,
  tableName: string,
  rationale: string,
  indexName: string
): HighVolumeTableDescriptor {
  return {
    key,
    tableName,
    ownerModuleKey: "commerce",
    scope: "tenant",
    // Append-only / history-only - no `deleted_at`; the cursor is
    // `created_at` (the same exception commerce.order_events documents).
    cursorColumn: "created_at",
    ...WINDOW,
    partition: NO_PARTITION(
      "A handful of rows per return - bounded by shop activity; the (tenant, created_at) index serves the purge."
    ),
    archive: NO_ARCHIVE,
    deletion: { mode: "hard_delete", rationale },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "created_at"],
        purpose: `${indexName} (sql/994) - the (tenant, cursor) composite the generic purge engine filters + orders by.`
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  };
}

export const RETURNS_DATA_LIFECYCLE: HighVolumeTableDescriptor[] = [
  table(
    "commerce.returns",
    "awcms_commerce_returns",
    "The generic engine's only mode. Reachable only past the ten-year ceiling and only by the retention worker: awcms_app has no DELETE (sql/994's REVOKE) and a trigger freezes everything but the status and the one-time exchange link. Its lines, refunds and compensations cascade with it.",
    "awcms_commerce_returns_tenant_created_idx"
  ),
  table(
    "commerce.return_lines",
    "awcms_commerce_return_lines",
    "The generic engine's only mode. awcms_app has no UPDATE or DELETE (sql/994's REVOKE) and a trigger refuses every UPDATE, so the table is append-only for every runtime path.",
    "awcms_commerce_return_lines_tenant_created_idx"
  ),
  table(
    "commerce.refunds",
    "awcms_commerce_refunds",
    "The generic engine's only mode. awcms_app has no DELETE (sql/994's REVOKE); a settled refund never changes again. A refund cascades with the payment allocation it refunds (see this file's header for the consequence).",
    "awcms_commerce_refunds_tenant_created_idx"
  ),
  table(
    "commerce.refund_compensations",
    "awcms_commerce_refund_compensations",
    "The generic engine's only mode. awcms_app has no UPDATE or DELETE (sql/994's REVOKE) and a trigger refuses every UPDATE; rows cascade with the refund they belong to.",
    "awcms_commerce_refund_compensations_tenant_created_idx"
  )
];

const STAFF_RATIONALE =
  "It names STAFF only (actor / offline approver, as plain tenant-user uuid stamps) and carries money and reasons. It is a fiscal record of money leaving the business, retained under the same obligation as commerce.orders and commerce.payment_allocations; a staff stamp resolves to nobody once identity_access.identities anonymises. The order's customer is reachable only through commerce.customers (ADR-0016 D1), which carries no tenant-user/identity id.";

export const RETURNS_SUBJECT_DATA: SubjectDataDescriptor[] = [
  {
    key: "commerce.returns",
    tableName: "awcms_commerce_returns",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "actor_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #287 - one return or exchange of goods sold on an order: kind, status, the cents-exact goods/discount/shipping split and an optional free-text note. ${STAFF_RATIONALE}`,
    redactedColumns: ["note"]
  },
  {
    key: "commerce.return_lines",
    tableName: "awcms_commerce_return_lines",
    ownerModuleKey: "commerce",
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #287 - one returned order line: units, reason, stock disposition and value, plus an optional free-text note. It carries no person reference at all (the actor is on the parent return). ${STAFF_RATIONALE}`,
    redactedColumns: ["note"]
  },
  {
    key: "commerce.refunds",
    tableName: "awcms_commerce_refunds",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "actor_tenant_user_id", references: "tenant_user" },
      { column: "offline_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #287 - one refund leg along one original payment: amount, destination, settlement state, the provider reference and, for an offline settlement, the approver and the stated reason. ${STAFF_RATIONALE}`,
    redactedColumns: [
      "offline_reason",
      "provider_reference",
      "provider_refund_id"
    ]
  },
  {
    key: "commerce.refund_compensations",
    tableName: "awcms_commerce_refund_compensations",
    ownerModuleKey: "commerce",
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #287 - the append-only log of the downstream effects of a settled refund (points taken back, commission adjusted, store credit issued). Ids and amounts only; no person reference. ${STAFF_RATIONALE}`
  }
];
