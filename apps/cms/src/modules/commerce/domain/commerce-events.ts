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
