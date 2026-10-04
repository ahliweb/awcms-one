/**
 * The HTTP plumbing the returns / refunds routes share (Issue #287,
 * ADR-0033): the feature gate, the second permission a refund needs, and the
 * ONE mapping of every typed outcome to a response - declared once so seven
 * routes cannot drift into seven slightly different answers.
 *
 * Every refusal here was decided BEFORE anything was written (see
 * `return-directory.ts`'s header), so returning a response - which commits the
 * transaction - leaves no partial state behind.
 */
import { created, fail, ok } from "../../_shared/api-response";
import { authorizeInTransaction } from "../../identity-access/application/access-guard";
import { COMMERCE_PAYMENTS_ACTIVITY_CODE } from "../domain/commerce-permissions";
import { requireCommerceFeatureForOwnerRoute } from "./commerce-feature-gate";
import type {
  CreateRefundsOutcome,
  CreateReturnOutcome,
  LinkExchangeOutcome
} from "./return-directory";
import type {
  ExecuteRefundOutcome,
  OfflineRefundOutcome
} from "./refund-execution";
import type { SettleRefundRefusal } from "./refund-settlement";

/** `409 FEATURE_DISABLED` while the tenant's `returns` feature is off (it defaults OFF), else `null`. */
export function requireReturnsFeature(
  tx: Bun.SQL,
  tenantId: string
): Promise<Response | null> {
  return requireCommerceFeatureForOwnerRoute(tx, tenantId, "returns");
}

const REVOKE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PAYMENTS_ACTIVITY_CODE,
  action: "revoke"
} as const;

/**
 * A refund takes money out of the books, the act `commerce.payments.revoke`
 * exists to gate. Checked through the same chokepoint (and so written to the
 * same decision log) in addition to the route's own permission. `null` when
 * allowed, the finished denial otherwise.
 */
export async function requirePaymentsRevoke(
  tx: Bun.SQL,
  tenantId: string,
  tokenHash: string,
  now: Date
): Promise<Response | null> {
  const result = await authorizeInTransaction(
    tx,
    tenantId,
    tokenHash,
    now,
    REVOKE_GUARD
  );
  return result.allowed ? null : result.denied;
}

export function refusalResponse(refusal: SettleRefundRefusal): Response {
  switch (refusal.reason) {
    case "not_refundable":
      return fail(
        409,
        "REFUND_NOT_REFUNDABLE",
        "That payment cannot give back this amount.",
        {},
        { reversible: refusal.reversible }
      );
    case "register_session_not_found":
      return fail(404, "RESOURCE_NOT_FOUND", "Register session not found.");
    case "register_session_not_open":
      return fail(
        409,
        "REGISTER_SESSION_NOT_OPEN",
        "The register session is not open.",
        {},
        { status: refusal.status }
      );
    case "register_session_not_cashier":
      return fail(
        409,
        "NOT_SESSION_CASHIER",
        "Only the session's current cashier may pay a refund out of its drawer."
      );
    case "stored_value_refund_not_allowed":
    case "stored_value_account_unavailable":
      return fail(
        409,
        "PAYMENT_NOT_REVERSIBLE",
        "The gift card or store credit cannot take this value back.",
        {},
        { reason: refusal.reason }
      );
    case "store_credit_unavailable":
      return fail(
        409,
        "STORE_CREDIT_UNAVAILABLE",
        "Store credit cannot be issued for this refund.",
        {},
        { reason: refusal.detail }
      );
  }
}

/** The 201 body of a creation: the return, and the store credit it issued (its code is present ONLY here). */
export function createReturnResponse(outcome: CreateReturnOutcome): Response {
  switch (outcome.kind) {
    case "feature_disabled":
      return fail(
        409,
        "FEATURE_DISABLED",
        'The "returns" feature is disabled for this tenant.'
      );
    case "order_not_found":
      return fail(404, "RESOURCE_NOT_FOUND", "Order not found.");
    case "order_not_returnable":
      return fail(
        409,
        "ORDER_NOT_RETURNABLE",
        "Only an order whose sale is paid (or beyond) can have goods returned.",
        {},
        { status: outcome.status }
      );
    case "line_not_found":
      return fail(
        404,
        "RESOURCE_NOT_FOUND",
        "An order line was not found on this order.",
        {},
        { orderItemId: outcome.orderItemId }
      );
    case "quantity_exceeded":
      return fail(
        409,
        "RETURN_QUANTITY_EXCEEDED",
        "More units were requested than remain eligible to return.",
        {},
        {
          orderItemId: outcome.orderItemId,
          requested: outcome.requested,
          remaining: outcome.remaining
        }
      );
    case "shipping_refund_exceeded":
      return fail(
        409,
        "SHIPPING_REFUND_EXCEEDED",
        "The shipping refund exceeds the shipping that was charged.",
        {},
        { remaining: outcome.remaining }
      );
    case "exchange_order_invalid":
      return fail(
        409,
        "EXCHANGE_ORDER_INVALID",
        "The exchange order does not exist, is this order, or is cancelled."
      );
    case "refund_exceeds_refundable":
      return fail(
        409,
        "REFUND_EXCEEDS_REFUNDABLE",
        "The refund exceeds what the order's payments can still give back.",
        {},
        { refundable: outcome.refundable, requested: outcome.requested }
      );
    case "refund_refused":
      return refusalResponse(outcome.refusal);
    case "created":
    case "replayed":
      return created(outcome.body);
  }
}

