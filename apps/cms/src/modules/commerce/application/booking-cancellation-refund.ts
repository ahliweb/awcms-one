/**
 * The refund legs of a booking cancellation, written through the EXISTING refund
 * tables of ADR-0033 (Issue #381, ADR-0045 D4/D9).
 *
 * A cancellation is not "goods accepted back", so it rides a return of kind
 * `cancellation` (sql/1043): one return, ONE line on the service order item
 * (`reason = booking_cancelled`, `disposition = not_applicable`, so no restock
 * path exists), `goods_gross` equal to the decision's `final_refund`, no
 * shipping and no separate tax share, so `refund_total` equals `final_refund`
 * exactly. The legs are the legs {@link planRefundLegs} planned - newest payment
 * first, each capped at what its payment can still give back - written as
 * `pending` rows, which fires the database's refund cap trigger
 * (`awcms_commerce_refunds_cap_guard`) as the second guard.
 *
 * ## Nothing here settles money
 *
 * The legs are PLANNED under the tenant's service-account user (G3). Executing a
 * gateway leg, handing cash back, or attesting an offline refund stays with the
 * existing execute / offline routes and their own permissions
 * (`commerce.refunds.create` + `commerce.payments.revoke`,
 * `commerce.refunds_offline.approve`, control C-11); the service account holds
 * none of them. The order is not edited: the `returned` order-event row the
 * sales projections net is the only mark on it (ADR-0025 D3).
 *
 * Retry safety: the return and every leg have a source key derived from the
 * decision's (`booking-cancel:<reservation>`), unique per tenant, so a replay
 * that somehow reached this function again would collide instead of refunding
 * twice. The caller holds the order lock.
 */
/*
 * The statements live in `return-directory.ts`, the one writer of the returns,
 * return-lines and refunds tables (pinned by `commerce-returns-routes.test.ts`);
 * this module is the booking adapter's entry to them.
 */
export {
  recordCancellationReturn,
  type CancellationReturnInput
} from "./return-directory";
