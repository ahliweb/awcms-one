/**
 * `awcms_commerce_courier_destinations` / `awcms_commerce_shipping_rates`
 * persistence — Issue #107 (contract #106's D4). The one place this module
 * ever calls a `ShippingRateProvider` (`domain/shipping-rate-provider.ts`).
 *
 * ## The transaction discipline this file exists to enforce
 *
 * ADR-0006/0010: an external provider call must never run inside an open DB
 * transaction. Both `resolveDestination` and `getCourierRates` below follow
 * the same three-step shape: read the cache in one short
 * `withTenantOrThrow` transaction, call the provider (if the cache missed)
 * with NO transaction open at all, then write the result back in a SECOND
 * short transaction. A concurrent miss on the same key is fine — the
 * write-back's `ON CONFLICT (...) DO UPDATE` makes the last writer win, it
 * never errors.
 */
import { getRegionByCode } from "../../idn-admin-regions/application/region-lookup";
import { withTenantOrThrow } from "../../../lib/database/tenant-context";
import { normalizeMoney } from "../domain/price-calculation";
import { computeWeightBucketGrams } from "../domain/weight-bucket";
import { formatCourierServiceId } from "../domain/courier-service-id";
import type { ShippingRateProvider } from "../domain/shipping-rate-provider";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NO_MATCH_REASON = "Tujuan belum dikenali kurir";
const PROVIDER_UNAVAILABLE_REASON = "Layanan pengiriman sedang tidak tersedia.";

export type CourierRateOption = {
  method: "courier";
  serviceId: string;
  courier: string;
  service: string;
  name: string;
  cost: string;
  etd: string | null;
  available: true;
};

export type CourierRatesResult =
  | { available: true; options: CourierRateOption[] }
  | { available: false; reason: string };

type CachedDestinationRow = { destination_id: string };
type CachedRateRow = {
  courier: string;
  service: string;
  name: string;
  cost: string;
  etd: string | null;
};

/**
 * Cache -> `idn_admin_regions` name lookup -> provider search -> store.
 * `null` when the district code does not resolve to a region, or the
 * provider's own search returns no usable candidate (both fold to the same
 * "courier unavailable" answer for the caller — `getCourierRates`).
 */
