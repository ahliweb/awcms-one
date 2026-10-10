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

/**
 * Names of the `commerce` module's domain-event consumers (declared in
 * `commerce/module.ts` `domainEventConsumers`, ADR-0134). A consumer name is the
 * delivery row's `consumer_name`, the effect-ledger key and a metrics label:
 * NEVER rename a shipped one. Kept here, dependency-free, so the descriptor
 * stays import-light.
 */
export const COMMERCE_ORDER_PAID_ENTITLEMENT_GRANTOR_CONSUMER_NAME =
  "commerce.order_paid_entitlement_grantor";
export const COMMERCE_ORDER_PAID_LOYALTY_EARNER_CONSUMER_NAME =
  "commerce.order_paid_loyalty_earner";
export const COMMERCE_ORDER_CANCELLED_LOYALTY_REVERSER_CONSUMER_NAME =
  "commerce.order_cancelled_loyalty_reverser";
export const COMMERCE_INVENTORY_STOCK_CACHE_PROJECTOR_CONSUMER_NAME =
  "commerce.inventory_stock_cache_projector";

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

/**
 * Order/review events (Issue #29). `order.created` fires once, from the
 * anonymous `POST …/storefront/orders` path, in the SAME transaction that
 * inserts the order, decrements stock/flash-sale quota, and (when a voucher
 * was used) redeems it — see `application/order-directory.ts`'s
 * `createOrderFromCart`. `order.status_changed` fires on every OTHER legal
 * transition (`domain/order-status.ts`); `order.paid`/`.cancelled`/
 * `.expired` are additionally fired alongside it for the three transitions a
 * downstream consumer (e.g. a future fulfilment/notification module) is
 * most likely to key off directly, the same "a generic fact plus a named one
 * for the moments that matter" choice `product.status_changed` already
 * makes in this file for products.
 *
 * `voucher.redeemed` was pre-declared above (Issue #26) as a forward
 * reference; #29 is what actually fires it, registered here alongside the
 * order events in the SAME change, following this file's own rule.
 *
 * `review.published` fires when an admin moderates a pending review to
 * `published` (`application/review-directory.ts`) — never on creation, since
 * a review lands `pending` and is not yet a fact worth publishing to anyone.
 */
export const COMMERCE_ORDER_CREATED_EVENT_TYPE = "awcms.commerce.order.created";
export const COMMERCE_ORDER_PAID_EVENT_TYPE = "awcms.commerce.order.paid";
export const COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE =
  "awcms.commerce.order.status_changed";
export const COMMERCE_ORDER_CANCELLED_EVENT_TYPE =
  "awcms.commerce.order.cancelled";
export const COMMERCE_ORDER_EXPIRED_EVENT_TYPE = "awcms.commerce.order.expired";
export const COMMERCE_REVIEW_PUBLISHED_EVENT_TYPE =
  "awcms.commerce.review.published";

/**
 * Payment-allocation ledger events (Issue #285, ADR-0025). Both ride on the
 * ORDER aggregate (`commerce.order`, aggregate id = the order id), not on a
 * per-allocation aggregate: a consumer reconstructing "what happened to this
 * order" reads one ordered stream (`order.created`, `payment.recorded`,
 * `order.paid`, `payment.reversed`, ...) and the platform's per-aggregate
 * ordering key keeps a reversal from overtaking the payment it compensates.
 *
 * `payment.recorded` fires for every ledger leg that becomes a `succeeded`
 * payment (an operator-recorded tender, a POS tender, an accepted manual
 * transfer, a confirmed gateway leg) - NOT for a pending gateway leg (no
 * money has moved yet) and not for the one-time backfill (`sql/943` writes
 * history, it does not announce it). `payment.reversed` fires for every
 * compensating reversal. Payloads carry ids, tender, amounts and the order's
 * resulting settlement - never a customer name/phone and never a payment
 * reference. Registered in `domain-event-runtime/domain/event-type-registry.ts`
 * and `asyncapi/awcms-domain-events.asyncapi.yaml` in the same change (this
 * file's own rule).
 */
