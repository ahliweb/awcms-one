/**
 * `awcms_commerce_customer_addresses` / `_wishlists` persistence for the
 * BEARER-secured account resource routes (Issue #91, C3, contract
 * #86/ADR-0016) — `account/addresses/*` and `account/wishlist/*`. Orders and
 * reviews live beside their existing guest-checkout siblings instead
 * (`order-directory.ts`'s `listOrdersForAccount`/`fetchOrderForAccount`,
 * `review-directory.ts`'s `listReviewsForAccount`) since those need the
 * SAME private row-shaping helpers (`fetchOrderDetailByWhere`,
 * `toPublicOrderRecord`) module-scoped there — this file has nothing to add
 * to that split.
 *
 * Every function here takes `tenantId` + `customerId` explicitly (never
 * re-derived) and scopes every query to both, mirroring
 * `customer-account-store.ts`'s own convention — RLS (FORCE on both tables,
 * `sql/913`) is the tenant backstop, `customer_id` is the account-ownership
 * backstop a bearer session's `account.customerId` already proved.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import type {
  MediaLibraryPort,
  ResolvedMediaReferenceDTO
} from "../../_shared/ports/media-library-port";
import type { AccountAddressInput } from "../domain/address-validation";
import { computeFinalPrice, normalizeMoney } from "../domain/price-calculation";
import { listLiveProductImagesByProductIds } from "./product-image-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE_ADDRESS = "customer_address";
const AUDIT_RESOURCE_TYPE_WISHLIST = "wishlist_item";

export const ACCOUNT_ADDRESS_LIMIT = 10;
export const ACCOUNT_WISHLIST_LIMIT = 200;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

type AddressRow = {
  id: string;
  label: string | null;
  recipient_name: string;
  phone: string;
  province_code: string;
  province_name: string;
  city_code: string;
  city_name: string;
  district_code: string;
  district_name: string;
  postal_code: string | null;
  street: string;
  notes: string | null;
  is_default: boolean;
};

/**
 * The storefront's own `Alamat` contract shape
 * (`apps/storefront/src/lib/akun-klien.ts`) — `label`/`postalCode` are
 * always strings here (never `null`) because
 * `domain/address-validation.ts`'s `validateAccountAddressInput` requires
 * both on every write to this resource; a pre-#91 guest-checkout row with a
 * `NULL` label/postal code (Issue #29's `saveCustomerAddress` never asked
 * for either) is coalesced to `""` rather than lying about the type.
 */
export type AccountAddress = {
  id: string;
  label: string;
  recipientName: string;
  phone: string;
  provinceCode: string;
  provinceName: string;
  cityCode: string;
  cityName: string;
  districtCode: string;
  districtName: string;
  postalCode: string;
  street: string;
  notes: string | null;
  isDefault: boolean;
};

function toAddress(row: AddressRow): AccountAddress {
  return {
    id: row.id,
    label: row.label ?? "",
    recipientName: row.recipient_name,
    phone: row.phone,
    provinceCode: row.province_code,
    provinceName: row.province_name,
    cityCode: row.city_code,
    cityName: row.city_name,
    districtCode: row.district_code,
    districtName: row.district_name,
    postalCode: row.postal_code ?? "",
    street: row.street,
    notes: row.notes,
    isDefault: row.is_default
  };
}

const ADDRESS_COLUMNS = `
  id, label, recipient_name, phone, province_code, province_name,
  city_code, city_name, district_code, district_name, postal_code, street,
  notes, is_default
`;

/** `GET /account/addresses` — every live address on this customer, default first (contract's own "list (default first)"), then oldest-first among the rest. */
export async function listAccountAddresses(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string
): Promise<AccountAddress[]> {
  const rows = (await tx`
    SELECT ${tx.unsafe(ADDRESS_COLUMNS)}
    FROM awcms_commerce_customer_addresses
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId} AND deleted_at IS NULL
    ORDER BY is_default DESC, created_at ASC
  `) as AddressRow[];
  return rows.map(toAddress);
}

export type CreateAccountAddressOutcome =
  { kind: "created"; address: AccountAddress } | { kind: "limit_reached" };

