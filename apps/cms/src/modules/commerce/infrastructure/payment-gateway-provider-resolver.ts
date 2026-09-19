/**
 * Production resolver (Issue #110) — mirrors
 * `shipping-rate-provider-resolver.ts` exactly: picks the concrete
 * `PaymentGatewayProvider` from configuration, returning `null` on
 * misconfiguration rather than throwing, so "not configured" is trivially
 * distinguishable from "configured but currently failing" for the
 * storefront-facing session route's own `503 GATEWAY_UNAVAILABLE` and for
 * `payment.gatewayEnabled`'s public derivation.
 *
 * `log` is deliberately refused outside a non-production deployment
 * (`NODE_ENV === "production"`) — contract #106's own "log provider
 * forced-enabled in non-prod" note. An operator who leaves
 * `COMMERCE_PAYMENT_GATEWAY=log` set in a production `.env` by mistake gets
 * "gateway unavailable", never a live storefront quietly issuing fake
 * `paid` sessions.
 */
import type { PaymentGatewayProvider } from "../domain/payment-gateway-provider";
import { createLogPaymentGatewayProvider } from "./log-payment-gateway-provider";
import { createMidtransProvider } from "./midtrans-provider";

const KNOWN_PROVIDERS = new Set(["midtrans", "log"]);

export function resolvePaymentGatewayProviderKey(
  env: NodeJS.ProcessEnv = process.env
): "midtrans" | "log" | null {
  const provider = env.COMMERCE_PAYMENT_GATEWAY;
  return provider === "midtrans" || provider === "log" ? provider : null;
}

export function resolvePaymentGatewayProvider(
  env: NodeJS.ProcessEnv = process.env
): PaymentGatewayProvider | null {
  const provider = env.COMMERCE_PAYMENT_GATEWAY;

  if (!provider || !KNOWN_PROVIDERS.has(provider)) return null;

  if (provider === "log") {
    if (env.NODE_ENV === "production") return null;
    return createLogPaymentGatewayProvider({
      storefrontPublicUrl: env.COMMERCE_STOREFRONT_PUBLIC_URL ?? ""
    });
  }

  const serverKey = env.COMMERCE_MIDTRANS_SERVER_KEY;
  if (!serverKey) return null;

  return createMidtransProvider({
    serverKey,
    isProduction: env.COMMERCE_MIDTRANS_IS_PRODUCTION === "true",
    snapBaseUrl: env.COMMERCE_MIDTRANS_SNAP_BASE_URL,
    statusBaseUrl: env.COMMERCE_MIDTRANS_STATUS_BASE_URL,
    timeoutMs: env.COMMERCE_MIDTRANS_TIMEOUT_MS
      ? Number.parseInt(env.COMMERCE_MIDTRANS_TIMEOUT_MS, 10)
      : undefined,
    finishUrl: env.COMMERCE_STOREFRONT_PUBLIC_URL
      ? `${env.COMMERCE_STOREFRONT_PUBLIC_URL.replace(/\/+$/, "")}/pesanan`
      : undefined
  });
}

/** `application/store-settings-directory.ts`'s public-record derivation, and the session route's own "is this feature usable at all" gate. */
export function isPaymentGatewayProviderConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return resolvePaymentGatewayProvider(env) !== null;
}
