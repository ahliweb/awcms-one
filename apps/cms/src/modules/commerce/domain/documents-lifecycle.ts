/**
 * `dataLifecycle` and `subjectData` descriptors for the commerce document
 * tables (Issue #286, ADR-0029), declared once here and spread into
 * `module.ts`'s two arrays. Pure data, no imports beyond types.
 *
 * ## Retention
 *
 * - `commerce.documents` (receipts/invoices) are tax-relevant commercial
 *   records: `financial_tax`, five-year floor, ten-year ceiling (the window
 *   `commerce.orders` uses). Cursor `created_at`; `awcms_app` has no DELETE and
 *   a trigger forbids UPDATE, so only the retention worker, past the ceiling,
 *   can remove one.
 * - Quotations, their versions and work orders are commercial records that
 *   back disputes and warranty claims: one-year floor, ten-year ceiling. The
 *   two mutable parents and the versions (referenced by a work order's
 *   provenance FK) are keyed on a `deleted_at` that is never set - practically
 *   unreachable, exactly `commerce.orders`' / `sql/970`'s shape, which keeps
 *   every foreign key safe from a purge that would orphan it.
 * - Work-order events key on `created_at`; their parent is unreachable, so the
 *   events can purge freely at the ceiling.
 * - Held sales are transient by nature (a parked cart, wiped on resume): a
 *   short window, cursor `held_at`.
 * - `awcms_commerce_document_sequences` (one counter per tenant, type and UTC
 *   year) is purged by `updated_at` with a 366-day floor and a ten-year
 *   ceiling. That is safe by construction, not by luck: allocation only ever
 *   touches the row of the CURRENT year, so a counter not bumped for more than
 *   a year belongs to a year that is over and can never be allocated from
 *   again - removing it cannot restart a number.
 *
 * ## Subject data
 *
 * Staff are plain tenant-user uuid stamps. Customers are guest customers
 * identified only by phone (ADR-0009) - the order tables' own
 * `unreachableBySubject` reasoning applies to every snapshot that carries a
 * customer name/phone (quotation versions, documents, held-sale carts).
 */
import type {
  HighVolumeTableDescriptor,
  SubjectDataDescriptor
} from "../../_shared/module-contract";

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
  "Included in ordinary full-database backup/restore; no standalone archive artifact. Restore the document tables together with awcms_commerce_orders (documents and quotation conversions point at orders) and awcms_commerce_document_sequences (the counters that keep numbers gapless).";

type Spec = {
  key: string;
  tableName: string;
  cursorColumn: "created_at" | "deleted_at" | "held_at" | "updated_at";
  retentionClass: "financial_tax" | "system_event" | "operational_queue";
  min: number;
  max: number;
  def: number;
  partitionWhy: string;
  deletionWhy: string;
  indexName: string;
  /** The migration that created the index; defaults to `sql/980`. */
  migration?: string;
};

function descriptor(spec: Spec): HighVolumeTableDescriptor {
  return {
    key: spec.key,
    tableName: spec.tableName,
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: spec.cursorColumn,
    retentionClass: spec.retentionClass,
    retentionMinDays: spec.min,
    retentionMaxDays: spec.max,
    defaultRetentionDays: spec.def,
    partition: NO_PARTITION(spec.partitionWhy),
    archive: NO_ARCHIVE,
    deletion: { mode: "hard_delete", rationale: spec.deletionWhy },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", spec.cursorColumn],
        purpose: `${spec.indexName} (${spec.migration ?? "sql/980"}) - the (tenant, cursor) composite the generic purge engine filters + orders by.`
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "generic"
  };
}

const UNREACHABLE =
  "Practically UNREACHABLE, like commerce.orders: this module never sets deleted_at (the column exists only as the retention cursor), and other rows keep foreign keys to this one. The retention this descriptor documents is enforced by never matching the purge predicate.";