export function createRefundsResponse(outcome: CreateRefundsOutcome): Response {
  switch (outcome.kind) {
    case "feature_disabled":
      return fail(
        409,
        "FEATURE_DISABLED",
        'The "returns" feature is disabled for this tenant.'
      );
    case "return_not_found":
      return fail(404, "RESOURCE_NOT_FOUND", "Return not found.");
    case "nothing_to_refund":
      return fail(
        409,
        "NOTHING_TO_REFUND",
        "Every part of this return already has a refund leg."
      );
    case "refund_exceeds_refundable":
      return fail(
        409,
        "REFUND_EXCEEDS_REFUNDABLE",
        "The refund exceeds what the order's payments can still give back.",
        {},
        { refundable: outcome.refundable, requested: outcome.requested }
      );
    case "refund_refused":
      return refusalResponse(outcome.refusal);
    case "created":
    case "replayed":
      return created(outcome.body);
  }
}

export function linkExchangeResponse(outcome: LinkExchangeOutcome): Response {
  switch (outcome.kind) {
    case "feature_disabled":
      return fail(
        409,
        "FEATURE_DISABLED",
        'The "returns" feature is disabled for this tenant.'
      );
    case "return_not_found":
      return fail(404, "RESOURCE_NOT_FOUND", "Return not found.");
    case "not_an_exchange":
      return fail(
        409,
        "NOT_AN_EXCHANGE",
        "Only a return recorded as an exchange has a replacement order."
      );
    case "already_linked":
      return fail(
        409,
        "EXCHANGE_ALREADY_LINKED",
        "This exchange already has a replacement order.",
        {},
        { exchangeOrderId: outcome.exchangeOrderId }
      );
    case "exchange_order_invalid":
      return fail(
        409,
        "EXCHANGE_ORDER_INVALID",
        "The exchange order does not exist, is the original order, or is cancelled."
      );
    case "linked":
    case "replayed":
      return ok({ return: outcome.return });
  }
}

export function executeRefundResponse(outcome: ExecuteRefundOutcome): Response {
  switch (outcome.kind) {
    case "feature_disabled":
      return fail(
        409,
        "FEATURE_DISABLED",
        'The "returns" feature is disabled for this tenant.'
      );
    case "not_found":
      return fail(404, "RESOURCE_NOT_FOUND", "Refund not found.");
    case "refused":
      return refusalResponse(outcome.refusal);
    case "provider_unavailable":
      return fail(
        503,
        "GATEWAY_UNAVAILABLE",
        "No payment-gateway adapter that can refund is configured; settle this refund offline instead.",
        {},
        { refund: outcome.refund }
      );
    case "failed":
      return fail(
        502,
        "PROVIDER_REFUND_FAILED",
        "The payment provider did not complete the refund. It can be retried or settled offline.",
        {},
        { refund: outcome.refund, failureCode: outcome.failureCode }
      );
    case "processing":
      return ok({ refund: outcome.refund, settled: false });
    case "already_settled":
      return ok({ refund: outcome.refund, settled: true });
    case "settled":
      return ok({
        refund: outcome.refund,
        settled: true,
        storeCredit: outcome.storeCredit
      });
  }
}

export function offlineRefundResponse(outcome: OfflineRefundOutcome): Response {
  switch (outcome.kind) {
    case "feature_disabled":
      return fail(
        409,
        "FEATURE_DISABLED",
        'The "returns" feature is disabled for this tenant.'
      );
    case "not_found":
      return fail(404, "RESOURCE_NOT_FOUND", "Refund not found.");
    case "refused":
      return refusalResponse(outcome.refusal);
    case "already_settled":
    case "settled":
      return ok({ refund: outcome.refund, settled: true });
  }
}
