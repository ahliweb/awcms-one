/**
 * Permission KEY CONSTANTS for the `commerce` catalog slice (Issue #4),
 * shaped after `media-library/domain/media-permissions.ts`: this file is the
 * single source for the key strings, and `module.ts`, the API routes, and
 * `sql/154`'s seed all derive from — or are checked against — it, so a key
 * can never drift between the descriptor, the code that checks it, and the
 * database row that grants it.
 *
 * Two activity codes, one per resource (`categories`, `products`), each with
 * the same four CRUD actions. There is no `restore` action: this slice ships
 * no restore endpoint (soft-deleted rows are retained for referential
 * integrity and future recovery tooling, but nothing in this issue reads or
 * writes them back), so seeding one would be exactly the "permission with no
 * enforcing code" defect class `media-library/domain/media-permissions.ts`'s
 * own header warns about (the revoked `attach`/`detach` keys).
 */
export const COMMERCE_CATEGORIES_ACTIVITY_CODE = "categories";
export const COMMERCE_PRODUCTS_ACTIVITY_CODE = "products";

export const COMMERCE_CATEGORY_PERMISSIONS = {
  /** Create a category. */
  create: "commerce.categories.create",
  /** Read category records (list/detail). */
  read: "commerce.categories.read",
  /** Update a category's name/slug/icon. */
  update: "commerce.categories.update",
  /** Soft delete a category. */
  delete: "commerce.categories.delete"
} as const;

export type CommerceCategoryPermissionKey =
  keyof typeof COMMERCE_CATEGORY_PERMISSIONS;
export type CommerceCategoryPermissionValue =
  (typeof COMMERCE_CATEGORY_PERMISSIONS)[CommerceCategoryPermissionKey];

export const COMMERCE_PRODUCT_PERMISSIONS = {
  /** Create a product. */
  create: "commerce.products.create",
  /** Read product records (list/detail). */
  read: "commerce.products.read",
  /**
   * Update a product's editable fields, including a legal status transition
   * (see `domain/product-status.ts`'s `LEGAL_TRANSITIONS`) — one action, not
   * split from plain field edits, because both go through the same
   * `PATCH /api/v1/commerce/products/{id}` request and this slice has no
   * second, narrower audience for the status alone (unlike
   * `media_library.media.adjudicate_rights`, split out because it crosses a
   * public-disclosure line — a product's status does not).
   */
  update: "commerce.products.update",
  /** Soft delete a product. */
  delete: "commerce.products.delete"
} as const;

export type CommerceProductPermissionKey =
  keyof typeof COMMERCE_PRODUCT_PERMISSIONS;
export type CommerceProductPermissionValue =
  (typeof COMMERCE_PRODUCT_PERMISSIONS)[CommerceProductPermissionKey];