export const DOCUMENT_DATA_LIFECYCLE: HighVolumeTableDescriptor[] = [
  descriptor({
    key: "commerce.document_sequences",
    tableName: "awcms_commerce_document_sequences",
    cursorColumn: "updated_at",
    retentionClass: "system_event",
    min: 366,
    max: 3650,
    def: 3650,
    partitionWhy:
      "At most four rows per tenant per year (one per document type) - human-scale, never traffic-generated: the counter is bumped, not appended to.",
    deletionWhy:
      "The generic engine's only mode. Safe by construction: allocation (application/document-numbering.ts) only ever touches the row of the CURRENT UTC year, so a counter whose last bump is more than 366 days old belongs to a finished year that can never be allocated from again; deleting it cannot restart a number. awcms_app has no DELETE (sql/980's REVOKE), a guard trigger allows only +1 per update, and only the retention worker may remove a row.",
    indexName: "awcms_commerce_document_sequences_tenant_updated_idx"
  }),
  descriptor({
    key: "commerce.held_sales",
    tableName: "awcms_commerce_held_sales",
    cursorColumn: "held_at",
    retentionClass: "operational_queue",
    min: 7,
    max: 90,
    def: 30,
    partitionWhy:
      "A handful of parked carts per cashier, each expiring within seven days - bounded by shop activity.",
    deletionWhy:
      "The generic engine's only mode. A parked cart is transient and its cart JSON is already wiped when the sale leaves held; the row itself is only a 'a sale was parked here' record. awcms_app has no DELETE (sql/980's REVOKE).",
    indexName: "awcms_commerce_held_sales_tenant_held_idx"
  }),
  descriptor({
    key: "commerce.quotations",
    tableName: "awcms_commerce_quotations",
    cursorColumn: "deleted_at",
    retentionClass: "system_event",
    min: 365,
    max: 3650,
    def: 3650,
    partitionWhy:
      "One header per quotation - bounded by a tenant's quoting volume.",
    deletionWhy: UNREACHABLE,
    indexName: "awcms_commerce_quotations_tenant_deleted_idx"
  }),
  descriptor({
    key: "commerce.quotation_versions",
    tableName: "awcms_commerce_quotation_versions",
    cursorColumn: "deleted_at",
    retentionClass: "system_event",
    min: 365,
    max: 3650,
    def: 3650,
    partitionWhy:
      "A few versions per quotation - bounded by a tenant's quoting volume.",
    deletionWhy: `${UNREACHABLE} An append-only trigger forbids every UPDATE, so it can never be set.`,
    indexName: "awcms_commerce_quotation_versions_tenant_deleted_idx"
  }),
  descriptor({
    key: "commerce.work_orders",
    tableName: "awcms_commerce_work_orders",
    cursorColumn: "deleted_at",
    retentionClass: "system_event",
    min: 365,
    max: 3650,
    def: 3650,
    partitionWhy: "One header per job - bounded by a tenant's service volume.",
    deletionWhy: UNREACHABLE,
    indexName: "awcms_commerce_work_orders_tenant_deleted_idx"
  }),
  descriptor({
    key: "commerce.work_order_events",
    tableName: "awcms_commerce_work_order_events",
    cursorColumn: "created_at",
    retentionClass: "system_event",
    min: 365,
    max: 3650,
    def: 3650,
    partitionWhy:
      "A handful of status moves per job - bounded by service volume.",
    deletionWhy:
      "The generic engine's only mode. Reachable only past the ceiling and only by the retention worker: awcms_app has no DELETE and a trigger forbids every UPDATE.",
    indexName: "awcms_commerce_work_order_events_tenant_created_idx"
  }),
  descriptor({
    key: "commerce.documents",
    tableName: "awcms_commerce_documents",
    cursorColumn: "created_at",
    retentionClass: "financial_tax",
    min: 1825,
    max: 3650,
    def: 3650,
    partitionWhy:
      "At most two documents per order - proportional to orders, which are not partitioned either.",
    deletionWhy:
      "The generic engine's only mode. Reachable only past the ten-year ceiling and only by the retention worker: awcms_app has no DELETE (sql/980's REVOKE) and a trigger forbids every UPDATE, so a numbered legal document is immutable for every runtime path.",
    indexName: "awcms_commerce_documents_tenant_created_idx"
  }),
  // Issue #295 (ADR-0034): the delivery REQUESTS. Shorter than the documents
  // they point at on purpose - a request is a record that a message was handed
  // to an outbox, not a commercial record, and it holds only a masked recipient.
  descriptor({
    key: "commerce.document_deliveries",
    tableName: "awcms_commerce_document_deliveries",
    cursorColumn: "created_at",
    retentionClass: "system_event",
    min: 90,
    max: 1095,
    def: 365,
    partitionWhy:
      "At most a handful of requests per document (a per-source rolling limit bounds a stuck client) - proportional to documents, which are not partitioned either.",
    deletionWhy:
      "The generic engine's only mode. Reachable only past the ninety-day floor and only by the retention worker: awcms_app has no DELETE or UPDATE (sql/965's REVOKE and append-only trigger). The outbox rows a request points at have their own, independent retention.",
    indexName: "awcms_commerce_document_deliveries_tenant_created_idx",
    migration: "sql/965"
  })
];