/** `POST /account/addresses` — max {@link ACCOUNT_ADDRESS_LIMIT}; the FIRST address a customer ever saves through this route becomes their default automatically (contract's own rule), mirroring `saveCustomerAddress`'s guest-checkout behaviour one level up. */
export async function createAccountAddress(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  input: AccountAddressInput,
  correlationId?: string
): Promise<CreateAccountAddressOutcome> {
  const countRows = (await tx`
    SELECT count(*)::int AS n
    FROM awcms_commerce_customer_addresses
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId} AND deleted_at IS NULL
  `) as { n: number }[];
  const existingCount = countRows[0]?.n ?? 0;

  if (existingCount >= ACCOUNT_ADDRESS_LIMIT) {
    return { kind: "limit_reached" };
  }

  const isFirst = existingCount === 0;

  const rows = (await tx`
    INSERT INTO awcms_commerce_customer_addresses (
      tenant_id, customer_id, label, recipient_name, phone,
      province_code, province_name, city_code, city_name,
      district_code, district_name, postal_code, street,
      latitude, longitude, notes, is_default
    )
    VALUES (
      ${tenantId}, ${customerId}, ${input.label}, ${input.recipientName}, ${input.phone},
      ${input.provinceCode}, ${input.provinceName}, ${input.cityCode}, ${input.cityName},
      ${input.districtCode}, ${input.districtName}, ${input.postalCode}, ${input.street},
      ${input.latitude}, ${input.longitude}, ${input.notes}, ${isFirst}
    )
    RETURNING ${tx.unsafe(ADDRESS_COLUMNS)}
  `) as AddressRow[];

  const address = toAddress(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE_ADDRESS,
    resourceId: address.id,
    message: "Account address created.",
    attributes: { customerId, isDefault: address.isDefault },
    correlationId
  });

  return { kind: "created", address };
}

/** `PATCH /account/addresses/{id}` — `null` when `id` is not a LIVE address owned by this customer (the route answers a neutral `404`); never touches `is_default` (see `setDefaultAccountAddress`/`deleteAccountAddress` for the only two ways that flag changes). */
export async function updateAccountAddress(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  addressId: string,
  input: AccountAddressInput,
  correlationId?: string
): Promise<AccountAddress | null> {
  const rows = (await tx`
    UPDATE awcms_commerce_customer_addresses
    SET
      label = ${input.label}, recipient_name = ${input.recipientName}, phone = ${input.phone},
      province_code = ${input.provinceCode}, province_name = ${input.provinceName},
      city_code = ${input.cityCode}, city_name = ${input.cityName},
      district_code = ${input.districtCode}, district_name = ${input.districtName},
      postal_code = ${input.postalCode}, street = ${input.street},
      latitude = ${input.latitude}, longitude = ${input.longitude}, notes = ${input.notes},
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId} AND id = ${addressId}
      AND deleted_at IS NULL
    RETURNING ${tx.unsafe(ADDRESS_COLUMNS)}
  `) as AddressRow[];

  if (rows.length === 0) return null;

  const address = toAddress(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE_ADDRESS,
    resourceId: address.id,
    message: "Account address updated.",
    attributes: { customerId },
    correlationId
  });

  return address;
}

/**
 * `DELETE /account/addresses/{id}` — soft-delete; `false` when `id` is not a
 * LIVE address owned by this customer. Deleting the DEFAULT address promotes
 * the most-recently-created remaining one (contract's own rule) — the
 * deleted row's own `deleted_at` is already set by the first `UPDATE` before
 * the promotion runs, so it no longer matches the `920` partial unique
 * index's predicate (`is_default AND deleted_at IS NULL`) and the promotion
 * never collides with it.
 */
export async function deleteAccountAddress(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  addressId: string,
  correlationId?: string
): Promise<boolean> {
  const rows = (await tx`
    UPDATE awcms_commerce_customer_addresses
    SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId} AND id = ${addressId}
      AND deleted_at IS NULL
    RETURNING is_default
  `) as { is_default: boolean }[];

  if (rows.length === 0) return false;

  if (rows[0]!.is_default) {
    await tx`
      UPDATE awcms_commerce_customer_addresses
      SET is_default = true, updated_at = now()
      WHERE id = (
        SELECT id FROM awcms_commerce_customer_addresses
        WHERE tenant_id = ${tenantId} AND customer_id = ${customerId} AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      )
    `;
  }

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "delete",
    resourceType: AUDIT_RESOURCE_TYPE_ADDRESS,
    resourceId: addressId,
    message: "Account address deleted.",
    attributes: { customerId },
    correlationId
  });

  return true;
}

