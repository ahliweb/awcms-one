/**
 * `ShippingRateProvider` — the port every courier-rate adapter implements
 * (Issue #107, contract #106's D4). Pure types only, mirroring
 * `email/domain/email-provider-contract.ts`'s shape: one interface,
 * resolved to a concrete implementation at the edge
 * (`infrastructure/shipping-rate-provider-resolver.ts`), never imported by
 * name (`RajaOngkir...`) anywhere outside the adapter itself and its
 * resolver.
 *
 * Every method call is a real outbound HTTP request — callers (`application/
 * shipping-rate-directory.ts`) must run it through `withTimeout` +
 * `getProviderCircuitBreaker("commerce-rajaongkir")`, and NEVER from inside
 * an open DB transaction (ADR-0006/0010, this repo's `email`/object-storage
 * providers already follow the same rule).
 */

/** One candidate returned by a provider's destination name search. */
export type ShippingDestinationCandidate = {
  /** The provider's own opaque destination id — stored verbatim in `awcms_commerce_courier_destinations.destination_id`. */
  id: string;
  label: string;
  provinceName: string;
  cityName: string;
  districtName: string;
  subdistrictName: string | null;
  zipCode: string | null;
};

/** One rate line, already carrying a `numeric(14,2)` STRING cost (ADR-0003) — never a float. */
export type ShippingRate = {
  courier: string;
  service: string;
  name: string;
  cost: string;
  etd: string | null;
};

export type ShippingRateProvider = {
  /**
   * Name-search a courier's own destination directory — used exactly once
   * per (tenant, provider, district) by `resolveDestination`'s cache-miss
   * path. `query` is a district/city name pair joined by the caller (never
   * this port's concern how); returns the provider's own best-effort
   * candidate list, ordered however the provider ordered it.
   */
  searchDestination(query: string): Promise<ShippingDestinationCandidate[]>;

  /**
   * One rate per courier the caller asked for (a courier that has no
   * service to the given destination is simply absent from the result, not
   * an error) — `weightGrams` is always a pre-bucketed value
   * (`domain/weight-bucket.ts`), never the cart's raw weight.
   */
  getRates(params: {
    originId: string;
    destinationId: string;
    weightGrams: number;
    couriers: string[];
  }): Promise<ShippingRate[]>;
};
