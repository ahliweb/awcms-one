/**
 * Production resolver (Issue #107) — mirrors
 * `email/infrastructure/email-provider-resolver.ts`: picks the concrete
 * `ShippingRateProvider` from configuration, returning `null` on
 * misconfiguration rather than throwing. `null` is deliberately different
 * from `email`'s "degrade to a failing provider" choice: courier rates are
 * an OPTIONAL storefront feature (`shipping.courier.enabled` gates it too),
 * so "not configured" must be trivially distinguishable from "configured but
 * currently failing" for `getCourierRates`'s own not-configured short
 * circuit and for the public store-settings `courierEnabled` derivation.
 */
import type { ShippingRateProvider } from "../domain/shipping-rate-provider";
import { createLogShippingRateProvider } from "./log-shipping-rate-provider";
import { createRajaOngkirProvider } from "./rajaongkir-provider";

const KNOWN_PROVIDERS = new Set(["rajaongkir", "log"]);

export function resolveShippingRateProvider(
  env: NodeJS.ProcessEnv = process.env
): ShippingRateProvider | null {
  const provider = env.COMMERCE_SHIPPING_RATE_PROVIDER;

  if (!provider || !KNOWN_PROVIDERS.has(provider)) return null;

  if (provider === "log") {
    return createLogShippingRateProvider();
  }

  const apiKey = env.COMMERCE_RAJAONGKIR_API_KEY;
  if (!apiKey) return null;

  return createRajaOngkirProvider({
    apiKey,
    baseUrl: env.COMMERCE_RAJAONGKIR_BASE_URL,
    timeoutMs: env.COMMERCE_RAJAONGKIR_TIMEOUT_MS
      ? Number.parseInt(env.COMMERCE_RAJAONGKIR_TIMEOUT_MS, 10)
      : undefined
  });
}

/** `application/store-settings-directory.ts`'s public-record derivation, and the destination-search route's own "is this feature usable at all" gate. */
export function isShippingRateProviderConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return resolveShippingRateProvider(env) !== null;
}
