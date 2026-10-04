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
  restore: "commerce.products.restore",
  /**
   * Issue #291 — download the catalog as CSV (a bulk read of the whole
   * catalog, hence the high-risk `export` action rather than plain `read`).
   */
  export: "commerce.products.export",
  /**
   * Issue #291 — dry-run and apply a catalog CSV import (a bulk write, hence
   * the high-risk `import` action rather than `create`/`update`). The import
   * additionally holds the caller to `create`/`update` per row implicitly: it
   * calls the same `createProduct`/`updateProduct` directory functions a
   * single-product request does, and the route requires BOTH
   * `commerce.products.import` and — via the handler — `create` + `update`.
   */
  import: "commerce.products.import"
} as const;

/**
 * Issue #291 — typed custom catalog attributes. `read` lists definitions;
 * `manage` creates/updates/deletes them. `manage` (not separate
 * create/update/delete) because a definition is schema, not data: one audience
 * — whoever may reshape what every product's attributes validate against and
 * what the public catalog API may expose — and a single high-risk action keeps
 * the SoD hook on one key. Reading/writing a product's attribute VALUES reuses
 * `commerce.products.read`/`.update` (see `COMMERCE_PRODUCT_PERMISSIONS`).
 */
export const COMMERCE_ATTRIBUTES_ACTIVITY_CODE = "attributes";

