/**
 * HTTP mapping of a loyalty-redemption refusal (Issue #363, ADR-0043),
 * shared by the storefront order route and the POS order route.
 *
 * Every refusal is a `409` with a stable machine code, found before any row of
 * the order was written (the storefront returns it, POS throws it and the route
 * maps it), so the response can be returned as it is. Details carry
 * only figures the caller already owns - their own balance, the largest number
 * of points that would fit - never another customer's data.
 */
import { fail } from "../../_shared/api-response";
import { LOYALTY_REDEMPTION_ERROR_CODES } from "../domain/loyalty-redemption";
import type { RedemptionRefusal } from "./loyalty-redemption";

type RefusalLike =
  | RedemptionRefusal
  | { code: typeof LOYALTY_REDEMPTION_ERROR_CODES.requiresAccount }
  | { code: typeof LOYALTY_REDEMPTION_ERROR_CODES.requiresCustomer };

export function loyaltyRefusalResponse(
  refusal: RefusalLike,
  headers?: Record<string, string>
): Response {
  switch (refusal.code) {
    case LOYALTY_REDEMPTION_ERROR_CODES.unavailable:
      return fail(
        409,
        refusal.code,
        "Loyalty points cannot be spent at this store right now.",
        {},
        undefined,
        headers
      );
    case LOYALTY_REDEMPTION_ERROR_CODES.requiresAccount:
      return fail(
        409,
        refusal.code,
        "Sign in to spend loyalty points.",
        {},
        undefined,
        headers
      );
    case LOYALTY_REDEMPTION_ERROR_CODES.requiresCustomer:
      return fail(
        409,
        refusal.code,
        "Attach the customer to the sale to spend loyalty points.",
        {},
        undefined,
        headers
      );
    case LOYALTY_REDEMPTION_ERROR_CODES.depositConflict:
      return fail(
        409,
        refusal.code,
        "Loyalty points cannot be combined with a down payment or deposit order.",
        {},
        undefined,
        headers
      );
    case LOYALTY_REDEMPTION_ERROR_CODES.customerUnavailable:
      return fail(
        409,
        refusal.code,
        "This customer cannot spend loyalty points.",
        {},
        undefined,
        headers
      );
    case LOYALTY_REDEMPTION_ERROR_CODES.exceedsLimit:
      return fail(
        409,
        refusal.code,
        refusal.reason === "cap"
          ? "That many points exceeds the share of the goods that points may pay for."
          : "That many points is worth more than the goods in this order.",
        {},
        { reason: refusal.reason, maxPoints: refusal.maxPoints },
        headers
      );
    case LOYALTY_REDEMPTION_ERROR_CODES.insufficientPoints:
      return fail(
        409,
        refusal.code,
        "There are not enough points.",
        {},
        { balance: refusal.balance, requested: refusal.requested },
        headers
      );
  }
}
