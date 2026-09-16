/**
 * `awcms_commerce_reviews` persistence — Issue #29.
 *
 * A review requires a `completed` order that actually contains the product
 * AND belongs to the (phone-verified) customer — the same "credential
 * inside the transaction" discipline `order-directory.ts`'s tracking lookup
 * uses. One review per (customer, product, order): the database's unique
 * index is the backstop; this file's own existence checks are what let the
 * route answer the CORRECT error (`404` neutral vs `409
 * REVIEW_NOT_ALLOWED`) rather than a raw constraint violation.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  keysetCursorCreatedAtSql,
  encodeKeysetCursor,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_REVIEW_AGGREGATE_TYPE,
  COMMERCE_REVIEW_PUBLISHED_EVENT_TYPE
} from "../domain/commerce-events";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "review";
const PRODUCER_MODULE = "commerce";
export const REVIEW_LIST_LIMIT = 100;

export type ReviewStatus = "pending" | "published" | "rejected";

export type CreateReviewOutcome =
  | { kind: "created"; id: string }
  | { kind: "not_found" }
  | {
      kind: "not_allowed";
      reason:
        "order_not_completed" | "product_not_in_order" | "already_reviewed";
    };

/**
 * `POST …/storefront/reviews`. `orderCode` + `phone` is the credential
 * (same discipline `order-directory.ts`'s tracking lookup uses); an unknown
 * pair reads as `not_found`, indistinguishable from a wrong `orderCode`.
 */
export async function createReview(
  tx: Bun.SQL,
  tenantId: string,
  orderCode: string,
  phone: string,
  productId: string,
  rating: number,
  body: string,
  correlationId?: string
): Promise<CreateReviewOutcome> {
  const orderRows = (await tx`
    SELECT o.id, o.status, o.customer_id
    FROM awcms_commerce_orders o
    JOIN awcms_commerce_customers c ON c.id = o.customer_id
    WHERE o.tenant_id = ${tenantId} AND o.order_code = ${orderCode}
      AND c.phone = ${phone} AND o.deleted_at IS NULL
  `) as { id: string; status: string; customer_id: string }[];

  const order = orderRows[0];
  if (!order) return { kind: "not_found" };

  if (order.status !== "completed") {
    return { kind: "not_allowed", reason: "order_not_completed" };
  }

  const itemRows = (await tx`
    SELECT 1 FROM awcms_commerce_order_items
    WHERE tenant_id = ${tenantId} AND order_id = ${order.id} AND product_id = ${productId}
      AND deleted_at IS NULL
  `) as unknown[];
  if (itemRows.length === 0) {
    return { kind: "not_allowed", reason: "product_not_in_order" };
  }

  let rows: { id: string }[];
  try {
    rows = (await tx`
      INSERT INTO awcms_commerce_reviews (tenant_id, product_id, customer_id, order_id, rating, body)
      VALUES (${tenantId}, ${productId}, ${order.customer_id}, ${order.id}, ${rating}, ${body})
      RETURNING id
    `) as { id: string }[];
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === "23505"
    ) {
      return { kind: "not_allowed", reason: "already_reviewed" };
    }
    throw error;
  }

  const record = rows[0]!;

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: `Review submitted for order ${orderCode}.`,
    attributes: { orderCode, productId, rating },
    correlationId
  });

  return { kind: "created", id: record.id };
}

type ReviewRow = {
  id: string;
  product_id: string;
  customer_id: string;
  order_id: string;
  rating: number;
  body: string;
  status: string;
  created_at: Date;
};

export type ReviewAdminRecord = {
  id: string;
  productId: string;
  customerId: string;
  orderId: string;
  rating: number;
  body: string;
  status: ReviewStatus;
  createdAt: string;
};

function toAdminRecord(row: ReviewRow): ReviewAdminRecord {
  return {
    id: row.id,
    productId: row.product_id,
    customerId: row.customer_id,
    orderId: row.order_id,
    rating: row.rating,
    body: row.body,
    status: row.status as ReviewStatus,
    createdAt: row.created_at.toISOString()
  };
}

export type ReviewListPage = {
  items: ReviewAdminRecord[];
  nextCursor: string | null;
};

export async function listReviewsForAdmin(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null = null,
  status?: ReviewStatus
): Promise<ReviewListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const statusParam = status ?? null;

  const rows = (await tx`
    SELECT id, product_id, customer_id, order_id, rating, body, status, created_at,
           ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_commerce_reviews
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND (${statusParam}::text IS NULL OR status = ${statusParam})
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${REVIEW_LIST_LIMIT}
  `) as (ReviewRow & { created_at_cursor: string })[];

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === REVIEW_LIST_LIMIT && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { items: rows.map(toAdminRecord), nextCursor };
}

/** Admin moderation — `PATCH /api/v1/commerce/reviews/{id}` (`publish`/`reject` only; there is no author-edit path in this increment). */
export async function moderateReview(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  reviewId: string,
  status: "published" | "rejected",
  correlationId?: string
): Promise<ReviewAdminRecord | null> {
  const rows = (await tx`
    UPDATE awcms_commerce_reviews
    SET status = ${status}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${reviewId} AND deleted_at IS NULL AND status = 'pending'
    RETURNING id, product_id, customer_id, order_id, rating, body, status, created_at
  `) as ReviewRow[];

  if (rows.length === 0) return null;

  const record = toAdminRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: `Review ${status} by admin.`,
    correlationId
  });

  if (status === "published") {
    await appendDomainEvent(tx, tenantId, {
      eventType: COMMERCE_REVIEW_PUBLISHED_EVENT_TYPE,
      eventVersion: COMMERCE_EVENT_VERSION,
      aggregateType: COMMERCE_REVIEW_AGGREGATE_TYPE,
      aggregateId: record.id,
      producerModule: PRODUCER_MODULE,
      correlationId,
      actorTenantUserId,
      payload: { reviewId: record.id, productId: record.productId }
    });
  }

  return record;
}

export async function deleteReview(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  reviewId: string,
  correlationId?: string
): Promise<boolean> {
  const rows = await tx`
    UPDATE awcms_commerce_reviews
    SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${reviewId} AND deleted_at IS NULL
    RETURNING id
  `;
  if (rows.length === 0) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "delete",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: reviewId,
    severity: "warning",
    message: "Review soft-deleted.",
    correlationId
  });

  return true;
}