export const COMMERCE_ATTRIBUTE_PERMISSIONS = {
  read: "commerce.attributes.read",
  manage: "commerce.attributes.manage"
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

/**
 * Issue #267 (IRMbyDUS entitlement module) — an entitlement is granted only
 * as a side effect of an order reaching `paid` (the
 * `commerce.order_paid_entitlement_grantor` domain-event consumer), never
 * through a direct admin "create an entitlement" route, same "nothing to
 * enforce it" reasoning `COMMERCE_ORDER_PERMISSIONS`/`COMMERCE_AFFILIATE_
 * PERMISSIONS` already state — so there is no `create` action. `update`
 * gates the one admin mutation this module has: revoking a grant
 * (`POST .../entitlements/{id}/revoke`).
 *
 * NOT to be confused with `identity-access`'s `ENTITLEMENT_REQUIRED_POLICY`
 * (`domain/entitlement.ts`, ADR-0084 tenant/plan feature-gating) — this
 * activity code and its permission strings are namespaced `commerce.
 * entitlements.*`, a different module, a different concept. See `sql/936`'s
 * header for the full disambiguation.
 */
export const COMMERCE_ENTITLEMENTS_ACTIVITY_CODE = "entitlements";

export const COMMERCE_ENTITLEMENT_PERMISSIONS = {
  read: "commerce.entitlements.read",
  /** Gates the admin revoke transition only — grants happen only via the order-paid consumer. */
  update: "commerce.entitlements.update"
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

/**
 * POS due sales (Issue #285, ADR-0025). ONE permission — `create` — gating
 * the `allowDue: true` flag of `POST /api/v1/commerce/pos/orders`: finalizing
 * a sale that leaves a balance DUE hands goods over on credit, a different
 * authority from `COMMERCE_POS_PERMISSIONS.create` (ring up a settled sale).
 * Checked IN ADDITION to `commerce.pos.create`, only when the body asks for a
 * due sale (the handler's second `authorizeInTransaction`, the shape
 * `media/objects/{id}.ts` established). Own activity code rather than a
 * second action under `pos` so a tenant role can grant it (or withhold it)
 * without touching the cashier's base permission.
 */
export const COMMERCE_POS_DUE_ACTIVITY_CODE = "pos_due";

export const COMMERCE_POS_DUE_PERMISSIONS = {
  create: "commerce.pos_due.create"
} as const;

/**
 * Payment-allocation ledger (Issue #285, ADR-0025). Three actions, each with
 * its own enforcing route (no permission without one):
 *
 *   - `read`   — `GET .../orders/{id}/payments`, the tender-mix and
 *     outstanding-balance reports.
 *   - `create` — `POST .../orders/{id}/payments`, record an additional tender.
 *   - `revoke` — `POST .../orders/{id}/payments/{paymentId}/reversals`,
 *     record a compensating reversal. `revoke` is the platform's existing
 *     HIGH-RISK action verb (`identity-access`'s `AccessAction`), reused
 *     rather than adding a `reverse` verb to that upstream-owned union: taking
 *     recorded money back out of the books is exactly what the high-risk set
 *     (and the SoD rules a tenant may author against it) is for, so a role
 *     that may record a payment need not be trusted to un-record one.
 */
export const COMMERCE_PAYMENTS_ACTIVITY_CODE = "payments";

export const COMMERCE_PAYMENT_PERMISSIONS = {
  read: "commerce.payments.read",
  /** Record an additional payment (tender) against an order. */
  create: "commerce.payments.create",
  /** Record a compensating reversal of a payment (high-risk verb, see above). */
  revoke: "commerce.payments.revoke"
} as const;

/**
 * POS registers, register sessions and cash-up (Issue #284, ADR-0028). Four
 * activity codes, ten permissions, each with its own enforcing route, and
 * NONE implied by `commerce.pos.create` - ringing up a sale gives a cashier no
 * report, export, approval or administration authority (the issue's own
 * rule). Existing `AccessAction` verbs only; the upstream-owned union is not
 * widened (ADR-0025 D9's reasoning, again):
 *
 *   - `registers`: `read` (list), `create` (define), `update` (rename /
 *     relabel / (de)activate) - the manage-registers authority.
 *   - `register_sessions`: `read` (list/detail/cash-up report), `create`
 *     (OPEN a session), `update` (USE it: drawer movements, handover),
 *     `export` (the cash-up CSV - the platform's existing high-risk verb,
 *     because the file leaves the system).
 *   - `register_cash_ups`: `create` (CLOSE a session by counting the drawer),
 *     `approve` (decide a close whose gross variance exceeds the tenant's
 *     threshold - a high-risk verb, so a tenant may author SoD rules against
 *     it, e.g. "the cashier who counted may not also approve").
 *   - `register_corrections`: `approve` (post a compensating correction to a
 *     CLOSED session; high-risk for the same reason - it rewrites how a closed
 *     shift reads). `approve` rather than `create` on purpose: a correction is
 *     a supervised amendment, and the high-risk verb is what puts it under the
 *     action-time SoD check.
 */
export const COMMERCE_REGISTERS_ACTIVITY_CODE = "registers";
export const COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE = "register_sessions";
export const COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE = "register_cash_ups";
export const COMMERCE_REGISTER_CORRECTIONS_ACTIVITY_CODE =
  "register_corrections";

export const COMMERCE_REGISTER_PERMISSIONS = {
  read: "commerce.registers.read",
  create: "commerce.registers.create",
  update: "commerce.registers.update"
} as const;

export const COMMERCE_REGISTER_SESSION_PERMISSIONS = {
  read: "commerce.register_sessions.read",
  /** Open a session with an opening float. */
  create: "commerce.register_sessions.create",
  /** Use a session: drawer movements and handover. */
  update: "commerce.register_sessions.update",
  /** The cash-up CSV. */
  export: "commerce.register_sessions.export"
} as const;

export const COMMERCE_REGISTER_CASH_UP_PERMISSIONS = {
  /** Close a session (cash-up). */
  create: "commerce.register_cash_ups.create",
  /** Approve/reject a cash-up above the variance threshold. */
  approve: "commerce.register_cash_ups.approve"
} as const;

export const COMMERCE_REGISTER_CORRECTION_PERMISSIONS = {
  approve: "commerce.register_corrections.approve"
} as const;

/**
 * Closed-loop stored value — gift cards and store credit (Issue #288,
 * ADR-0030). Five activity codes, seven permissions, each with its own
 * enforcing route and NONE implied by `commerce.pos.create` /
 * `commerce.payments.create` (redeeming is only ever a TENDER on a payment, so
 * a cashier who can take a gift card as payment gets no authority to issue,
 * load, adjust, disable or report on one). Existing `AccessAction` verbs only;
 * the upstream-owned union is not widened (ADR-0025 D9's reasoning, again):
 *
 *   - `stored_value_programs`: `read`, `update` — the per-tenant program
 *     configuration (enable, expiry, refund policy, balance ceiling).
 *   - `stored_value`: `read` (accounts, ledger, the liability and reconcile
 *     reports), `create` (ISSUE a card and LOAD value onto it - money INTO the
 *     liability), `update` (disable / enable an account, run the expiry sweep).
 *   - `stored_value_adjustments`: `create` - a reasoned manual correction of a
 *     balance, deliberately SEPARATE from `stored_value.create`: a role that
 *     may sell a card to a paying customer is not thereby trusted to edit a
 *     balance by hand.
 *   - `stored_value_reconcile`: `approve` - repair a drifted projection
 *     (`approve` is the platform's high-risk verb, so a tenant may author SoD
 *     rules against it).
 */
export const COMMERCE_STORED_VALUE_PROGRAMS_ACTIVITY_CODE =
  "stored_value_programs";
export const COMMERCE_STORED_VALUE_ACTIVITY_CODE = "stored_value";
export const COMMERCE_STORED_VALUE_ADJUSTMENTS_ACTIVITY_CODE =
  "stored_value_adjustments";
export const COMMERCE_STORED_VALUE_RECONCILE_ACTIVITY_CODE =
  "stored_value_reconcile";

export const COMMERCE_STORED_VALUE_PROGRAM_PERMISSIONS = {
  read: "commerce.stored_value_programs.read",
  update: "commerce.stored_value_programs.update"
} as const;

export const COMMERCE_STORED_VALUE_PERMISSIONS = {
  read: "commerce.stored_value.read",
  /** Issue a card / credit and load value onto it. */
  create: "commerce.stored_value.create",
  /** Disable / enable an account; run the expiry sweep. */
  update: "commerce.stored_value.update"
} as const;

export const COMMERCE_STORED_VALUE_ADJUSTMENT_PERMISSIONS = {
  create: "commerce.stored_value_adjustments.create"
} as const;

export const COMMERCE_STORED_VALUE_RECONCILE_PERMISSIONS = {
  approve: "commerce.stored_value_reconcile.approve"
} as const;

/**
 * The commerce document lifecycle (Issue #286, ADR-0029): held sales,
 * quotations, quotation->order conversion, work orders and numbered
 * receipt/invoice documents. Five activity codes, thirteen permissions, each
 * with its own enforcing route, NONE implied by `commerce.pos.create` or by
 * each other - holding a cart, quoting, creating an order from a quote,
 * running a job and issuing a legal document are five different authorities.
 * Existing `AccessAction` verbs only; the upstream-owned union is not widened:
 *
 *   - `held_sales`: `read`/`create`/`update` act on the caller's OWN carts;
 *     `approve` (high-risk, so a tenant may author SoD rules against it) lets a
 *     supervisor see, resume or discard another cashier's.
 *   - `quotations`: `read`; `create` (new quotation or revision); `update`
 *     (send / accept / reject / cancel).
 *   - `quotation_conversions`: `create` - it creates an order, so it is its
 *     own key (and the handler additionally requires `commerce.pos_due.create`,
 *     because a conversion leaves the order with a balance due).
 *   - `work_orders`: `read` / `create` / `update` (status moves, reassignment).
 *   - `documents`: `read` (list, read, render/print); `create` (ISSUE - a
 *     numbered, irreversible act).
 */
export const COMMERCE_HELD_SALES_ACTIVITY_CODE = "held_sales";
export const COMMERCE_QUOTATIONS_ACTIVITY_CODE = "quotations";
export const COMMERCE_QUOTATION_CONVERSIONS_ACTIVITY_CODE =
  "quotation_conversions";
export const COMMERCE_WORK_ORDERS_ACTIVITY_CODE = "work_orders";
export const COMMERCE_DOCUMENTS_ACTIVITY_CODE = "documents";

export const COMMERCE_HELD_SALE_PERMISSIONS = {
  read: "commerce.held_sales.read",
  create: "commerce.held_sales.create",
  update: "commerce.held_sales.update",
  /** Supervisor override: another cashier's held sale. */
  approve: "commerce.held_sales.approve"
} as const;

export const COMMERCE_QUOTATION_PERMISSIONS = {
  read: "commerce.quotations.read",
  create: "commerce.quotations.create",
  update: "commerce.quotations.update"
} as const;

export const COMMERCE_QUOTATION_CONVERSION_PERMISSIONS = {
  create: "commerce.quotation_conversions.create"
} as const;

export const COMMERCE_WORK_ORDER_PERMISSIONS = {
  read: "commerce.work_orders.read",
  create: "commerce.work_orders.create",
  update: "commerce.work_orders.update"
} as const;

export const COMMERCE_DOCUMENT_PERMISSIONS = {
  read: "commerce.documents.read",
  create: "commerce.documents.create"
} as const;

/**
 * Loyalty points ledger (Issue #289, ADR-0026 D9). Four permissions on three
 * activity codes — NOT `commerce.loyalty.adjust`/`.redeem`: the
 * `AccessAction` union (identity-access, upstream-owned) has no
 * `adjust`/`redeem` member and widening it would add a divergence in an
 * upstream file to every future subtree sync. A redemption and a manual
 * adjustment are each the CREATION of a ledger row, so each is `create` on its
 * own activity code — which also keeps them separately grantable (a cashier
 * can redeem without being able to adjust, and neither implies `manage`).
 *
 * `manage` is already a high-risk action in `access-control.ts`
 * (`HIGH_RISK_ACTIONS`), which is the right posture for activating a program
 * version (it changes what every future order earns) and for repairing a
 * balance projection.
 */
export const COMMERCE_LOYALTY_ACTIVITY_CODE = "loyalty";
export const COMMERCE_LOYALTY_ADJUSTMENTS_ACTIVITY_CODE = "loyalty_adjustments";
export const COMMERCE_LOYALTY_REDEMPTIONS_ACTIVITY_CODE = "loyalty_redemptions";

export const COMMERCE_LOYALTY_PERMISSIONS = {
  /** Programs, accounts, the ledger and the summary. */
  read: "commerce.loyalty.read",
  /** Create/edit/activate/retire program versions; repair a drifted projection. */
  manage: "commerce.loyalty.manage"
} as const;

export const COMMERCE_LOYALTY_ADJUSTMENT_PERMISSIONS = {
  /** A manual signed adjustment — mandatory reason. */
  create: "commerce.loyalty_adjustments.create"
} as const;

export const COMMERCE_LOYALTY_REDEMPTION_PERMISSIONS = {
  /** Redeem points at the counter (or for a customer). */
  create: "commerce.loyalty_redemptions.create"
} as const;

/**
 * Commerce-local petty cash and operational expenses (Issue #294, ADR-0031).
 * Five activity codes, twelve permissions, each with its own enforcing route,
 * and NONE implied by `commerce.register_sessions.update` or
 * `commerce.pos.create` - being allowed to move cash in a drawer gives no
 * authority to book, approve or reverse an expense (the resource-split rule
 * ADR-0025 D9 and ADR-0028 D7 apply). Existing `AccessAction` verbs only; the
 * upstream-owned union is not widened:
 *
 *   - `expense_categories`: `read`, `create`, `update` (rename / deactivate).
 *   - `expenses`: `read` (list, detail, summary), `create` (a draft),
 *     `update` (edit or discard a draft), `export` (the CSV - the platform's
 *     high-risk verb, because the file leaves the system).
 *   - `expense_postings`: `create` (submit a draft for posting; posts it
 *     outright within the tenant threshold), `approve` (decide a pending
 *     expense above it - high-risk, so a tenant may author SoD rules).
 *   - `expense_reversals`: `approve` (reverse a posted expense with a
 *     compensating entry; `approve` rather than `create` on purpose - a
 *     reversal is a supervised amendment, and the high-risk verb is what puts
 *     it under the action-time SoD check).
 *   - `expense_receipts`: `read` (mint a short-lived presigned URL for the
 *     PRIVATE receipt - separate from `expenses.read` because a receipt can
 *     show a person's name or an account number), `create` (attach one).
 */
export const COMMERCE_EXPENSE_CATEGORIES_ACTIVITY_CODE = "expense_categories";
export const COMMERCE_EXPENSES_ACTIVITY_CODE = "expenses";
export const COMMERCE_EXPENSE_POSTINGS_ACTIVITY_CODE = "expense_postings";
export const COMMERCE_EXPENSE_REVERSALS_ACTIVITY_CODE = "expense_reversals";
export const COMMERCE_EXPENSE_RECEIPTS_ACTIVITY_CODE = "expense_receipts";

export const COMMERCE_EXPENSE_CATEGORY_PERMISSIONS = {
  read: "commerce.expense_categories.read",
  create: "commerce.expense_categories.create",
  update: "commerce.expense_categories.update"
} as const;

export const COMMERCE_EXPENSE_PERMISSIONS = {
  read: "commerce.expenses.read",
  create: "commerce.expenses.create",
  update: "commerce.expenses.update",
  export: "commerce.expenses.export"
} as const;

export const COMMERCE_EXPENSE_POSTING_PERMISSIONS = {
  /** Submit a draft for posting. */
  create: "commerce.expense_postings.create",
  /** Approve/reject an expense above the tenant's threshold. */
  approve: "commerce.expense_postings.approve"
} as const;

export const COMMERCE_EXPENSE_REVERSAL_PERMISSIONS = {
  approve: "commerce.expense_reversals.approve"
} as const;

export const COMMERCE_EXPENSE_RECEIPT_PERMISSIONS = {
  /** Mint a short-lived presigned GET for the private receipt. */
  read: "commerce.expense_receipts.read",
  /** Attach a private receipt to an expense. */
  create: "commerce.expense_receipts.create"
} as const;

/**
 * Transactional delivery of commercial documents (Issue #295, ADR-0034). Two
 * activity codes, three permissions, existing `AccessAction` verbs only, none
 * implied by `commerce.documents.*` / `quotations.*` / `work_orders.*` or by
 * each other - being allowed to read a receipt is not being allowed to send it:
 *
 *   - `document_deliveries`: `read` (a source's delivery history); `create`
 *     (send or re-send to the customer the source already names).
 *   - `document_delivery_overrides`: `create` - send to a recipient the source
 *     does NOT name. The one path by which a customer's purchase history can
 *     be pointed at an arbitrary address, so it is its own key.
 */
export const COMMERCE_DOCUMENT_DELIVERIES_ACTIVITY_CODE = "document_deliveries";
export const COMMERCE_DOCUMENT_DELIVERY_OVERRIDES_ACTIVITY_CODE =
  "document_delivery_overrides";

export const COMMERCE_DOCUMENT_DELIVERY_PERMISSIONS = {
  read: "commerce.document_deliveries.read",
  create: "commerce.document_deliveries.create"
} as const;

export const COMMERCE_DOCUMENT_DELIVERY_OVERRIDE_PERMISSIONS = {
  create: "commerce.document_delivery_overrides.create"
} as const;