/** `POST /account/addresses/{id}/default` — `null` when `id` is not a LIVE address owned by this customer. Clears the current default (if any) BEFORE setting the new one — two sequential statements, never one, so the `920` partial unique index never sees two rows with `is_default = true` at once. */
export async function setDefaultAccountAddress(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  addressId: string,
  correlationId?: string
): Promise<AccountAddress | null> {
  const existingRows = (await tx`
    SELECT 1 FROM awcms_commerce_customer_addresses
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId} AND id = ${addressId}
      AND deleted_at IS NULL
  `) as unknown[];
  if (existingRows.length === 0) return null;

  await tx`
    UPDATE awcms_commerce_customer_addresses
    SET is_default = false, updated_at = now()
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId} AND is_default
      AND deleted_at IS NULL AND id <> ${addressId}
  `;

  const rows = (await tx`
    UPDATE awcms_commerce_customer_addresses
    SET is_default = true, updated_at = now()
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId} AND id = ${addressId}
      AND deleted_at IS NULL
    RETURNING ${tx.unsafe(ADDRESS_COLUMNS)}
  `) as AddressRow[];

  const address = toAddress(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE_ADDRESS,
    resourceId: address.id,
    message: "Account address set as default.",
    attributes: { customerId },
    correlationId
  });

  return address;
}

// ---------------------------------------------------------------------------
// Wishlist
// ---------------------------------------------------------------------------

export type AccountWishlistItem = {
  productId: string;
  slug: string;
  name: string;
  price: string;
  image: { url: string; alt: string } | null;
  addedAt: string;
};

type WishlistProductRow = {
  product_id: string;
  slug: string;
  name: string;
  price: string;
  discount_percent: number;
  created_at: Date;
};

/** Resolves each row's first image the same way `order-directory.ts`'s `fetchOrderDetailByWhere` resolves an order line's image — one batched `listLiveProductImagesByProductIds` + one batched `resolveMediaReferences`, never N+1. */
async function toWishlistItems(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  rows: WishlistProductRow[]
): Promise<AccountWishlistItem[]> {
  const productIds = [...new Set(rows.map((row) => row.product_id))];
  const imageRows = await listLiveProductImagesByProductIds(
    tx,
    tenantId,
    productIds
  );
  const firstImageMediaIdByProduct = new Map<string, string>();
  for (const image of imageRows) {
    if (!firstImageMediaIdByProduct.has(image.product_id)) {
      firstImageMediaIdByProduct.set(image.product_id, image.media_object_id);
    }
  }
  const mediaIds = [...new Set(firstImageMediaIdByProduct.values())];
  const resolvedMedia =
    mediaIds.length > 0
      ? await mediaPort.resolveMediaReferences(tx, tenantId, mediaIds)
      : new Map<string, ResolvedMediaReferenceDTO>();

  return rows.map((row) => {
    const mediaObjectId = firstImageMediaIdByProduct.get(row.product_id);
    const resolved = mediaObjectId
      ? resolvedMedia.get(mediaObjectId)
      : undefined;
    return {
      productId: row.product_id,
      slug: row.slug,
      name: row.name,
      price: normalizeMoney(computeFinalPrice(row.price, row.discount_percent)),
      image: resolved
        ? { url: resolved.publicUrl, alt: resolved.altText ?? row.name }
        : null,
      addedAt: row.created_at.toISOString()
    };
  });
}

/**
 * `GET /account/wishlist` — published, non-deleted products only (contract's
 * own filter); a product moderated/unpublished/deleted after being
 * wishlisted simply stops appearing here, the row itself is untouched.
 *
 * This module's own product lifecycle (`domain/product-status.ts`) has no
 * status literally spelled `"published"` — the public-facing state every
 * other storefront read filters on (`cart-quote-service.ts`,
 * `voucher-directory.ts`'s public listing) is `status = 'active'`; this
 * query uses the SAME literal for the SAME reason, not a second definition
 * of "published" for this one table.
 */
export async function listAccountWishlist(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  mediaPort: MediaLibraryPort
): Promise<AccountWishlistItem[]> {
  const rows = (await tx`
    SELECT w.product_id, w.created_at, p.slug, p.name, p.price, p.discount_percent
    FROM awcms_commerce_wishlists w
    JOIN awcms_commerce_products p ON p.id = w.product_id AND p.tenant_id = w.tenant_id
    WHERE w.tenant_id = ${tenantId} AND w.customer_id = ${customerId} AND w.deleted_at IS NULL
      AND p.deleted_at IS NULL AND p.status = 'active'
    ORDER BY w.created_at DESC
  `) as WishlistProductRow[];

  return toWishlistItems(tx, tenantId, mediaPort, rows);
}

