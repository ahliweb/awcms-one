/**
 * `commerce` domain-event type/version constants (Issue #4), shaped after
 * `comments/domain/comment-events.ts`: kept in `domain/` with no imports so
 * `application/product-directory.ts`, the `domain_event_runtime` registry,
 * and the AsyncAPI parity check all reference the same literals rather than
 * three hand-typed strings.
 *
 * The matching entries live in
 * `domain-event-runtime/domain/event-type-registry.ts` and in
 * `asyncapi/awcms-domain-events.asyncapi.yaml`. They are kept in sync by
 * convention plus the contract gates — deliberately NOT by a cross-module
 * import, which would make the foundation runtime depend on this domain
 * module (same reasoning as `comment-events.ts`'s own header).
 *
 * Three events, all on the `product` aggregate — categories publish none, the
 * same choice `tenant_admin` makes for the structurally closest table in this
 * base (`awcms_offices`): a soft delete/restore is recorded in the audit log
 * only, not published. `product.created`/`.updated` cover the routine catalog
 * edits; `product.status_changed` is its own event, not folded into
 * `.updated`, because "this product stopped being sellable" (or started
 * being) is the one moment a future consumer — a search index, a storefront
 * cache — actually needs to react to, and folding it into a generic update
 * would force that consumer to diff the payload to find out.
 */
export const COMMERCE_EVENT_VERSION = "1.0";

export const COMMERCE_PRODUCT_CREATED_EVENT_TYPE =
  "awcms.commerce.product.created";
export const COMMERCE_PRODUCT_UPDATED_EVENT_TYPE =
  "awcms.commerce.product.updated";
export const COMMERCE_PRODUCT_STATUS_CHANGED_EVENT_TYPE =
  "awcms.commerce.product.status_changed";

export const COMMERCE_PRODUCT_AGGREGATE_TYPE = "commerce.product";

/**
 * Marketing-surface events (Issue #26). `flash_sale.{started,ended}` are
 * producer-fired by the `commerce:flash-sales:tick` job
 * (`scripts/commerce-flash-sales-tick.ts`) the moment
 * `domain/flash-sale-status.ts`'s `deriveFlashSaleStatus` crosses into
 * `active`/`ended` for a row — never by a direct admin PATCH, since a human
 * can only ever set `draft`/`scheduled` (see that file's header).
 * `voucher.redeemed` is declared here ONLY as a forward reference for #29 —
 * issue #26 ships `POST .../vouchers/validate` as a pure, non-mutating
 * check, so nothing in this module ever calls `appendDomainEvent` with it.
 * Deliberately NOT yet added to `module.ts`'s `events.publishes`, NOT
 * registered in `domain-event-runtime/domain/event-type-registry.ts`, and
 * NOT in the AsyncAPI spec — registering an event nothing produces yet would
 * be the same "permission/event admitted ahead of its enforcement" defect
 * class `commerce-permissions.ts`'s header already warns against for
 * permissions. #29 registers it in all three places in the same change that
 * makes it fire, alongside the code that actually redeems a voucher.
 * `flash_sale.{started,ended}` ARE registered in both places below — this
 * module's own tick job is what emits them.
 *
 * Kept in sync with `domain-event-runtime/domain/event-type-registry.ts` by
 * convention plus the AsyncAPI parity gate, same as every other constant in
 * this file — see this file's header for why that is NOT a cross-import.
 */
export const COMMERCE_FLASH_SALE_STARTED_EVENT_TYPE =
  "awcms.commerce.flash_sale.started";
export const COMMERCE_FLASH_SALE_ENDED_EVENT_TYPE =
  "awcms.commerce.flash_sale.ended";
export const COMMERCE_VOUCHER_REDEEMED_EVENT_TYPE =
  "awcms.commerce.voucher.redeemed";

export const COMMERCE_FLASH_SALE_AGGREGATE_TYPE = "commerce.flash_sale";
export const COMMERCE_VOUCHER_AGGREGATE_TYPE = "commerce.voucher";