const STAFF =
  "Staff are plain tenant-user uuid stamps that resolve to nobody once identity_access.identities anonymises.";
const CUSTOMER =
  "Any customer name/phone it carries belongs to a guest customer identified only by phone (ADR-0009) with no tenant_user/identity/profile/principal row, so it is unreachable by this engine's subject vocabulary - the stance commerce.orders documents (ADR-0016 D1).";

export const DOCUMENT_SUBJECT_DATA: SubjectDataDescriptor[] = [
  {
    key: "commerce.held_sales",
    tableName: "awcms_commerce_held_sales",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "owner_tenant_user_id", references: "tenant_user" },
      { column: "closed_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #286 - a parked POS cart (product lines, optional customer name/phone, notes), wiped to {} when the sale leaves 'held'. ${STAFF} ${CUSTOMER}`,
    redactedColumns: ["label", "cart"]
  },
  {
    key: "commerce.quotations",
    tableName: "awcms_commerce_quotations",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "created_by_tenant_user_id", references: "tenant_user" },
      { column: "accepted_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #286 - a quotation header: number, status, pinned accepted version, conversion provenance. It points at a guest customer row only through customer_id. ${STAFF} ${CUSTOMER}`,
    redactedColumns: ["decision_note"]
  },
  {
    key: "commerce.quotation_versions",
    tableName: "awcms_commerce_quotation_versions",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "created_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #286 - an immutable priced version snapshot (lines, totals, validity, the customer name/phone as quoted). Retained as the evidence of what was offered. ${STAFF} ${CUSTOMER}`,
    redactedColumns: ["customer", "notes"]
  },
  {
    key: "commerce.work_orders",
    tableName: "awcms_commerce_work_orders",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "created_by_tenant_user_id", references: "tenant_user" },
      { column: "assignee_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #286 - an operational job record (title, description, status, assignee, due date); it holds no money. ${STAFF} ${CUSTOMER}`,
    redactedColumns: ["title", "description"]
  },
  {
    key: "commerce.work_order_events",
    tableName: "awcms_commerce_work_order_events",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "actor_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #286 - append-only work-order status history. ${STAFF}`,
    redactedColumns: ["note"]
  },
  {
    key: "commerce.documents",
    tableName: "awcms_commerce_documents",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "issued_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #286 - an immutable numbered receipt/invoice snapshot of a finalized order, retained under the tax/commercial-record obligation like commerce.orders. ${STAFF} ${CUSTOMER}`,
    redactedColumns: ["snapshot"]
  },
  {
    key: "commerce.document_deliveries",
    tableName: "awcms_commerce_document_deliveries",
    ownerModuleKey: "commerce",
    subjectColumns: [
      { column: "requested_by_tenant_user_id", references: "tenant_user" }
    ],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #295 - an append-only record that a commercial document was handed to the e-mail or WhatsApp outbox: ids, the document number, channel, hand-off status and a MASKED recipient (never the address or number, never the message body or a customer name). ${STAFF} ${CUSTOMER}`,
    redactedColumns: ["recipient_masked"]
  }
];