export const COMMERCE_PAYMENT_RECORDED_EVENT_TYPE =
  "awcms.commerce.payment.recorded";
export const COMMERCE_PAYMENT_REVERSED_EVENT_TYPE =
  "awcms.commerce.payment.reversed";

/**
 * POS register-session events (Issue #284, ADR-0028). All four ride on the
 * REGISTER SESSION aggregate (`commerce.register_session`, aggregate id = the
 * session id), so a consumer rebuilding "what happened in this shift" reads
 * one ordered stream: `opened`, `movement_recorded`..., `closed`,
 * `corrected`. A handover, a pending-approval close request and a rejected
 * close are recorded in the audit log only (they are not facts a downstream
 * consumer needs; `closed` is). Payloads carry ids, tender codes, amounts and
 * the variance - never a customer name/phone, and never a movement's free-text
 * reference/note. Registered in `domain-event-runtime/domain/event-type-
 * registry.ts` and `asyncapi/awcms-domain-events.asyncapi.yaml` in the same
 * change (this file's own rule).
 */
export const COMMERCE_REGISTER_SESSION_OPENED_EVENT_TYPE =
  "awcms.commerce.register_session.opened";
export const COMMERCE_REGISTER_SESSION_MOVEMENT_RECORDED_EVENT_TYPE =
  "awcms.commerce.register_session.movement_recorded";
export const COMMERCE_REGISTER_SESSION_CLOSED_EVENT_TYPE =
  "awcms.commerce.register_session.closed";
export const COMMERCE_REGISTER_SESSION_CORRECTED_EVENT_TYPE =
  "awcms.commerce.register_session.corrected";

/**
 * Closed-loop stored-value ledger event (Issue #288, ADR-0030). ONE type for
 * every ledger entry (issue, load, redeem, refund, adjust, expire, disable,
 * enable), on the STORED-VALUE ACCOUNT aggregate (`commerce.stored_value_
 * account`, aggregate id = the account id), so a consumer rebuilding "what
 * happened to this card" reads one ordered stream and filters on `entryKind`.
 * The payload carries ids, the kinds, the signed amount and the resulting
 * balance — never the code, the customer, or the free-text reason.
 * Registered in `domain-event-runtime/domain/event-type-registry.ts` and
 * `asyncapi/awcms-domain-events.asyncapi.yaml` in the same change.
 */
export const COMMERCE_STORED_VALUE_ENTRY_RECORDED_EVENT_TYPE =
  "awcms.commerce.stored_value.entry_recorded";

/**
 * Document-lifecycle events (Issue #286, ADR-0029). Four facts a downstream
 * consumer (accounting, CRM, a notification) needs; held sales and ordinary
 * quotation/work-order edits are audit-only. Payloads carry ids, numbers,
 * statuses and amounts - never a customer name/phone or a free-text note.
 * Registered in `domain-event-runtime/domain/event-type-registry.ts` and
 * `asyncapi/awcms-domain-events.asyncapi.yaml` in the same change.
 */
export const COMMERCE_QUOTATION_ACCEPTED_EVENT_TYPE =
  "awcms.commerce.quotation.accepted";
export const COMMERCE_QUOTATION_CONVERTED_EVENT_TYPE =
  "awcms.commerce.quotation.converted";
export const COMMERCE_WORK_ORDER_STATUS_CHANGED_EVENT_TYPE =
  "awcms.commerce.work_order.status_changed";
export const COMMERCE_DOCUMENT_ISSUED_EVENT_TYPE =
  "awcms.commerce.document.issued";
/**
 * Issue #295 (ADR-0034): a delivery of a commercial document was REQUESTED -
 * handed to the e-mail or WhatsApp outbox, or refused at the hand-off (a
 * suppressed address). It says nothing about the provider's outcome, which
 * lives in the outbox. The payload carries ids, the document number, the
 * channel and the hand-off status - never a recipient or message content.
 */
