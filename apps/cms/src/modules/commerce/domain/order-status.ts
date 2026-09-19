/**
 * Order status machine — Issue #29. Pure — no database, no I/O.
 *
 * Seven states, following the issue's own schema: `pending_payment` is the
 * only entry state (every order is created into it); `completed`,
 * `cancelled` and `expired` are terminal (no transition leaves them).
 *
 * `LEGAL_TRANSITIONS` states WHICH edges exist in the graph at all;
 * {@link actorMayApplyOrderStatus} additionally restricts WHO may walk a
 * given edge, per the issue's own words: "customer may only `cancel` while
 * `pending_payment`; admin everything; `system` `expired` after
 * `expires_at`." An admin may apply any transition the graph allows; a
 * customer may apply exactly one, and `system` (the expiry job AND, since
 * Issue #113, the payment-gateway webhook/reconcile path) may apply exactly
 * two: `pending_payment -> expired` (unchanged from Issue #29) and
 * `pending_payment -> paid` (new).
 *
 * ## Why there is no `paid -> refunded` edge (Issue #113 decision)
 *
 * Contract #106's D2 asked this issue to decide, and document, whether a
 * gateway-reported refund (Midtrans `refund`/`partial_refund`,
 * `gateway-status-mapping.ts`'s `"refunded"`) auto-transitions the order.
 * The decision is NO: `awcms_commerce_payment_events` still records the
 * refund notification (`outcome: 'applied'` if it is the first time this
 * `event_key` is seen, so the ledger is complete for the owner to read), but
 * `ORDER_STATUSES`/`LEGAL_ORDER_STATUS_TRANSITIONS` below deliberately have
 * NO `refunded` state and NO edge out of `paid` for it — a provider refund
 * notification can arrive from something the shopper or a fraud team
 * triggered directly at the gateway, outside this platform's own knowledge
 * of WHY, and auto-cancelling/refunding fulfilment (restock, affiliate
 * commission void, notifying the customer) on an unattended webhook is a
 * bigger blast radius than leaving the order `paid`/`processing`/`shipped`
 * until an owner reads the payment event and applies the existing manual
 * `admin` `-> cancelled` action themselves, with the context a human refund
 * decision needs. See `docs/cms.md`'s payment-gateway runbook section for
 * the same reasoning aimed at an operator, and
 * `application/order-directory.ts`'s `markOrderPaidBySystem` header for the
 * webhook/reconcile-side half of this decision.
 */
import type { OrderStatus } from "./commerce-order-types";

export type { OrderStatus };

export const ORDER_STATUSES: readonly OrderStatus[] = [
  "pending_payment",
  "paid",
  "processing",
  "shipped",
  "completed",
  "cancelled",
  "expired"
];

export type OrderStatusActor = "customer" | "admin" | "system";

export const LEGAL_ORDER_STATUS_TRANSITIONS: Record<
  OrderStatus,
  readonly OrderStatus[]
> = {
  pending_payment: ["paid", "cancelled", "expired"],
  paid: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["completed"],
  completed: [],
  cancelled: [],
  expired: []
};

export type OrderStatusTransitionResult =
  | { valid: true }
  | { valid: false; errors: { field: string; message: string }[] };

/** Every edge `system` may walk — the expiry job (Issue #29) and, since Issue #113, the payment-gateway webhook/reconcile path. */
const SYSTEM_LEGAL_TARGETS: readonly OrderStatus[] = ["expired", "paid"];

/**
 * Whether `actor` may move an order from `from` to `to` — the graph edge
 * must exist AND the actor must be one this edge is open to. An admin may
 * apply any legal edge; a customer may only `pending_payment -> cancelled`;
 * `system` (the `commerce:orders:expire` job, and, since Issue #113, the
 * payment-gateway webhook intake route and `commerce:payments:reconcile`
 * job) may only apply `pending_payment -> expired` or `pending_payment ->
 * paid` — never `-> refunded` (there is no such state; see this file's own
 * header for why a gateway refund notification is recorded, not
 * auto-applied).
 */
export function actorMayApplyOrderStatus(
  actor: OrderStatusActor,
  from: OrderStatus,
  to: OrderStatus
): boolean {
  if (!LEGAL_ORDER_STATUS_TRANSITIONS[from].includes(to)) return false;

  if (actor === "admin") return true;
  if (actor === "customer")
    return from === "pending_payment" && to === "cancelled";
  if (actor === "system") {
    return from === "pending_payment" && SYSTEM_LEGAL_TARGETS.includes(to);
  }
  return false;
}

/**
 * Validates one proposed transition, returning the same `{field, message}`
 * shape `product-status.ts`'s `applyProductStatus` uses elsewhere in this
 * module — so `application/order-directory.ts` can fold a rejection into an
 * ordinary 400/409 without a second error shape.
 */
export function applyOrderStatusTransition(
  actor: OrderStatusActor,
  from: OrderStatus,
  to: OrderStatus
): OrderStatusTransitionResult {
  if (from === to) {
    return {
      valid: false,
      errors: [{ field: "status", message: `Order is already "${from}".` }]
    };
  }

  if (!LEGAL_ORDER_STATUS_TRANSITIONS[from].includes(to)) {
    return {
      valid: false,
      errors: [
        {
          field: "status",
          message: `"${from}" cannot transition to "${to}".`
        }
      ]
    };
  }

  if (!actorMayApplyOrderStatus(actor, from, to)) {
    return {
      valid: false,
      errors: [
        {
          field: "status",
          message: `"${actor}" is not permitted to move an order from "${from}" to "${to}".`
        }
      ]
    };
  }

  return { valid: true };
}

/** `true` while the order may still receive a payment confirmation / show payment instructions. */
export function isOrderPayable(status: OrderStatus): boolean {
  return status === "pending_payment";
}

/** `true` while a customer may cancel the order themselves. */
export function isOrderCancellableByCustomer(status: OrderStatus): boolean {
  return actorMayApplyOrderStatus("customer", status, "cancelled");
}

/** `true` once a review may be left against the order (must be `completed`). */
export function isOrderReviewable(status: OrderStatus): boolean {
  return status === "completed";
}
