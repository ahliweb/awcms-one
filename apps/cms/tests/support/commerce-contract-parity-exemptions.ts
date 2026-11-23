/**
 * awcms-one local divergence (issue #557): the commerce operations that do not yet
 * meet the contract-parity rules of upstream ahliweb/awcms#1385 / #1427
 * (`tests/openapi-rate-limit-and-idempotency-declared.test.ts`).
 *
 * Upstream's test requires the public contract to say `429` (with `Retry-After`)
 * and the `Idempotency-Key` header exactly where a handler applies them. The
 * `commerce` module was written before that rule: its handlers rate-limit and read
 * the key, but its OpenAPI fragment does not declare it on every operation, and
 * some operations declare the key through commerce's own key reader, which the
 * test's static call-graph scan (a literal `get("idempotency-key")`) cannot see.
 *
 * CONTRACT-FIRST EXEMPTIONS, like `ROUTE_PARITY_EXEMPTIONS` in
 * `scripts/api-spec-check.ts`: this file must be EMPTY again when issue #557
 * lands. The test fails when an entry is no longer needed (so it can only
 * shrink), and a NEW commerce operation that breaks the rule is not exempt.
 * Resolution on a subtree-sync conflict: keep ours, then re-derive the lists by
 * running the test.
 */
export const COMMERCE_CONTRACT_PARITY_EXEMPTIONS = {
  /** A rate-limited handler whose operation declares no `429`. */
  missing429: [
    "DELETE /api/v1/commerce/storefront/account/addresses/{id}",
    "DELETE /api/v1/commerce/storefront/account/wishlist/{productId}",
    "GET /api/v1/commerce/storefront/account/addresses",
    "GET /api/v1/commerce/storefront/account/affiliate",
    "GET /api/v1/commerce/storefront/account/affiliate/commissions",
    "GET /api/v1/commerce/storefront/account/conversations",
    "GET /api/v1/commerce/storefront/account/conversations/{id}",
    "GET /api/v1/commerce/storefront/account/entitlements",
    "GET /api/v1/commerce/storefront/account/entitlements/check",
    "GET /api/v1/commerce/storefront/account/loyalty",
    "GET /api/v1/commerce/storefront/account/orders",
    "GET /api/v1/commerce/storefront/account/orders/{orderCode}",
    "GET /api/v1/commerce/storefront/account/reviews",
    "GET /api/v1/commerce/storefront/account/wishlist",
    "GET /api/v1/commerce/storefront/products/{productId}/download",
    "PATCH /api/v1/commerce/storefront/account/addresses/{id}",
    "POST /api/v1/commerce/orders/{id}/payments",
    "POST /api/v1/commerce/pos/orders",
    "POST /api/v1/commerce/quotations/{id}/convert",
    "POST /api/v1/commerce/storefront/account/addresses",
    "POST /api/v1/commerce/storefront/account/addresses/{id}/default",
    "POST /api/v1/commerce/storefront/account/affiliate",
    "POST /api/v1/commerce/storefront/orders/{orderCode}/cancel",
    "POST /api/v1/commerce/storefront/orders/{orderCode}/payment-confirmations",
    "POST /api/v1/commerce/storefront/orders/{orderCode}/payment-gateway/sessions",
    "POST /api/v1/commerce/storefront/reviews",
    "POST /api/v1/commerce/webhooks/{provider}/{endpointToken}",
    "PUT /api/v1/commerce/storefront/account/wishlist"
  ],
  /** A `429` whose handler sends `Retry-After` but the operation does not declare it. */
  retryAfterUndeclared: [
    "DELETE /api/v1/commerce/storefront/account/push/subscriptions",
    "DELETE /api/v1/commerce/storefront/account/push/subscriptions/{id}",
    "GET /api/v1/commerce/segments/{id}/export.csv",
    "GET /api/v1/commerce/segments/{id}/members",
    "GET /api/v1/commerce/storefront/account/push/preferences",
    "GET /api/v1/commerce/storefront/account/push/subscriptions",
    "GET /api/v1/commerce/storefront/booking/availability",
    "GET /api/v1/commerce/storefront/booking/offerings",
    "GET /api/v1/commerce/storefront/booking/quote",
    "GET /api/v1/commerce/storefront/booking/reservations",
    "GET /api/v1/commerce/storefront/booking/reservations/{orderCode}",
    "GET /api/v1/commerce/storefront/booking/reservations/{orderCode}/cancellation-quote",
    "GET /api/v1/commerce/storefront/document-links/{token}",
    "GET /api/v1/commerce/storefront/orders/{orderCode}",
    "POST /api/v1/commerce/campaigns/{id}/preview",
    "POST /api/v1/commerce/campaigns/{id}/send",
    "POST /api/v1/commerce/document-deliveries",
    "POST /api/v1/commerce/pos/booking/lookup",
    "POST /api/v1/commerce/pos/booking/reservations/{id}/balance-payments",
    "POST /api/v1/commerce/segments/preview",
    "POST /api/v1/commerce/storefront/account/conversations",
    "POST /api/v1/commerce/storefront/account/conversations/{id}/messages",
    "POST /api/v1/commerce/storefront/account/otp/request",
    "POST /api/v1/commerce/storefront/account/otp/verify",
    "POST /api/v1/commerce/storefront/account/privacy/erasure",
    "POST /api/v1/commerce/storefront/account/privacy/export",
    "POST /api/v1/commerce/storefront/account/privacy/otp",
    "POST /api/v1/commerce/storefront/account/push/subscriptions",
    "POST /api/v1/commerce/storefront/booking/reservations",
    "POST /api/v1/commerce/storefront/booking/reservations/{orderCode}/cancel",
    "POST /api/v1/commerce/storefront/cart/quote",
    "POST /api/v1/commerce/storefront/orders",
    "PUT /api/v1/commerce/storefront/account/push/preferences"
  ],
  /** A handler that reads `Idempotency-Key` but the operation does not declare it. */
  keyUndeclared: [
    "POST /api/v1/commerce/affiliate-commissions/{id}/approve",
    "POST /api/v1/commerce/affiliate-commissions/{id}/pay",
    "POST /api/v1/commerce/affiliate-commissions/{id}/void",
    "POST /api/v1/commerce/campaigns/{id}/cancel",
    "POST /api/v1/commerce/campaigns/{id}/send",
    "POST /api/v1/commerce/orders/{id}/payment-gateway/reconcile",
    "POST /api/v1/commerce/storefront/account/addresses",
    "POST /api/v1/commerce/storefront/account/conversations",
    "POST /api/v1/commerce/storefront/account/conversations/{id}/messages",
    "POST /api/v1/commerce/storefront/account/otp/verify",
    "POST /api/v1/commerce/storefront/orders/{orderCode}/cancel",
    "POST /api/v1/commerce/storefront/orders/{orderCode}/payment-confirmations",
    "POST /api/v1/commerce/storefront/reviews"
  ],
  /** An operation that declares the key although the scan cannot see its handler read it. */
  keyUnread: [
    "PATCH /api/v1/commerce/booking/offering-links/{id}",
    "PATCH /api/v1/commerce/work-orders/{id}",
    "POST /api/v1/commerce/booking/cancellation-policies",
    "POST /api/v1/commerce/booking/cancellation-policies/{id}/approve",
    "POST /api/v1/commerce/booking/cancellation-policies/{id}/retire",
    "POST /api/v1/commerce/booking/offering-links",
    "POST /api/v1/commerce/booking/reservations",
    "POST /api/v1/commerce/booking/reservations/{id}/cancel",
    "POST /api/v1/commerce/booking/reservations/{id}/no-show",
    "POST /api/v1/commerce/booking/reservations/{id}/reschedule",
    "POST /api/v1/commerce/document-deliveries",
    "POST /api/v1/commerce/documents",
    "POST /api/v1/commerce/expenses",
    "POST /api/v1/commerce/expenses/{id}/cancel",
    "POST /api/v1/commerce/expenses/{id}/decision",
    "POST /api/v1/commerce/expenses/{id}/post",
    "POST /api/v1/commerce/expenses/{id}/reverse",
    "POST /api/v1/commerce/held-sales",
    "POST /api/v1/commerce/held-sales/{id}/discard",
    "POST /api/v1/commerce/held-sales/{id}/resume",
    "POST /api/v1/commerce/pos/booking/reservations/{id}/balance-payments",
    "POST /api/v1/commerce/pos/booking/reservations/{id}/check-in",
    "POST /api/v1/commerce/pos/booking/reservations/{id}/check-out",
    "POST /api/v1/commerce/quotations",
    "POST /api/v1/commerce/quotations/{id}/actions/{action}",
    "POST /api/v1/commerce/quotations/{id}/convert",
    "POST /api/v1/commerce/quotations/{id}/versions",
    "POST /api/v1/commerce/work-orders"
  ]
} as const satisfies Record<string, readonly string[]>;
