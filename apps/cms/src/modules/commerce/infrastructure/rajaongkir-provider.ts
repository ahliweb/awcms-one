/**
 * RajaOngkir (Komerce API v2) adapter (Issue #107, contract #106's D4) — the
 * first real `ShippingRateProvider` implementation
 * (`../domain/shipping-rate-provider.ts`). Same shape
 * `email/infrastructure/mailketing-provider.ts` already follows: `withTimeout`
 * + `getProviderCircuitBreaker` live HERE, in the adapter, not in the
 * application layer, so `application/shipping-rate-directory.ts` only ever
 * calls a plain `ShippingRateProvider` method and never has to know it is
 * timeout/breaker-guarded.
 *
 * ## Wire shape (Komerce API v2, base `https://rajaongkir.komerce.id/api/v1`)
 *
 * Treated as the contract this file codes against, per Issue #107's own
 * instruction — the base URL is an env override
 * (`COMMERCE_RAJAONGKIR_BASE_URL`) so a future shape change is one env away,
 * not a code change:
 *
 * - `GET {baseUrl}/destination/domestic-destination?search=<name>&limit=5`,
 *   header `key: <apiKey>` -> `{ data: [{ id, label, province_name,
 *   city_name, district_name, subdistrict_name, zip_code }] }`.
 * - `POST {baseUrl}/calculate/domestic-cost`, header `key: <apiKey>`,
 *   `application/x-www-form-urlencoded` body `origin`, `destination`,
 *   `weight` (grams), `courier` (colon-separated codes, e.g.
 *   `"jne:jnt:sicepat"`) -> `{ data: [{ name, code, service, description,
 *   cost, etd }] }`.
 *
 * ## What counts toward the circuit breaker
 *
 * Only statements about the SERVICE — a network error, a timeout, a non-2xx
 * status, an unparseable body — never "this district has no destination
 * match" or "this courier has no service to this destination", both of
 * which are ordinary, expected `[]`/partial results from a provider that is
 * working fine (same rule `mailketing-provider.ts`'s header already states
 * for the sibling email port).
 */
import { getProviderCircuitBreaker } from "../../../lib/database/circuit-breaker";
import { withTimeout } from "../../../lib/integration/timeout";
import type {
  ShippingDestinationCandidate,
  ShippingRate,
  ShippingRateProvider
} from "../domain/shipping-rate-provider";

const PROVIDER_KEY = "commerce-rajaongkir";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BASE_URL = "https://rajaongkir.komerce.id/api/v1";
const DESTINATION_SEARCH_LIMIT = 5;

export type RajaOngkirProviderConfig = {
  apiKey: string;
  /** Override for tests/dev only — never request input (SSRF-safe). */
  baseUrl?: string;
  timeoutMs?: number;
};

type DestinationSearchResponse = {
  data?: {
    id?: string | number;
    label?: string;
    province_name?: string;
    city_name?: string;
    district_name?: string;
    subdistrict_name?: string | null;
    zip_code?: string | null;
  }[];
};

type CalculateCostResponse = {
  data?: {
    name?: string;
    code?: string;
    service?: string;
    description?: string;
    cost?: number | string;
    etd?: string | null;
  }[];
};

export class ShippingProviderCallFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShippingProviderCallFailedError";
  }
}

function normalizeCost(cost: number | string | undefined): string {
  const value =
    typeof cost === "number" ? cost : Number.parseFloat(cost ?? "0");
  const safe = Number.isFinite(value) ? value : 0;
  return safe.toFixed(2);
}

export function createRajaOngkirProvider(
  config: RajaOngkirProviderConfig
): ShippingRateProvider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const breaker = getProviderCircuitBreaker(PROVIDER_KEY);

  async function guardedFetch(
    label: string,
    request: () => Promise<Response>
  ): Promise<Response> {
    const now = new Date();

    if (!breaker.canAttempt(now)) {
      throw new ShippingProviderCallFailedError(
        "commerce-rajaongkir circuit is open."
      );
    }

    try {
      const response = await withTimeout(request(), timeoutMs, label);

      if (!response.ok) {
        breaker.recordFailure(new Date());
        throw new ShippingProviderCallFailedError(
          `RajaOngkir responded ${response.status} for "${label}".`
        );
      }

      breaker.recordSuccess(new Date());
      return response;
    } catch (error) {
      if (!(error instanceof ShippingProviderCallFailedError)) {
        breaker.recordFailure(new Date());
      }
      throw error;
    }
  }

  return {
    async searchDestination(
      query: string
    ): Promise<ShippingDestinationCandidate[]> {
      const url = new URL(`${baseUrl}/destination/domestic-destination`);
      url.searchParams.set("search", query);
      url.searchParams.set("limit", String(DESTINATION_SEARCH_LIMIT));

      const response = await guardedFetch("rajaongkir.searchDestination", () =>
        fetch(url, { headers: { key: config.apiKey } })
      );

      let body: DestinationSearchResponse;
      try {
        body = (await response.json()) as DestinationSearchResponse;
      } catch {
        throw new ShippingProviderCallFailedError(
          "RajaOngkir destination search returned an unparseable body."
        );
      }

      return (body.data ?? [])
        .filter((entry) => entry.id !== undefined && entry.id !== null)
        .map((entry) => ({
          id: String(entry.id),
          label: entry.label ?? "",
          provinceName: entry.province_name ?? "",
          cityName: entry.city_name ?? "",
          districtName: entry.district_name ?? "",
          subdistrictName: entry.subdistrict_name ?? null,
          zipCode: entry.zip_code ?? null
        }));
    },

    async getRates(params: {
      originId: string;
      destinationId: string;
      weightGrams: number;
      couriers: string[];
    }): Promise<ShippingRate[]> {
      if (params.couriers.length === 0) return [];

      const formData = new URLSearchParams({
        origin: params.originId,
        destination: params.destinationId,
        weight: String(params.weightGrams),
        courier: params.couriers.join(":")
      });

      const response = await guardedFetch("rajaongkir.calculateCost", () =>
        fetch(`${baseUrl}/calculate/domestic-cost`, {
          method: "POST",
          headers: {
            key: config.apiKey,
            "content-type": "application/x-www-form-urlencoded"
          },
          body: formData
        })
      );

      let body: CalculateCostResponse;
      try {
        body = (await response.json()) as CalculateCostResponse;
      } catch {
        throw new ShippingProviderCallFailedError(
          "RajaOngkir calculate-cost returned an unparseable body."
        );
      }

      return (body.data ?? [])
        .filter((entry) => entry.code && entry.service)
        .map((entry) => ({
          courier: entry.code!,
          service: entry.service!,
          name: entry.name ?? `${entry.code} ${entry.service}`,
          cost: normalizeCost(entry.cost),
          etd: entry.etd ?? null
        }));
    }
  };
}
