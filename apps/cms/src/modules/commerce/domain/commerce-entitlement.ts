/**
 * Commerce entitlement — Issue #267 (IRMbyDUS), depends on #266 (sql/935's
 * `PRODUCT_TYPES` widening). Pure — no database, no I/O.
 *
 * ## Not `identity-access/domain/entitlement.ts`
 *
 * That file's "entitlement" is a deny-only tenant/plan feature gate
 * (ADR-0084) layered on top of authorization. THIS type answers a different
 * question entirely — "did this customer buy access to this product" — and
 * is owned by `commerce`. Every export in this file is prefixed
 * `CommerceEntitlement*`/named `commerce-entitlement*` on purpose, never a
 * bare `Entitlement*`/`entitlement.ts`, so the two never read as the same
 * concept in a grep, an import list, or a stack trace. See `sql/936`'s
 * header for the full disambiguation note.
 *
 * ## Two states, one direction
 *
 * `active -> revoked` is the only edge — there is no `revoked -> active`
 * "re-grant" edge in this layer (a repurchase after a revoke creates a NEW
 * row via a NEW `source_order_id`, it never resurrects the old one; see
 * `sql/936`'s header on why `source_order_id` is part of the row's
 * identity). `revoked` is therefore terminal from THIS module's point of
 * view.
 */

export const COMMERCE_ENTITLEMENT_STATUSES = ["active", "revoked"] as const;

export type CommerceEntitlementStatus =
  (typeof COMMERCE_ENTITLEMENT_STATUSES)[number];

export function isCommerceEntitlementStatus(
  value: unknown
): value is CommerceEntitlementStatus {
  return (
    typeof value === "string" &&
    (COMMERCE_ENTITLEMENT_STATUSES as readonly string[]).includes(value)
  );
}

/** The shape every read path (admin list, "my entitlements", entitlement-check) returns. */
export type CommerceEntitlement = {
  id: string;
  ownerCustomerId: string;
  productId: string;
  sourceOrderId: string;
  status: CommerceEntitlementStatus;
  grantedAt: string;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Pure predicate `verifyEntitlement` (`application/commerce-entitlement-directory.ts`)
 * ultimately reduces to: a row counts as a live entitlement only while
 * `status === "active"`. `revokedAt` is derived/redundant information for
 * display — this function is the single place that decides which of the two
 * columns is authoritative, so nothing else has to re-derive it.
 */
export function isActiveCommerceEntitlement(
  entitlement: Pick<CommerceEntitlement, "status">
): boolean {
  return entitlement.status === "active";
}