export async function resolveDestination(
  sql: Bun.SQL,
  tenantId: string,
  provider: ShippingRateProvider,
  providerKey: string,
  districtCode: string
): Promise<string | null> {
  const cached = await withTenantOrThrow(sql, tenantId, async (tx) => {
    const rows = (await tx`
      SELECT destination_id FROM awcms_commerce_courier_destinations
      WHERE tenant_id = ${tenantId} AND provider = ${providerKey} AND district_code = ${districtCode}
    `) as CachedDestinationRow[];
    return rows[0]?.destination_id ?? null;
  });
  if (cached) return cached;

  const region = await getRegionByCode(sql, districtCode);
  if (!region.region) return null;

  // `full_path_name`'s district + parent city name is the best free-text
  // query this module has for a provider's own name search — the district's
  // OWN name alone is frequently ambiguous across provinces (e.g. many
  // "Kecamatan Sukajadi"s), so the query always includes the parent city.
  const districtName = region.region.name;
  const cityName = (region.region.fullPathName ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .at(-2);
  const query = cityName ? `${districtName} ${cityName}` : districtName;

  const candidates = await provider.searchDestination(query).catch(() => []);

  const match =
    candidates.find(
      (candidate) =>
        candidate.districtName.toLowerCase() === districtName.toLowerCase() &&
        (!cityName ||
          candidate.cityName.toLowerCase().includes(cityName.toLowerCase()))
    ) ?? candidates[0];

  if (!match) return null;

  await withTenantOrThrow(sql, tenantId, async (tx) => {
    await tx`
      INSERT INTO awcms_commerce_courier_destinations (
        tenant_id, district_code, provider, destination_id, label
      )
      VALUES (${tenantId}, ${districtCode}, ${providerKey}, ${match.id}, ${match.label})
      ON CONFLICT (tenant_id, provider, district_code) DO UPDATE
        SET destination_id = EXCLUDED.destination_id,
            label = EXCLUDED.label,
            resolved_at = now(),
            updated_at = now()
    `;
  });

  return match.id;
}

/** Every non-expired cached rate for the given key set — a plain cache read, no provider call, safe to call from inside an already-open transaction (`order-directory.ts`'s own order-creation validation does exactly this). */
export async function findCachedRate(
  tx: Bun.SQL,
  tenantId: string,
  providerKey: string,
  originId: string,
  destinationId: string,
  weightGrams: number,
  courier: string,
  service: string
): Promise<{ cost: string; name: string } | null> {
  const weightBucket = computeWeightBucketGrams(weightGrams);
  const rows = (await tx`
    SELECT cost, name FROM awcms_commerce_shipping_rates
    WHERE tenant_id = ${tenantId} AND provider = ${providerKey}
      AND origin_id = ${originId} AND destination_id = ${destinationId}
      AND weight_bucket = ${weightBucket} AND courier = ${courier} AND service = ${service}
      AND expires_at > now()
  `) as { cost: string; name: string }[];

  const row = rows[0];
  return row ? { cost: normalizeMoney(row.cost), name: row.name } : null;
}

/**
 * `getCourierRates(sql, tenantId, {districtCode, weightGrams})` — Issue
 * #107's own signature. `couriers`/`originId` come from the tenant's own
 * `shipping.courier` settings (the caller's job to fetch and gate on
 * `enabled` before calling this at all).
 */
export async function getCourierRates(
  sql: Bun.SQL,
  tenantId: string,
  params: {
    districtCode: string;
    weightGrams: number;
    originId: string;
    couriers: string[];
  },
  provider: ShippingRateProvider,
  providerKey: string
): Promise<CourierRatesResult> {
  if (params.couriers.length === 0) {
    return { available: false, reason: NO_MATCH_REASON };
  }

  const destinationId = await resolveDestination(
    sql,
    tenantId,
    provider,
    providerKey,
    params.districtCode
  );
  if (!destinationId) {
    return { available: false, reason: NO_MATCH_REASON };
  }

  const weightBucket = computeWeightBucketGrams(params.weightGrams);

  const cachedByCourier = await withTenantOrThrow(sql, tenantId, async (tx) => {
    const rows = (await tx`
      SELECT courier, service, name, cost, etd
      FROM awcms_commerce_shipping_rates
      WHERE tenant_id = ${tenantId} AND provider = ${providerKey}
        AND origin_id = ${params.originId} AND destination_id = ${destinationId}
        AND weight_bucket = ${weightBucket}
        AND courier = ANY(${tx.array([...params.couriers], "text")}::text[])
        AND expires_at > now()
    `) as CachedRateRow[];

    const map = new Map<string, CachedRateRow>();
    for (const row of rows) map.set(row.courier, row);
    return map;
  });

  const missingCouriers = params.couriers.filter(
    (courier) => !cachedByCourier.has(courier)
  );

  let freshRates: CachedRateRow[] = [];
  if (missingCouriers.length > 0) {
    try {
      const fetched = await provider.getRates({
        originId: params.originId,
        destinationId,
        weightGrams: weightBucket,
        couriers: missingCouriers
      });
      freshRates = fetched.map((rate) => ({
        courier: rate.courier,
        service: rate.service,
        name: rate.name,
        cost: normalizeMoney(rate.cost),
        etd: rate.etd
      }));

      if (freshRates.length > 0) {
        const expiresAt = new Date(Date.now() + CACHE_TTL_MS);
        await withTenantOrThrow(sql, tenantId, async (tx) => {
          for (const rate of freshRates) {
            await tx`
              INSERT INTO awcms_commerce_shipping_rates (
                tenant_id, provider, origin_id, destination_id, weight_bucket,
                courier, service, name, cost, etd, fetched_at, expires_at
              )
              VALUES (
                ${tenantId}, ${providerKey}, ${params.originId}, ${destinationId}, ${weightBucket},
                ${rate.courier}, ${rate.service}, ${rate.name}, ${rate.cost}, ${rate.etd}, now(), ${expiresAt}
              )
              ON CONFLICT (tenant_id, provider, origin_id, destination_id, weight_bucket, courier, service)
              DO UPDATE SET
                name = EXCLUDED.name,
                cost = EXCLUDED.cost,
                etd = EXCLUDED.etd,
                fetched_at = EXCLUDED.fetched_at,
                expires_at = EXCLUDED.expires_at,
                updated_at = now()
            `;
          }
        });
      }
    } catch {
      // Provider call failed (timeout/circuit open/HTTP error) — fall
      // through with whatever the cache already had; a total miss with no
      // cache hits at all answers `available:false` below.
    }
  }

  const options: CourierRateOption[] = [
    ...cachedByCourier.values(),
    ...freshRates
  ].map((row) => ({
    method: "courier",
    serviceId: formatCourierServiceId(row.courier, row.service),
    courier: row.courier,
    service: row.service,
    name: row.name,
    cost: row.cost,
    etd: row.etd,
    available: true
  }));

  if (options.length === 0) {
    return { available: false, reason: PROVIDER_UNAVAILABLE_REASON };
  }

  return { available: true, options };
}

/**
 * Cache-only destination lookup — no provider call, safe inside an
 * already-open transaction. Used by `cart-quote-service.ts`'s
 * order-creation re-quote path (which must never call a provider from
 * inside `order-directory.ts`'s write transaction).
 */
export async function findCachedDestinationId(
  tx: Bun.SQL,
  tenantId: string,
  providerKey: string,
  districtCode: string
): Promise<string | null> {
  const rows = (await tx`
    SELECT destination_id FROM awcms_commerce_courier_destinations
    WHERE tenant_id = ${tenantId} AND provider = ${providerKey} AND district_code = ${districtCode}
  `) as CachedDestinationRow[];
  return rows[0]?.destination_id ?? null;
}

/** Cache-only rate lookup for a set of couriers — no provider call, safe inside an already-open transaction. Same caller as {@link findCachedDestinationId}. */
export async function findCachedRatesForCouriers(
  tx: Bun.SQL,
  tenantId: string,
  providerKey: string,
  originId: string,
  destinationId: string,
  weightGrams: number,
  couriers: string[]
): Promise<CourierRateOption[]> {
  if (couriers.length === 0) return [];
  const weightBucket = computeWeightBucketGrams(weightGrams);

  const rows = (await tx`
    SELECT courier, service, name, cost, etd
    FROM awcms_commerce_shipping_rates
    WHERE tenant_id = ${tenantId} AND provider = ${providerKey}
      AND origin_id = ${originId} AND destination_id = ${destinationId}
      AND weight_bucket = ${weightBucket}
      AND courier = ANY(${tx.array([...couriers], "text")}::text[])
      AND expires_at > now()
  `) as CachedRateRow[];

  return rows.map((row) => ({
    method: "courier",
    serviceId: formatCourierServiceId(row.courier, row.service),
    courier: row.courier,
    service: row.service,
    name: row.name,
    cost: normalizeMoney(row.cost),
    etd: row.etd,
    available: true
  }));
}

/** `commerce:shipping-rates:purge`'s own per-tenant work — every expired `awcms_commerce_shipping_rates` row, bounded per tick, mirroring `order-directory.ts`'s `expireOrdersForTenant` shape. */
export async function purgeExpiredShippingRatesForTenant(
  sql: Bun.SQL,
  tenantId: string,
  now: Date,
  batchLimit = 1000
): Promise<number> {
  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => {
      const rows = (await tx`
        DELETE FROM awcms_commerce_shipping_rates
        WHERE tenant_id = ${tenantId} AND id IN (
          SELECT id FROM awcms_commerce_shipping_rates
          WHERE tenant_id = ${tenantId} AND expires_at <= ${now}
          ORDER BY expires_at ASC
          LIMIT ${batchLimit}
        )
        RETURNING id
      `) as { id: string }[];
      return rows.length;
    },
    { workClass: "background_sync" }
  );
}
