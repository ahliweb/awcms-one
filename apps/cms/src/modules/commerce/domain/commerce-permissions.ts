/**
 * Permission KEY CONSTANTS for the `commerce` catalog slice (Issue #4,
 * extended to full product-model parity by Issue #23), shaped after
 * `media-library/domain/media-permissions.ts`: this file is the single
 * source for the key strings, and `module.ts`, the API routes, and
 * `sql/902`/`sql/906`'s seeds all derive from — or are checked against — it,
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

/**
 * Marketing-surface activity codes (Issue #26). Five resources, four CRUD
 * actions each (no `restore` — the issue's own API list never names one, and
 * seeding an unenforced permission is exactly the defect class this file's
 * header already warns against). `settings` is the one exception: it is a
 * SINGLETON (`awcms_commerce_store_settings`, one row per tenant, upserted
 * rather than created/deleted), so it gets only `read`/`update` — the same
 * two-action shape `site_profile`'s `profile.{read,update}` uses for the
 * same reason.
 */
export const COMMERCE_FLASH_SALES_ACTIVITY_CODE = "flash_sales";
export const COMMERCE_VOUCHERS_ACTIVITY_CODE = "vouchers";
export const COMMERCE_SLIDERS_ACTIVITY_CODE = "sliders";
export const COMMERCE_TESTIMONIALS_ACTIVITY_CODE = "testimonials";
export const COMMERCE_POPUPS_ACTIVITY_CODE = "popups";
export const COMMERCE_SETTINGS_ACTIVITY_CODE = "settings";

export const COMMERCE_FLASH_SALE_PERMISSIONS = {
  create: "commerce.flash_sales.create",
  /** Also gates the storefront's read model (`GET .../flash-sales/active`) and the `.../{id}/products` sub-resource routes — same "one verb per sub-resource edit" reasoning as `COMMERCE_PRODUCT_PERMISSIONS.update`. */
  read: "commerce.flash_sales.read",
  update: "commerce.flash_sales.update",
  delete: "commerce.flash_sales.delete"
} as const;

export const COMMERCE_VOUCHER_PERMISSIONS = {
  create: "commerce.vouchers.create",
  /** Also gates `GET .../vouchers/public` and `POST .../vouchers/validate` — a voucher lookup is a read, not a mutation. */
  read: "commerce.vouchers.read",
  update: "commerce.vouchers.update",
  delete: "commerce.vouchers.delete"
} as const;

export const COMMERCE_SLIDER_PERMISSIONS = {
  create: "commerce.sliders.create",
  read: "commerce.sliders.read",
  update: "commerce.sliders.update",
  delete: "commerce.sliders.delete"
} as const;

export const COMMERCE_TESTIMONIAL_PERMISSIONS = {
  create: "commerce.testimonials.create",
  read: "commerce.testimonials.read",
  update: "commerce.testimonials.update",
  delete: "commerce.testimonials.delete"
} as const;

export const COMMERCE_POPUP_PERMISSIONS = {
  create: "commerce.popups.create",
  read: "commerce.popups.read",
  update: "commerce.popups.update",
  delete: "commerce.popups.delete"
} as const;

/** Singleton settings row — see this section's header for why there is no `create`/`delete`. */
export const COMMERCE_SETTINGS_PERMISSIONS = {
  read: "commerce.settings.read",
  update: "commerce.settings.update"
} as const;

/**
 * Transactional-surface activity codes (Issue #29). `orders`/`customers`
 * get only `read`/`update` — no `create`/`delete` action, and deliberately
 * so: an order/customer is created only through the anonymous storefront
 * path (which checks NO permission at all — see this file's header on "a
 * permission with no enforcing code"), and this increment ships no admin
 * route that creates one directly or hard-deletes one. Declaring a
 * `create`/`delete` permission with nothing to enforce it is exactly the
 * defect class this file's header warns against; add the action in the
 * same change that ships its enforcing route. `reviews` gets
 * `read`/`update`/`delete`: a review is likewise created anonymously, but
 * an admin DOES get a real soft-delete route in this increment. `update`
 * on both `orders` and `reviews` means MODERATION/status-transition, not an
 * author editing their own text.
 */
export const COMMERCE_ORDERS_ACTIVITY_CODE = "orders";
export const COMMERCE_CUSTOMERS_ACTIVITY_CODE = "customers";
export const COMMERCE_REVIEWS_ACTIVITY_CODE = "reviews";

export const COMMERCE_ORDER_PERMISSIONS = {
  /** Also gates payment-confirmation review reads and the CSV export. */
  read: "commerce.orders.read",
  /** Also gates a status transition (including an admin-initiated cancel) and a payment-confirmation accept/reject. */
  update: "commerce.orders.update"
} as const;

export const COMMERCE_CUSTOMER_PERMISSIONS = {
  read: "commerce.customers.read",
  update: "commerce.customers.update"
} as const;

export const COMMERCE_REVIEW_PERMISSIONS = {
  read: "commerce.reviews.read",
  /** Moderation: publish or reject a pending review. */
  update: "commerce.reviews.update",
  delete: "commerce.reviews.delete"
} as const;

/**
 * Affiliate-program activity codes (Issue #92, contract #86's D5). Two
 * resources, `read`/`update` only — same "no `create`/`delete` action with
 * nothing to enforce it" reasoning as `COMMERCE_ORDER_PERMISSIONS` above: an
 * affiliate row is created only through the shopper's own bearer-secured
 * `POST .../account/affiliate` enrolment (no admin "create an affiliate"
 * route), and a commission row is created only as a side effect of an order
 * reaching `completed` (`application/order-directory.ts`'s
 * `transitionOrderStatus`) — never directly. `update` on
 * `affiliate_commissions` also gates the approve/pay/void transitions,
 * same "one verb, one moderation action" choice `COMMERCE_REVIEW_PERMISSIONS`
 * makes.
 */
