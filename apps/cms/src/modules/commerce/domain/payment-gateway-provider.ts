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

export interface PaymentGatewayProvider {
  createSession(
    input: PaymentGatewayCreateSessionInput
  ): Promise<PaymentGatewaySessionResult>;
  fetchStatus(providerRef: string): Promise<PaymentGatewayStatusResult>;
  verifyWebhook(
    input: PaymentGatewayWebhookInput
  ): Promise<PaymentGatewayWebhookResult>;
}
