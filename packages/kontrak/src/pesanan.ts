/**
 * `OrderStatus`, `PaymentMethod`, `PaymentStatus`, `ShippingMethod`,
 * `CartLineStatus` — imported from `apps/cms`, not hand-copied (issue #6,
 * same discipline `katalog.ts`/`promosi.ts` already follow). Issue #29
 * (customers & orders) is the first thing `apps/storefront` needs from
 * `commerce`'s transactional surface, so this is a new file rather than
 * growing `promosi.ts` past its own "marketing surface" scope.
 *
 * Re-exporting the TYPE beats hand-copying it for the same reason
 * `katalog.ts`'s header gives: when `apps/cms` widens one of these unions, a
 * hand-copied one stays green and the storefront silently mis-reads the new
 * value; re-exporting turns that widening into the storefront's own compile
 * error at its first exhaustive `switch`.
 *
 * ## What is NOT re-exported here, and why
 *
 * The read-model DTO SHAPES (the cart quote result, the order tracking
 * record) stay out, same reasoning `katalog.ts`/`promosi.ts` give: they live
 * in `domain/cart-quote.ts` and `application/*.ts`, and the former —
 * although pure — composes several other pure modules' types into one large
 * inline object shape that is easier for `apps/storefront` to declare
 * locally (matching the contract document,
 * `commerce-storefront-endpoints.md`) than to import piecemeal. Only the
 * five closed, small, frequently-`switch`-ed-on unions are worth the import.
 *
 * `export type` only, no value — see `src/index.ts`'s docblock for why.
 */
export type {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  ShippingMethod,
  CartLineStatus
} from "awcms/src/modules/commerce/domain/commerce-order-types";