export const COMMERCE_AFFILIATES_ACTIVITY_CODE = "affiliates";
export const COMMERCE_AFFILIATE_COMMISSIONS_ACTIVITY_CODE =
  "affiliate_commissions";

export const COMMERCE_AFFILIATE_PERMISSIONS = {
  read: "commerce.affiliates.read",
  /** Edit an affiliate's status (active/suspended) or commission rate. */
  update: "commerce.affiliates.update"
} as const;

export const COMMERCE_AFFILIATE_COMMISSION_PERMISSIONS = {
  read: "commerce.affiliate_commissions.read",
  /** Also gates the approve/pay/void state-machine transitions. */
  update: "commerce.affiliate_commissions.update"
} as const;

/**
 * WhatsApp outbox diagnostics (Issue #108, contract #106/ADR-0017 D5).
 * `read`-only — this issue ships one owner route
 * (`GET /api/v1/commerce/whatsapp/messages`), no admin create/update/delete
 * surface (a message is only ever created by the enqueue application
 * functions, never directly by an operator — same "no permission with
 * nothing to enforce it" reasoning `COMMERCE_ORDER_PERMISSIONS` states).
 */
export const COMMERCE_WHATSAPP_ACTIVITY_CODE = "whatsapp";

export const COMMERCE_WHATSAPP_PERMISSIONS = {
  read: "commerce.whatsapp.read"
} as const;

/**
 * Inbox activity code (Issue #111, contract #106 D8). `read`/`update` only
 * — same "no permission with nothing to enforce it" reasoning
 * `COMMERCE_ORDER_PERMISSIONS`/`COMMERCE_AFFILIATE_PERMISSIONS` already
 * state: a conversation is created only through the shopper's own
 * bearer-secured `POST .../account/conversations`, never by an admin
 * "start a conversation on a customer's behalf" route. `update` also gates
 * the staff reply (`POST .../conversations/{id}/messages`) and the
 * close/reopen status transition (`PATCH .../conversations/{id}`) — one
 * verb, one moderation audience, the same choice `COMMERCE_REVIEW_PERMISSIONS`
 * makes.
 */
export const COMMERCE_CONVERSATIONS_ACTIVITY_CODE = "conversations";

export const COMMERCE_CONVERSATION_PERMISSIONS = {
  read: "commerce.conversations.read",
  /** Also gates the staff reply and the close/reopen transition. */
  update: "commerce.conversations.update"
} as const;

/**
 * Campaigns activity code (Issue #114, contract #106 ADR-0017 D9). Three
 * actions, not the usual two: `send` is split out from `update` because it
 * is the one action that actually reaches a real inbox/phone — a role that
 * may draft and edit a campaign should not automatically be trusted to fire
 * it (and cancel it mid-flight), the same "narrower audience gets its own
 * key" reasoning `COMMERCE_CATEGORY_PERMISSIONS.restore`'s header already
 * states. `send` also gates `cancel` — one verb, one high-risk audience,
 * same choice `COMMERCE_REVIEW_PERMISSIONS`/`COMMERCE_AFFILIATE_PERMISSIONS`
 * make for their own moderation actions above.
 */
export const COMMERCE_CAMPAIGNS_ACTIVITY_CODE = "campaigns";

export const COMMERCE_CAMPAIGN_PERMISSIONS = {
  read: "commerce.campaigns.read",
  /** Create/edit a draft campaign. */
  update: "commerce.campaigns.update",
  /** Send (and cancel) a campaign — the one action that reaches a real inbox/phone. */
  send: "commerce.campaigns.send"
} as const;

/**
 * Payment-gateway webhook-endpoint tokens (Issue #110, contract #106's
 * D2/D3 OpenAPI note). ONE permission key gates the whole owner surface —
 * list (masked), create (plaintext token shown once), and revoke alike —
 * since the token itself never appears in the list either way, mirroring
 * `COMMERCE_AFFILIATE_PERMISSIONS`'s own "no distinct `create`/`delete`
 * action with nothing different to enforce" reasoning.
 */
export const COMMERCE_WEBHOOK_ENDPOINTS_ACTIVITY_CODE = "webhook_endpoints";

export const COMMERCE_WEBHOOK_ENDPOINT_PERMISSIONS = {
  /** Also gates list (masked) and create (token shown once). */
  update: "commerce.webhook_endpoints.update"
} as const;

/**
 * POS counter sales (Issue #116, contract #106's D6). ONE new permission —
 * `create` — is all this surface needs: the history read
 * (`GET /api/v1/commerce/pos/orders`) is gated on the EXISTING
 * `COMMERCE_ORDER_PERMISSIONS.read` (`commerce.orders.read`), since a POS
 * order is still an order and this increment does not need a narrower
 * "read POS orders only" audience than "read orders" already grants — see
 * `sql/932`'s own seed comment for the same reasoning.
 */
export const COMMERCE_POS_ACTIVITY_CODE = "pos";

export const COMMERCE_POS_PERMISSIONS = {
  /** The only order-creation path in this module gated by a permission at all — every other one is anonymous (storefront) or provider/system-driven (gateway webhook). */
  create: "commerce.pos.create"
} as const;
