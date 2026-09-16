/**
 * Permission KEY CONSTANTS for the `commerce` catalog slice (Issue #4,
 * extended to full product-model parity by Issue #23), shaped after
 * `media-library/domain/media-permissions.ts`: this file is the single
 * source for the key strings, and `module.ts`, the API routes, and
 * `sql/154`/`sql/158`'s seeds all derive from — or are checked against — it,
 * so a key can never drift between the descriptor, the code that checks it,
 * and the database row that grants it.
 *
 * Two activity codes, one per resource (`categories`, `products`), each with
 * the same five CRUD+restore actions. Issue #4 shipped only four (no
 * `restore`): a soft-deleted row was retained for referential integrity but
 * nothing read or wrote it back, and seeding an unenforced permission is
 * exactly the "permission with no enforcing code" defect class
 * `media-library/domain/media-permissions.ts`'s own header warns about (the
 * revoked `attach`/`detach` keys). Issue #23 adds the restore ROUTES
 * (`office-directory.ts`'s shape — `POST .../{id}/restore`), so the
 * permission is added in the same change as its enforcement, per that same
 * rule.
 *
 * `restore` reuses the `update` verb's audience rather than getting its own
 * activity — same choice `offices/[id]/restore.ts` makes for
 * `office_management.update`: un-deleting is an edit of a record's lifecycle
 * state, and the authority that may change a row may bring it back. It is
 * still its OWN permission key (not literally `.update`) because the
 * `admin-screen-coverage-check.ts` ledger and the OpenAPI/route guards need a
 * distinct key to point at, and a future policy may want to grant one without
 * the other (e.g. a support role that may restore but not otherwise edit).
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
  delete: "commerce.categories.delete",
  /** Restore a soft-deleted category (Issue #23). */
  restore: "commerce.categories.restore"
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
   *
   * Also gates `POST/PATCH/DELETE .../products/{id}/images` and
   * `.../variants` (Issue #23) — the images/variants sub-resources are part
   * of editing a product, not a separate resource with its own audience, the
   * same "one verb, one PATCH" reasoning already applied to `status` above.
   */
  update: "commerce.products.update",
  /** Soft delete a product. */
  delete: "commerce.products.delete",
  /** Restore a soft-deleted product (Issue #23). */
  restore: "commerce.products.restore"
} as const;

export type CommerceProductPermissionKey =
  keyof typeof COMMERCE_PRODUCT_PERMISSIONS;
export type CommerceProductPermissionValue =
  (typeof COMMERCE_PRODUCT_PERMISSIONS)[CommerceProductPermissionKey];
