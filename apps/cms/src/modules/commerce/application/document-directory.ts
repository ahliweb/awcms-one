/**
 * Numbered, immutable receipt / invoice documents (Issue #286, ADR-0029 D1-D3,
 * D7).
 *
 * ## What a document is, and the boundary it keeps
 *
 * A document is a frozen, numbered SNAPSHOT of one already-finalized commerce
 * order: seller, customer, lines, totals, and the payments as the ledger showed
 * them at issue time. The order (and its payment allocations, ADR-0025) stays
 * the only monetary authority - the document's money columns are a COPY that a
 * database trigger verifies equal to the order's at insert, and the document
 * carries no payment state of its own to drift. It is also NOT an
 * accounts-receivable invoice (no ageing, no due-date tracking, no balance): a
 * future AR module references a document, it does not extend it.
 *
 * ## Issuing
 *
 * `issueDocument` locks the order row (`FOR NO KEY UPDATE`), so concurrent
 * issues of the same document serialise and the loser simply finds the winner's
 * row - it never consumes a number. One receipt and one invoice per order
 * (`UNIQUE (tenant_id, doc_type, source_type, source_id)`): issuing again
 * returns the existing document (`alreadyIssued`). The number is allocated LAST
 * (`document-numbering.ts`), after every check that can end in a returned
 * failure, and the snapshot's SHA-256 (`content_hash`) is computed over the
 * canonical JSON so any later tampering is detectable.
 *
 * ## Reading and reprinting
 *
 * `fetchDocument` returns the stored snapshot. `renderStoredDocument` renders it
 * (json / text / html) and re-verifies the stored hash first; a mismatch is
 * refused rather than printed. Reprinting reads only - it never mutates the row;
 * each render is audited so a reprint trail exists.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../_shared/idempotency";
import {
  encodeKeysetCursor,
  keysetCursorCreatedAtSql,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import type { MediaLibraryPort } from "../../_shared/ports/media-library-port";
import {
  fromCents,
  normalizeMoney,
  toCents
} from "../domain/price-calculation";
import {
  COMMERCE_DOCUMENT_AGGREGATE_TYPE,
  COMMERCE_DOCUMENT_ISSUED_EVENT_TYPE,
  COMMERCE_EVENT_VERSION
} from "../domain/commerce-events";
import {
  checkIssueEligibility,
  contentHash,
  type DocumentRenderFormat,
  type DocumentRenderLocale,
  type DocumentSnapshot,
  type IssueDocumentInput,
  type IssuedDocumentType,
  renderDocument
} from "../domain/documents";
import { allocateDocumentNumber } from "./document-numbering";
import {
  fetchOrderDetailForAdmin,
  IdempotencyPayloadMismatchError,
  toAdminOrderRecord
} from "./order-directory";
import { fetchStoreSettings } from "./store-settings-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "document";
const PRODUCER_MODULE = "commerce";
const ISSUE_SCOPE = "commerce.documents.issue";

export const DOCUMENT_LIST_LIMIT = 50;

export type DocumentRecord = {
  id: string;
  docType: IssuedDocumentType;
  number: string;
  sourceType: "order";
  sourceId: string;
  sourceVersion: number;
  currency: "IDR";
  subtotal: string;
  discount: string;
  shippingCost: string;
  insuranceFee: string;
  tax: string;
  total: string;
  contentHash: string;
  issuedByTenantUserId: string;
  issuedAt: string;
};

export type DocumentDetail = DocumentRecord & { snapshot: DocumentSnapshot };

type Row = {
  id: string;
  doc_type: string;
  number: string;
  source_type: string;
  source_id: string;
  source_version: number;
  currency: string;
  subtotal: string;
  discount: string;
  shipping_cost: string;
  insurance_fee: string;
  tax: string;
  total: string;
  content_hash: string;
  issued_by_tenant_user_id: string;
  issued_at: Date;
  snapshot?: DocumentSnapshot;
};

const COLUMNS = `id, doc_type, number, source_type, source_id, source_version, currency,
  subtotal, discount, shipping_cost, insurance_fee, tax, total, content_hash,
  issued_by_tenant_user_id, issued_at`;

function toRecord(row: Row): DocumentRecord {
  return {
    id: row.id,
    docType: row.doc_type as IssuedDocumentType,
    number: row.number,
    sourceType: "order",
    sourceId: row.source_id,
    sourceVersion: Number(row.source_version),
    currency: "IDR",
    subtotal: normalizeMoney(String(row.subtotal)),
    discount: normalizeMoney(String(row.discount)),
    shippingCost: normalizeMoney(String(row.shipping_cost)),
    insuranceFee: normalizeMoney(String(row.insurance_fee)),
    tax: normalizeMoney(String(row.tax)),
    total: normalizeMoney(String(row.total)),
    contentHash: row.content_hash,
    issuedByTenantUserId: row.issued_by_tenant_user_id,
    issuedAt: row.issued_at.toISOString()
  };
}

export async function fetchDocument(
  tx: Bun.SQL,
  tenantId: string,
  documentId: string
): Promise<DocumentDetail | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(COLUMNS)}, snapshot
    FROM awcms_commerce_documents
    WHERE tenant_id = ${tenantId} AND id = ${documentId}
  `) as Row[];
  const row = rows[0];
  return row ? { ...toRecord(row), snapshot: row.snapshot! } : null;
}

export type DocumentListFilters = {
  docType?: IssuedDocumentType;
  orderId?: string;
};
export type DocumentListPage = {
  items: DocumentRecord[];
  nextCursor: string | null;
};

export async function listDocuments(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null,
  filters: DocumentListFilters = {}
): Promise<DocumentListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const docType = filters.docType ?? null;
  const orderId = filters.orderId ?? null;
  const rows = (await tx`
    SELECT ${tx.unsafe(COLUMNS)},
           ${tx.unsafe(keysetCursorCreatedAtSql("d"))} AS created_at_cursor
    FROM awcms_commerce_documents d
    WHERE d.tenant_id = ${tenantId}
      AND (${docType}::text IS NULL OR d.doc_type = ${docType})
      AND (${orderId}::uuid IS NULL OR d.source_id = ${orderId})
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (d.created_at, d.id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY d.created_at DESC, d.id DESC
    LIMIT ${DOCUMENT_LIST_LIMIT}
  `) as (Row & { created_at_cursor: string })[];
  const last = rows[rows.length - 1];
  return {
    items: rows.map(toRecord),
    nextCursor:
      rows.length === DOCUMENT_LIST_LIMIT && last
        ? encodeKeysetCursor(last.created_at_cursor, last.id)
        : null
  };
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export type IssueDocumentOutcome =
  | { kind: "order_not_found" }
  | { kind: "not_eligible"; reason: "ORDER_NOT_FINAL" | "ORDER_NOT_PAID" }
  | {
      kind: "issued" | "replayed";
      document: DocumentDetail;
      alreadyIssued: boolean;
    };

export async function issueDocument(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  mediaPort: MediaLibraryPort,
  input: IssueDocumentInput,
  now: Date = new Date(),
  correlationId?: string
): Promise<IssueDocumentOutcome> {
  const orders = (await tx`
    SELECT id, status, payment_status
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${input.orderId} AND deleted_at IS NULL
    FOR NO KEY UPDATE
  `) as { id: string; status: string; payment_status: string }[];
  const order = orders[0];
  if (!order) return { kind: "order_not_found" };

  const requestHash = computeRequestHash({
    action: ISSUE_SCOPE,
    actorTenantUserId,
    orderId: input.orderId,
    docType: input.docType
  });
  const stored = await findIdempotencyRecord(
    tx,
    tenantId,
    ISSUE_SCOPE,
    input.idempotencyKey
  );
  if (stored) {
    if (stored.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      document: stored.responseBody as DocumentDetail,
      alreadyIssued: false
    };
  }

  // One receipt / one invoice per order: a second issue returns the first.
  const prior = (await tx`
    SELECT id FROM awcms_commerce_documents
    WHERE tenant_id = ${tenantId} AND doc_type = ${input.docType}
      AND source_type = 'order' AND source_id = ${input.orderId}
  `) as { id: string }[];
  if (prior[0]) {
    const document = (await fetchDocument(tx, tenantId, prior[0].id))!;
    await saveIdempotencyRecord(
      tx,
      tenantId,
      ISSUE_SCOPE,
      input.idempotencyKey,
      requestHash,
      200,
      document
    );
    return { kind: "issued", document, alreadyIssued: true };
  }

  const eligibility = checkIssueEligibility(input.docType, {
    status: order.status,
    paymentStatus: order.payment_status
  });
  if (!eligibility.eligible) {
    return { kind: "not_eligible", reason: eligibility.reason };
  }

  // Everything below either succeeds or THROWS (rolling the number back).
  const detail = (await fetchOrderDetailForAdmin(
    tx,
    tenantId,
    mediaPort,
    input.orderId
  ))!;
  const admin = await toAdminOrderRecord(tx, tenantId, detail, {
    includePayments: true
  });
  const settings = await fetchStoreSettings(tx, tenantId);
  // Issue #363: everything the customer did not pay in money, the points
  // discount included (`sql/1011` teaches the match trigger the same sum).
  const discount = fromCents(
    toCents(detail.discount) +
      toCents(detail.voucherDiscount) +
      toCents(detail.loyaltyDiscount)
  );

  const allocated = await allocateDocumentNumber(
    tx,
    tenantId,
    input.docType,
    now
  );
  const snapshot: DocumentSnapshot = {
    schemaVersion: 1,
    docType: input.docType,
    number: allocated.number,
    issuedAt: now.toISOString(),
    currency: "IDR",
    seller: {
      name: settings.storeName,
      address: settings.address,
      phone: settings.phone,
      email: settings.email
    },
    customer: {
      name: detail.customer.name,
      phone: detail.customer.phone,
      email: detail.customer.email
    },
    order: {
      id: detail.id,
      orderCode: detail.orderCode,
      channel: detail.channel,
      status: detail.status,
      paymentStatus: admin.settlement.paymentStatus,
      createdAt: detail.createdAt,
      paidAt: detail.paidAt,
      notes: detail.notes
    },
    lines: detail.lines.map((line) => ({
      name: line.name,
      variantName: line.variantName,
      sku: line.sku,
      quantity: line.quantity,
      unitPrice: normalizeMoney(line.unitPrice),
      lineTotal: normalizeMoney(line.lineTotal)
    })),
    totals: {
      subtotal: normalizeMoney(detail.subtotal),
      discount,
      shippingCost: normalizeMoney(detail.shippingCost),
      insuranceFee: normalizeMoney(detail.insuranceFee),
      tax: normalizeMoney(detail.tax),
      total: normalizeMoney(detail.total)
    },
    payments: (admin.payments ?? [])
      .filter((payment) => payment.status === "succeeded")
      .map((payment) => ({
        tenderType: payment.tenderType,
        kind: payment.kind,
        amount: payment.amount,
        at: payment.createdAt
      })),
    settlement: {
      paid: admin.settlement.paid,
      reversed: admin.settlement.reversed,
      outstanding: admin.settlement.outstanding
    }
  };
  const hash = contentHash(snapshot);

  const rows = (await tx`
    INSERT INTO awcms_commerce_documents (
      tenant_id, doc_type, number, source_type, source_id, source_version, currency,
      subtotal, discount, shipping_cost, insurance_fee, tax, total,
      snapshot, content_hash, issued_by_tenant_user_id, issued_at
    )
    VALUES (
      ${tenantId}, ${input.docType}, ${allocated.number}, 'order', ${input.orderId}, 1, 'IDR',
      ${snapshot.totals.subtotal}, ${snapshot.totals.discount}, ${snapshot.totals.shippingCost},
      ${snapshot.totals.insuranceFee}, ${snapshot.totals.tax}, ${snapshot.totals.total},
      ${snapshot}::jsonb, ${hash}, ${actorTenantUserId}, ${now}
    )
    RETURNING id
  `) as { id: string }[];
  const document = (await fetchDocument(tx, tenantId, rows[0]!.id))!;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "document.issue",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: document.id,
    message: `${input.docType} ${document.number} issued for order ${snapshot.order.orderCode}, total ${document.total}.`,
    attributes: {
      docType: input.docType,
      number: document.number,
      orderId: input.orderId,
      total: document.total,
      contentHash: hash
    },
    correlationId
  });
  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_DOCUMENT_ISSUED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_DOCUMENT_AGGREGATE_TYPE,
    aggregateId: document.id,
    producerModule: PRODUCER_MODULE,
    correlationId,
    actorTenantUserId,
    payload: {
      documentId: document.id,
      docType: input.docType,
      number: document.number,
      sourceType: "order",
      sourceId: input.orderId,
      sourceVersion: 1,
      total: document.total
    }
  });
  await saveIdempotencyRecord(
    tx,
    tenantId,
    ISSUE_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    document
  );
  return { kind: "issued", document, alreadyIssued: false };
}

// ---------------------------------------------------------------------------
// Render (print / export / digital delivery)
// ---------------------------------------------------------------------------

export type RenderOutcome =
  | { kind: "not_found" }
  | { kind: "integrity_failure" }
  | {
      kind: "rendered";
      document: DocumentDetail;
      format: DocumentRenderFormat;
      body: string | null;
    };

/**
 * Renders a stored document. The snapshot's hash is re-verified first: a stored
 * snapshot that no longer hashes to its `content_hash` is refused, never
 * printed. Read-only; every render is audited (the reprint trail).
 */
export async function renderStoredDocument(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  documentId: string,
  format: DocumentRenderFormat,
  locale: DocumentRenderLocale,
  correlationId?: string
): Promise<RenderOutcome> {
  const document = await fetchDocument(tx, tenantId, documentId);
  if (!document) return { kind: "not_found" };
  if (contentHash(document.snapshot) !== document.contentHash) {
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "document.integrity_failure",
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: documentId,
      severity: "critical",
      message: `Document ${document.number} no longer matches its content hash.`,
      attributes: { number: document.number },
      correlationId
    });
    return { kind: "integrity_failure" };
  }
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "document.render",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: documentId,
    message: `Document ${document.number} rendered as ${format}.`,
    attributes: { number: document.number, format, locale },
    correlationId
  });
  return {
    kind: "rendered",
    document,
    format,
    body:
      format === "json"
        ? null
        : renderDocument(document.snapshot, format, locale)
  };
}
