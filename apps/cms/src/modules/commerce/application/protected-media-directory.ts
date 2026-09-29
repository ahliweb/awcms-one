/**
 * Directory for `awcms_commerce_protected_media_links` (Issue #268, IRMbyDUS,
 * `sql/939`) — which `visibility: "private"` media object a product's
 * commerce entitlement gates. See that migration's header for why this is a
 * dedicated table (not a column threaded through `product-directory.ts`'s
 * full create/update/validation stack) and why it lives in `commerce`, not
 * `media_library` ("media must never depend on its own consumers").
 *
 * Every function here takes an already tenant-scoped `Bun.SQL`, same
 * convention as every other directory in this repo.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_protected_media_link";

export type ProtectedMediaLink = {
  id: string;
  productId: string;
  mediaObjectId: string;
  createdAt: Date;
  updatedAt: Date;
};

type ProtectedMediaLinkRow = {
  id: string;
  product_id: string;
  media_object_id: string;
  created_at: Date;
  updated_at: Date;
};

function toView(row: ProtectedMediaLinkRow): ProtectedMediaLink {
  return {
    id: row.id,
    productId: row.product_id,
    mediaObjectId: row.media_object_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * The one lookup the download-issuance flow needs: "which media object does
 * this product's entitlement gate". `null` when the product has no protected
 * content linked — a perfectly ordinary state for a non-digital or
 * not-yet-configured product, not an error.
 */
export async function fetchProtectedMediaLinkForProduct(
  tx: Bun.SQL,
  tenantId: string,
  productId: string
): Promise<ProtectedMediaLink | null> {
  const rows = (await tx`
    SELECT id, product_id, media_object_id, created_at, updated_at
    FROM awcms_commerce_protected_media_links
    WHERE tenant_id = ${tenantId} AND product_id = ${productId}
  `) as ProtectedMediaLinkRow[];

  return rows[0] ? toView(rows[0]) : null;
}

/**
 * Admin-only: link (or re-link) a product to the private media object its
 * entitlement gates. Upsert on the `(tenant_id, product_id)` unique index
 * (`sql/939`) — at most one link per product, by design (see that
 * migration's header on why this is a schema-level cap, not merely a
 * convention).
 *
 * Deliberately does NOT verify `mediaObjectId` exists / is
 * `visibility: "private"` here — that check belongs to the ISSUANCE path
 * (`GET /api/v1/commerce/storefront/products/{id}/download`), which must
 * re-verify it live on every request regardless (the media object could be
 * soft-deleted or have its visibility changed after this link was written),
 * so duplicating the check here would only create a second place for it to
 * go stale.
 */
export async function setProtectedMediaLinkForProduct(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  productId: string,
  mediaObjectId: string,
  correlationId?: string
): Promise<ProtectedMediaLink> {
  const rows = (await tx`
    INSERT INTO awcms_commerce_protected_media_links
      (tenant_id, product_id, media_object_id)
    VALUES (${tenantId}, ${productId}, ${mediaObjectId})
    ON CONFLICT (tenant_id, product_id)
    DO UPDATE SET media_object_id = EXCLUDED.media_object_id, updated_at = now()
    RETURNING id, product_id, media_object_id, created_at, updated_at
  `) as ProtectedMediaLinkRow[];

  const link = toView(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.protected_media_link.set",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: link.id,
    message: `Protected media link set for product ${productId} -> media object ${mediaObjectId}.`,
    attributes: { productId, mediaObjectId },
    correlationId
  });

  return link;
}

/** Admin-only: remove a product's protected-media link. `false` if none existed. */
export async function clearProtectedMediaLinkForProduct(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  productId: string,
  correlationId?: string
): Promise<boolean> {
  const rows = (await tx`
    DELETE FROM awcms_commerce_protected_media_links
    WHERE tenant_id = ${tenantId} AND product_id = ${productId}
    RETURNING id, media_object_id
  `) as { id: string; media_object_id: string }[];

  const removed = rows[0];
  if (!removed) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.protected_media_link.cleared",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: removed.id,
    message: `Protected media link cleared for product ${productId}.`,
    attributes: { productId, mediaObjectId: removed.media_object_id },
    correlationId
  });

  return true;
}
