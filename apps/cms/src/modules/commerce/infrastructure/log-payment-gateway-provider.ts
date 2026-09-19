/**
 * `log` payment-gateway provider (Issue #110, contract #106's D3) — a
 * deterministic, in-repo dev/CI adapter with NO external HTTP call, mirroring
 * `log-shipping-rate-provider.ts`/`log-whatsapp-provider.ts`'s own role for
 * their ports.
 *
 * `fetchStatus` must answer `paid` once 60 REAL seconds have elapsed since
 * the session was created, without sleeping in a test and without any
 * database/state of its own (this provider is a pure function of its
 * inputs). The trick: the creation timestamp is folded into `providerRef`
 * itself (`log:<orderCode>:<attempt>:<createdAtMs>`), so `fetchStatus` can
 * recover it and compare against an INJECTABLE clock — the same "pass a
 * `now: () => Date`" seam `flash-sale-status.ts`/`order-status.ts` already
 * use elsewhere in this module for deterministic time-based tests.
 */
import type {
  PaymentGatewayCreateSessionInput,
  PaymentGatewayProvider,
  PaymentGatewaySessionResult,
  PaymentGatewayStatusResult,
  PaymentGatewayWebhookResult
} from "../domain/payment-gateway-provider";

const DEFAULT_EXPIRY_MINUTES = 60;
export const LOG_PROVIDER_PAID_AFTER_MS = 60_000;

const PROVIDER_REF_PATTERN = /^log:(.+):(\d+):(\d+)$/;

export type LogPaymentGatewayProviderConfig = {
  /** `COMMERCE_STOREFRONT_PUBLIC_URL` — no trailing slash assumed either way, normalized below. */
  storefrontPublicUrl: string;
  expiryMinutes?: number;
  now?: () => Date;
};

function buildRedirectUrl(
  storefrontPublicUrl: string,
  orderCode: string
): string {
  const base = storefrontPublicUrl.replace(/\/+$/, "");
  return `${base}/pesanan?kode=${encodeURIComponent(orderCode)}&gateway=log`;
}

export function createLogPaymentGatewayProvider(
  config: LogPaymentGatewayProviderConfig
): PaymentGatewayProvider {
  const expiryMinutes = config.expiryMinutes ?? DEFAULT_EXPIRY_MINUTES;
  const clock = config.now ?? (() => new Date());

  return {
    async createSession(
      input: PaymentGatewayCreateSessionInput
    ): Promise<PaymentGatewaySessionResult> {
      const createdAtMs = clock().getTime();
      const providerRef = `log:${input.orderCode}:${input.attempt}:${createdAtMs}`;

      return {
        providerRef,
        redirectUrl: buildRedirectUrl(
          config.storefrontPublicUrl,
          input.orderCode
        ),
        expiresAt: new Date(createdAtMs + expiryMinutes * 60_000)
      };
    },

    async fetchStatus(
      providerRef: string
    ): Promise<PaymentGatewayStatusResult> {
      const match = PROVIDER_REF_PATTERN.exec(providerRef);
      const createdAtMs = match ? Number.parseInt(match[3]!, 10) : NaN;

      if (!match || Number.isNaN(createdAtMs)) {
        // Not a `log` provider ref at all (or malformed) — never guess.
        return {
          status: "pending",
          raw: { providerRef, reason: "unrecognized_ref" }
        };
      }

      const elapsedMs = clock().getTime() - createdAtMs;
      const status =
        elapsedMs >= LOG_PROVIDER_PAID_AFTER_MS ? "paid" : "pending";

      return { status, raw: { providerRef, elapsedMs } };
    },

    // The `log` provider never receives a real provider signature — this is
    // a dev/CI convenience, never wired to the public webhook intake route
    // (#113), which is Midtrans-only per contract #106's D3.
    async verifyWebhook(): Promise<PaymentGatewayWebhookResult> {
      return {
        ok: false,
        eventKey: "log:unsupported",
        providerRef: "",
        status: "pending"
      };
    }
  };
}
