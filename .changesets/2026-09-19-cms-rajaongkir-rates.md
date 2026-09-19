---
bump: minor
type: structure
impact: public
---

# RajaOngkir courier rates — provider port, cached rates, destination in quote, courier settings (C1)

Issue #107 (part of epic #33, C1; contract #106's D4). The first external-provider
integration under `commerce` (ADR-0006/0010's "external providers are commerce-owned
ports with env credentials, never called from inside a DB transaction").

**Schema** (`apps/cms/sql/924_awcms_commerce_shipping_rates_schema.sql`):
`awcms_commerce_courier_destinations` (a tenant's `idn_admin_regions` district code
resolved once to a provider's own destination id, no TTL) and
`awcms_commerce_shipping_rates` (a rate cache keyed by `(tenant, provider, origin,
destination, weight bucket, courier, service)`, TTL 6 hours). Both `FORCE RLS`,
indexed for the generic purge/batching path, `awcms_worker`-granted.

**Domain**: `shipping-rate-provider.ts` (the `ShippingRateProvider` port + `Rate`
type), `courier-service-id.ts` (`"jne:REG"` parse/format), `weight-bucket.ts`
(rounds up to the next 100 g, floored at 1000 g — RajaOngkir's own minimum billable
weight), `shipping.courier = {enabled, originDestinationId, couriers[]}` added to
`store-settings-validation.ts`.

**Application** (`shipping-rate-directory.ts`): `resolveDestination` (cache → name
search against `idn_admin_regions` → provider search → store) and `getCourierRates`
(cache read in a short transaction, provider call with NONE open, write-back in a
second short transaction — a concurrent miss just means the last writer wins under
the cache's own `UNIQUE` key). Adapters `infrastructure/rajaongkir-provider.ts`
(Komerce API v2: `GET /destination/domestic-destination`, `POST
/calculate/domestic-cost`, `withTimeout` + `getProviderCircuitBreaker
("commerce-rajaongkir")`) and `log-shipping-rate-provider.ts` (deterministic
fixtures), resolved by `COMMERCE_SHIPPING_RATE_PROVIDER=rajaongkir|log` (+
`COMMERCE_RAJAONGKIR_API_KEY`, `_BASE_URL`, `_TIMEOUT_MS`).

**Quote/order**: `POST .../cart/quote` accepts an optional `destination:
{districtCode}`; when `shipping.courier.enabled` AND a provider is configured AND a
destination is present, `shippingOptions[]`'s courier entries are live per-service
rates (`{method:"courier", serviceId:"jne:REG", name, cost, etd, available:true}`);
otherwise a single `available:false` placeholder with a `note`. `POST
.../orders`'s `shipping: {method:"courier", serviceId}` is validated against a
non-expired cached rate keyed off the delivery address's own `districtCode` — never
a second live provider call inside `createOrderFromCart`'s write transaction; a
stale/unknown selection answers the same `409 CART_CHANGED` (with a fresh quote)
every other price/stock/shipping mismatch does.

**Job**: `commerce:shipping-rates:purge` (hourly) deletes every expired
`awcms_commerce_shipping_rates` row, across tenants, bounded per tick.

**Store settings / admin**: owner `PUT /store-settings` gains `shipping.courier`;
`GET /api/v1/commerce/shipping/destinations?search=` (owner-only,
`settings.update`) backs the origin-destination picker; the public
`shipping.courierEnabled` is now derived — `true` only when `courier.enabled` AND a
provider is configured, never a raw copy of the stored flag.

**Tests**: unit (weight bucket, service-id parse/format, `buildShippingOptions`'s
courier branch, both adapters against a mocked `fetch`/fixtures) and integration
against a real migrated database (destination cache miss/hit, rate cache
hit/miss with the `log` provider, a quote with a destination, order-creation
validation against the cache) — `tests/integration/commerce-shipping-rates.
integration.test.ts`.

OpenAPI: `destination`/`shippingOptions` added to the quote request/result schemas,
new `GET /api/v1/commerce/shipping/destinations` path, bundled.

**Admin screen**: `/admin/commerce-settings` gains a courier section — an enabled
toggle, a debounced origin-destination search (against the new endpoint above,
rendered through a native `<datalist>` rather than custom list markup/JS) that
doubles as the id field, and a couriers multi-select (`jne`/`jnt`/`sicepat`/`pos`/
`tiki`/`anteraja`); it writes through the existing `PUT /store-settings`, i18n
`en`+`id`. `APP_BUDGET_BYTES` (`apps/cms/scripts/client-asset-budget.ts`) raised
from 231,000 to 231,500 B to fit the new (non-duplicative) control — reasoning
recorded in that file's own docblock.
