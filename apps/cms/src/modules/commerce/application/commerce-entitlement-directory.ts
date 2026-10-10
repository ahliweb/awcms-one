/**
 * Commerce entitlement directory — Issue #267 (IRMbyDUS), depends on #266.
 *
 * NOT `identity-access`'s entitlement layer (`domain/entitlement.ts`) — see
 * that file's and `sql/936`'s headers for the disambiguation. This module
 * answers "did this customer buy access to this product", grants a row per
 * (order, product) when an order is paid, lets it be checked in real time
 * (no cache — `verifyEntitlement` is a plain `SELECT` on every call), and
 * lets an admin revoke it (the only revocation path today — see `sql/936`'s
 * header on why there is no refund-triggered auto-revoke yet).
 */
import {
  encodeKeysetCursor,
  keysetCursorCreatedAtSql,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import { recordAuditEvent } from "../../logging/application/audit-log";
import type { CommerceEntitlement } from "../domain/commerce-entitlement";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_entitlement";

export const ENTITLEMENT_LIST_DEFAULT_LIMIT = 20;
export const ENTITLEMENT_LIST_MAX_LIMIT = 50;

type EntitlementRow = {
  id: string;
  owner_customer_id: string;
  product_id: string;
  source_order_id: string;
  status: string;
  granted_at: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

function toCommerceEntitlement(row: EntitlementRow): CommerceEntitlement {
  return {
    id: row.id,
    ownerCustomerId: row.owner_customer_id,
    productId: row.product_id,
    sourceOrderId: row.source_order_id,
    status: row.status as CommerceEntitlement["status"],
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Grants one entitlement per DISTINCT product on a paid order — called from
 * the `commerce.order_paid_entitlement_grantor` consumer
 * (declared in `commerce/module.ts` `domainEventConsumers`, ADR-0134), itself
 * wrapped in `applyConsumerEffectOnce` by the runtime registry (the
 * per-(consumer, event) idempotency marker). This function ADDITIONALLY
 * inserts with `ON CONFLICT (tenant_id, source_order_id, product_id) DO
 * NOTHING` — the row-level idempotency guard `sql/936`'s header documents —
 * so calling it twice for the same order (redelivery, replay, or a second
 * caller) still yields exactly one row per (order, product).
 *
 * Reads `awcms_commerce_orders`/`awcms_commerce_order_items` directly (both
 * tables this same module owns) rather than trusting the event payload,
 * which carries only `{ orderId, orderCode, from, to }`
 * (`order-directory.ts`'s `transitionOrderStatus`) — no customer or line
 * item data. Silently does nothing (returns an empty array) if the order is
 * not found or is not actually `paid` at read time, since a consumer must
 * tolerate an event whose source row has since moved on.
 *
 * Every row actually inserted (i.e. not skipped by the conflict guard) gets
 * its own `entitlement.granted` audit event — one per product, not one per
 * order, so an auditor reading the trail sees exactly which products were
 * granted access rather than an order id they would have to re-expand.
 */
export async function grantEntitlementsForPaidOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  correlationId?: string
): Promise<CommerceEntitlement[]> {
  const orderRows = (await tx`
    SELECT id, customer_id, status
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${orderId}
  `) as { id: string; customer_id: string; status: string }[];

  const order = orderRows[0];
  if (!order || order.status !== "paid") return [];

  const itemRows = (await tx`
    SELECT DISTINCT product_id
    FROM awcms_commerce_order_items
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
  `) as { product_id: string }[];

  const granted: CommerceEntitlement[] = [];

  for (const item of itemRows) {
    const inserted = (await tx`
      INSERT INTO awcms_commerce_entitlements
        (tenant_id, owner_customer_id, product_id, source_order_id, status)
      VALUES
        (${tenantId}, ${order.customer_id}, ${item.product_id}, ${orderId}, 'active')
      ON CONFLICT (tenant_id, source_order_id, product_id) DO NOTHING
      RETURNING id, owner_customer_id, product_id, source_order_id, status,
        granted_at, revoked_at, created_at, updated_at
    `) as EntitlementRow[];

    const row = inserted[0];
    if (!row) continue;

    const entitlement = toCommerceEntitlement(row);
    granted.push(entitlement);

    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "commerce.entitlement.granted",
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: entitlement.id,
      message: `Entitlement granted to customer ${entitlement.ownerCustomerId} for product ${entitlement.productId} (order ${orderId}).`,
      attributes: {
        ownerCustomerId: entitlement.ownerCustomerId,
        productId: entitlement.productId,
        sourceOrderId: orderId
      },
      correlationId
    });
  }

  return granted;
}

/**
 * The one query this whole module exists to answer, read live on every call
 * (no cache, no memoisation) so a revoke is reflected on the very next
 * check. Returns the active row itself (not just a boolean) so a caller
 * that needs the grant/order provenance does not need a second query.
 */
export async function verifyEntitlement(
  tx: Bun.SQL,
  tenantId: string,
  ownerCustomerId: string,
  productId: string
): Promise<CommerceEntitlement | null> {
  const rows = (await tx`
    SELECT id, owner_customer_id, product_id, source_order_id, status,
      granted_at, revoked_at, created_at, updated_at
    FROM awcms_commerce_entitlements
    WHERE tenant_id = ${tenantId}
      AND owner_customer_id = ${ownerCustomerId}
      AND product_id = ${productId}
      AND status = 'active'
    ORDER BY granted_at DESC
    LIMIT 1
  `) as EntitlementRow[];

  const row = rows[0];
  return row ? toCommerceEntitlement(row) : null;
}

export type EntitlementListPage = {
  items: CommerceEntitlement[];
  nextCursor: string | null;
};

/**
 * "My entitlements" — `ownerCustomerId` MUST come from the caller's own
 * verified bearer session (`requireCustomerSession`), never from request
 * input; see `sql/936`'s header on why owner-scoping is enforced here and
 * not by a second RLS policy.
 */
export async function listEntitlementsForCustomer(
  tx: Bun.SQL,
  tenantId: string,
  ownerCustomerId: string,
  cursor: KeysetCursor | null,
  limit: number = ENTITLEMENT_LIST_DEFAULT_LIMIT
): Promise<EntitlementListPage> {
  const boundedLimit = Math.min(
    Math.max(1, Math.trunc(limit)),
    ENTITLEMENT_LIST_MAX_LIMIT
  );
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT id, owner_customer_id, product_id, source_order_id, status,
      granted_at, revoked_at, created_at, updated_at,
      ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_commerce_entitlements
    WHERE tenant_id = ${tenantId}
      AND owner_customer_id = ${ownerCustomerId}
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${boundedLimit}
  `) as (EntitlementRow & { created_at_cursor: string })[];

  const items = rows.map(toCommerceEntitlement);
  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === boundedLimit && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { items, nextCursor };
}

export type EntitlementAdminListFilter = {
  ownerCustomerId?: string;
  productId?: string;
  status?: string;
};

/** Admin listing (`GET /api/v1/commerce/entitlements`) — the lookup an admin uses to find the id a revoke needs. */
export async function listEntitlementsForAdmin(
  tx: Bun.SQL,
  tenantId: string,
  filter: EntitlementAdminListFilter,
  cursor: KeysetCursor | null,
  limit: number = ENTITLEMENT_LIST_DEFAULT_LIMIT
): Promise<EntitlementListPage> {
  const boundedLimit = Math.min(
    Math.max(1, Math.trunc(limit)),
    ENTITLEMENT_LIST_MAX_LIMIT
  );
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT id, owner_customer_id, product_id, source_order_id, status,
      granted_at, revoked_at, created_at, updated_at,
      ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_commerce_entitlements
    WHERE tenant_id = ${tenantId}
      AND (${filter.ownerCustomerId ?? null}::uuid IS NULL OR owner_customer_id = ${filter.ownerCustomerId ?? null})
      AND (${filter.productId ?? null}::uuid IS NULL OR product_id = ${filter.productId ?? null})
      AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${boundedLimit}
  `) as (EntitlementRow & { created_at_cursor: string })[];

  const items = rows.map(toCommerceEntitlement);
  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === boundedLimit && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { items, nextCursor };
}

export type RevokeEntitlementResult =
  | { kind: "revoked"; entitlement: CommerceEntitlement }
  | { kind: "not_found" }
  | { kind: "already_revoked" };

/**
 * The only revocation path in this PR (`sql/936`'s header — no `refunded`
 * order status/event exists yet to hook an automatic revoke to). A status
 * flip, never a `DELETE` — `verifyEntitlement` stops returning the row on
 * its very next call because it filters on `status = 'active'` directly,
 * not because anything was removed.
 */
export async function revokeEntitlementByAdmin(
  tx: Bun.SQL,
  tenantId: string,
  entitlementId: string,
  actorTenantUserId: string,
  correlationId?: string
): Promise<RevokeEntitlementResult> {
  const existingRows = (await tx`
    SELECT id, owner_customer_id, product_id, source_order_id, status,
      granted_at, revoked_at, created_at, updated_at
    FROM awcms_commerce_entitlements
    WHERE tenant_id = ${tenantId} AND id = ${entitlementId}
  `) as EntitlementRow[];

  const existing = existingRows[0];
  if (!existing) return { kind: "not_found" };
  if (existing.status === "revoked") return { kind: "already_revoked" };

  const updatedRows = (await tx`
    UPDATE awcms_commerce_entitlements
    SET status = 'revoked', revoked_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${entitlementId} AND status = 'active'
    RETURNING id, owner_customer_id, product_id, source_order_id, status,
      granted_at, revoked_at, created_at, updated_at
  `) as EntitlementRow[];

  const updated = updatedRows[0];
  if (!updated) return { kind: "already_revoked" };

  const entitlement = toCommerceEntitlement(updated);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.entitlement.revoked",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: entitlement.id,
    message: `Entitlement revoked for customer ${entitlement.ownerCustomerId}, product ${entitlement.productId} (order ${entitlement.sourceOrderId}).`,
    attributes: {
      ownerCustomerId: entitlement.ownerCustomerId,
      productId: entitlement.productId,
      sourceOrderId: entitlement.sourceOrderId
    },
    correlationId
  });

  return { kind: "revoked", entitlement };
}