export type MergeAccountWishlistOutcome =
  { kind: "merged"; items: AccountWishlistItem[] } | { kind: "limit_reached" };

/**
 * `PUT /account/wishlist` — union-merges `productIds` into whatever the
 * customer already has, max {@link ACCOUNT_WISHLIST_LIMIT} LIVE rows total.
 * An id that is not a live product IN THIS TENANT is silently skipped
 * (never a 400) — the same "cross-table reference this module cannot trust
 * a bare FK to isolate by tenant" guard `awcms-one-commerce`'s own skill
 * requires (a `wishlists.product_id` FK has no tenant qualifier of its own),
 * checked here in the application layer inside the same RLS-scoped
 * transaction, and indistinguishable from "id does not exist at all" —
 * exactly the posture the storefront's own stub already documents ("an id
 * this stub's catalog does not know is silently skipped").
 */
export async function mergeAccountWishlist(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  productIds: readonly string[],
  mediaPort: MediaLibraryPort,
  correlationId?: string
): Promise<MergeAccountWishlistOutcome> {
  const candidateIds = [
    ...new Set(productIds.filter((id) => UUID_PATTERN.test(id)))
  ];

  const countRows = (await tx`
    SELECT count(*)::int AS n
    FROM awcms_commerce_wishlists
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId} AND deleted_at IS NULL
  `) as { n: number }[];
  const existingCount = countRows[0]?.n ?? 0;

  let toInsert: string[] = [];
  if (candidateIds.length > 0) {
    const liveRows = (await tx`
      SELECT id FROM awcms_commerce_products
      WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
        AND id = ANY(${tx.array(candidateIds, "uuid")}::uuid[])
    `) as { id: string }[];
    const liveIds = new Set(liveRows.map((row) => row.id));

    const alreadyPresentRows = (await tx`
      SELECT product_id FROM awcms_commerce_wishlists
      WHERE tenant_id = ${tenantId} AND customer_id = ${customerId} AND deleted_at IS NULL
        AND product_id = ANY(${tx.array(candidateIds, "uuid")}::uuid[])
    `) as { product_id: string }[];
    const alreadyPresent = new Set(
      alreadyPresentRows.map((row) => row.product_id)
    );

    toInsert = candidateIds.filter(
      (id) => liveIds.has(id) && !alreadyPresent.has(id)
    );
  }

  if (existingCount + toInsert.length > ACCOUNT_WISHLIST_LIMIT) {
    return { kind: "limit_reached" };
  }

  for (const productId of toInsert) {
    await tx`
      INSERT INTO awcms_commerce_wishlists (tenant_id, customer_id, product_id)
      VALUES (${tenantId}, ${customerId}, ${productId})
      ON CONFLICT (customer_id, product_id) WHERE deleted_at IS NULL DO NOTHING
    `;
  }

  if (toInsert.length > 0) {
    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "create",
      resourceType: AUDIT_RESOURCE_TYPE_WISHLIST,
      message: `${toInsert.length} wishlist item(s) added.`,
      attributes: { customerId, count: toInsert.length },
      correlationId
    });
  }

  const items = await listAccountWishlist(tx, tenantId, customerId, mediaPort);
  return { kind: "merged", items };
}

/** `DELETE /account/wishlist/{productId}` — soft-delete; a no-op (still answered `204` by the route) when the product was never wishlisted or `productId` is not even UUID-shaped. */
export async function removeAccountWishlistItem(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  productId: string,
  correlationId?: string
): Promise<void> {
  if (!UUID_PATTERN.test(productId)) return;

  const rows = (await tx`
    UPDATE awcms_commerce_wishlists
    SET deleted_at = now()
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId} AND product_id = ${productId}
      AND deleted_at IS NULL
    RETURNING id
  `) as { id: string }[];

  if (rows.length === 0) return;

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "delete",
    resourceType: AUDIT_RESOURCE_TYPE_WISHLIST,
    resourceId: rows[0]!.id,
    message: "Wishlist item removed.",
    attributes: { customerId, productId },
    correlationId
  });
}
