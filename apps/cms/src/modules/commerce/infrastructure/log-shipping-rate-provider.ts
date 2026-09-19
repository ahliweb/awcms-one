/**
 * Log/fake `ShippingRateProvider` (Issue #107) — `COMMERCE_SHIPPING_RATE_
 * PROVIDER=log`. Returns deterministic fixture rates instead of calling a
 * real provider; always succeeds. Used for local development/CI without
 * real RajaOngkir credentials, mirroring
 * `email/infrastructure/log-email-provider.ts`.
 *
 * Deterministic on `destinationId` + `weightGrams` so tests can assert exact
 * numbers: each requested courier gets one REG-style service whose cost
 * scales with the bucketed weight (still a `numeric(14,2)` string, ADR-0003)
 * and a fixed 2-3 day ETD.
 */
import type {
  ShippingDestinationCandidate,
  ShippingRate,
  ShippingRateProvider
} from "../domain/shipping-rate-provider";

const BASE_COST_PER_KG = 9000;

export function createLogShippingRateProvider(): ShippingRateProvider {
  return {
    async searchDestination(
      query: string
    ): Promise<ShippingDestinationCandidate[]> {
      const trimmed = query.trim();
      if (trimmed.length === 0) return [];

      return [
        {
          id: `log-${trimmed.toLowerCase().replace(/\s+/g, "-")}`,
          label: trimmed,
          provinceName: "",
          cityName: trimmed,
          districtName: trimmed,
          subdistrictName: null,
          zipCode: null
        }
      ];
    },

    async getRates(params: {
      originId: string;
      destinationId: string;
      weightGrams: number;
      couriers: string[];
    }): Promise<ShippingRate[]> {
      const kilograms = Math.max(1, Math.ceil(params.weightGrams / 1000));

      return params.couriers.map((courier) => ({
        courier,
        service: "REG",
        name: `${courier.toUpperCase()} Reguler`,
        cost: (kilograms * BASE_COST_PER_KG).toFixed(2),
        etd: "2-3"
      }));
    }
  };
}
