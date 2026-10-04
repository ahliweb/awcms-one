/**
 * `PaymentGatewayProvider` port (Issue #110, contract #106's D3) — modelled
 * exactly on `ShippingRateProvider` (`shipping-rate-provider.ts`): a plain
 * interface with no I/O of its own, implemented by
 * `infrastructure/midtrans-provider.ts` (the real adapter) and
 * `infrastructure/log-payment-gateway-provider.ts` (the deterministic
 * dev/CI adapter), and never called from inside an open DB transaction
 * (ADR-0006/0010, ADR-0017 D1) — `application/payment-gateway-directory.ts`
 * is the one place that calls it.
 *
 * `verifyWebhook` is part of the D3 contract but has no caller in this
 * issue — the webhook INTAKE route is #113's own scope. It is implemented by
 * both adapters here so the port stays whole for that later issue to build
 * against, exactly as `#106`'s contract already documents it.
 */

export type PaymentGatewayStatus =
  "pending" | "paid" | "expired" | "failed" | "refunded";

export type PaymentGatewayCreateSessionInput = {
  /** The order's own human-facing code (`awcms_commerce_orders.order_code`). */
  orderCode: string;
  /**
   * Which attempt this is for the order (1 for the first session, 2 for a
   * second after the first expired, …) — folded into the provider-facing
   * `order_id` (`${orderCode}-${attempt}`) so a provider `order_id` is
   * unique per ATTEMPT, never reused even for the same order.
   */
  attempt: number;
  /** Decimal string, e.g. `"150000.00"` — the order's own `total`. */
  grossAmount: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
};

export type PaymentGatewaySessionResult = {
  /** What this deployment stores as `awcms_commerce_payment_gateway_sessions.provider_ref` — unique per (provider, providerRef). */
  providerRef: string;
  redirectUrl: string;
  expiresAt: Date;
};

export type PaymentGatewayStatusResult = {
  status: PaymentGatewayStatus;
  /** The provider's own raw response — stored as `raw_status` for operator debugging, never trusted for anything beyond `status` above. */
  raw: unknown;
};

export type PaymentGatewayWebhookInput = {
  orderId: string;
  statusCode: string;
  grossAmount: string;
  transactionStatus: string;
  fraudStatus: string | null;
  signatureKey: string;
};

export type PaymentGatewayWebhookResult = {
  ok: boolean;
  eventKey: string;
  providerRef: string;
  status: PaymentGatewayStatus;
};

/**
 * Issue #287 (ADR-0033) - return money to the payer along the original
 * payment. `refundKey` is the idempotency key sent to the provider: the SAME
 * key for every attempt of one refund leg (the refund row's id), so a retry
 * after a timeout or a crash can never refund twice.
 */
export type PaymentGatewayRefundInput = {
  /** The provider-facing order id of the payment being refunded (`awcms_commerce_payment_allocations.provider_reference`). */
  providerRef: string;
  /** Decimal string, e.g. `"25000.00"`. */
  amount: string;
  refundKey: string;
  /** Short, non-personal reason text for the provider's own records. */
  reason: string;
};

export type PaymentGatewayRefundResult = {
  /**
   * `succeeded`: the provider confirms the money is going back (or already
   * went). `pending`: accepted, will settle later - the leg stays
   * `processing` and a retry asks again. `failed`: refused.
   */
  status: "succeeded" | "pending" | "failed";
  providerRefundId: string | null;
  /** A short machine code for `failed` (never a raw provider message). */
  failureCode: string | null;
  raw: unknown;
};

export interface PaymentGatewayProvider {
  createSession(
    input: PaymentGatewayCreateSessionInput
  ): Promise<PaymentGatewaySessionResult>;
  fetchStatus(providerRef: string): Promise<PaymentGatewayStatusResult>;
  verifyWebhook(
    input: PaymentGatewayWebhookInput
  ): Promise<PaymentGatewayWebhookResult>;
  /**
   * Optional (Issue #287): an adapter that cannot refund simply omits it, and
   * the refund leg is settled through the offline path by an operator holding
   * `commerce.refunds_offline.approve`. Called ONLY with no database
   * transaction open (`application/refund-execution.ts`).
   */
  refund?(
    input: PaymentGatewayRefundInput
  ): Promise<PaymentGatewayRefundResult>;
}