export const COMMERCE_DOCUMENT_DELIVERY_REQUESTED_EVENT_TYPE =
  "awcms.commerce.document.delivery_requested";
export const COMMERCE_DOCUMENT_DELIVERY_AGGREGATE_TYPE =
  "commerce.document_delivery";

export const COMMERCE_QUOTATION_AGGREGATE_TYPE = "commerce.quotation";
export const COMMERCE_WORK_ORDER_AGGREGATE_TYPE = "commerce.work_order";
export const COMMERCE_DOCUMENT_AGGREGATE_TYPE = "commerce.document";

/**
 * Loyalty points ledger (Issue #289, ADR-0026 D8). ONE event type for every
 * ledger row — an earn, redemption, expiry, adjustment or reversal — with the
 * `kind` in the payload, because every consumer that wants "the balance
 * changed" wants all five and a consumer that wants only one filters on
 * `kind` instead of subscribing five times. Fired from
 * `application/loyalty-ledger.ts`'s `appendLedgerEntry`, the only writer, in
 * the same transaction as the insert. The aggregate is the loyalty ACCOUNT
 * (not the order or the customer), so per-aggregate ordering of an account's
 * events matches its `account_seq` order. The payload carries no PII — never
 * a name, phone, or the free-text `reason`.
 */
export const COMMERCE_LOYALTY_ENTRY_RECORDED_EVENT_TYPE =
  "awcms.commerce.loyalty.entry_recorded";

export const COMMERCE_LOYALTY_ACCOUNT_AGGREGATE_TYPE =
  "commerce.loyalty_account";

/**
 * Expense events (Issue #294, ADR-0031). Both ride on the EXPENSE aggregate
 * (`commerce.expense`, aggregate id = the expense id). `posted` fires once, only
 * when an expense actually reaches `posted` (a pending submission or a
 * rejection does not); `reversed` fires once. Payloads carry ids, the category
 * id, the tender, the amount and the register session / movement ids - never
 * the free-text description, payee or reason. Registered in
 * `domain-event-runtime/domain/event-type-registry.ts` and
 * `asyncapi/awcms-domain-events.asyncapi.yaml` in the same change.
 */
export const COMMERCE_EXPENSE_POSTED_EVENT_TYPE =
  "awcms.commerce.expense.posted";
export const COMMERCE_EXPENSE_REVERSED_EVENT_TYPE =
  "awcms.commerce.expense.reversed";

export const COMMERCE_ORDER_AGGREGATE_TYPE = "commerce.order";
export const COMMERCE_EXPENSE_AGGREGATE_TYPE = "commerce.expense";
export const COMMERCE_STORED_VALUE_ACCOUNT_AGGREGATE_TYPE =
  "commerce.stored_value_account";
export const COMMERCE_REGISTER_SESSION_AGGREGATE_TYPE =
  "commerce.register_session";
export const COMMERCE_REVIEW_AGGREGATE_TYPE = "commerce.review";

/**
 * Returns and refunds (Issue #287, ADR-0033). Two event types, both on the
 * RETURN aggregate:
 *
 *   - `return.recorded` when goods were accepted back - the lines, quantities
 *     and value, never a customer name, phone or free-text note.
 *   - `refund.settled` when one refund leg reached `succeeded` - ids, tender,
 *     destination, amount and how it settled (`ledger` / `provider` /
 *     `offline` / `store_credit`). A failed attempt is an audit event, not a
 *     domain event: nothing downstream changed.
 *
 * Registered in `domain-event-runtime/domain/event-type-registry.ts`,
 * `module.ts`'s `events.publishes` and
 * `asyncapi/awcms-domain-events.asyncapi.yaml` in the same change.
 */
export const COMMERCE_RETURN_RECORDED_EVENT_TYPE =
  "awcms.commerce.return.recorded";
export const COMMERCE_REFUND_SETTLED_EVENT_TYPE =
  "awcms.commerce.refund.settled";
export const COMMERCE_RETURN_AGGREGATE_TYPE = "commerce.return";
