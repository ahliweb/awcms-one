-- Issue #107 (part of epic #33, contract #106's D4) — RajaOngkir courier
-- rates: a district-code -> provider-destination-id cache
-- (`awcms_commerce_courier_destinations`) plus a per-(origin, destination,
-- weight bucket, courier, service) rate cache
-- (`awcms_commerce_shipping_rates`), TTL 6 hours. Same conventions as
-- `sql/901`'s header (not repeated in full here): `ENABLE` + `FORCE ROW
-- LEVEL SECURITY`, one tenant-isolation `USING` policy, `id uuid` PK
-- `DEFAULT gen_random_uuid()`, `created_at timestamptz DEFAULT now()`, an FK
-- index for every FK column, worker GRANTs for the purge job
-- (`commerce:shipping-rates:purge`) since neither table is covered by
-- `sql/019`'s `ALTER DEFAULT PRIVILEGES` (that only ever granted `awcms_app`).
--
-- Neither table carries a `deleted_at` — both are pure caches keyed by a
-- UNIQUE constraint with `ON CONFLICT DO UPDATE` upserts
-- (`application/shipping-rate-directory.ts`), and the purge job DELETEs
-- expired rows outright rather than soft-deleting them (there is nothing to
-- "restore" about a stale cached rate). `commerce/module.ts`'s
-- `dataLifecycle` descriptors for both tables therefore use
-- `executionMode: "generic"` with a bespoke purge predicate documented at
-- the registration site, not the standard `cursorColumn: "deleted_at"`
-- shape.
--
-- ## `awcms_commerce_courier_destinations`
--
-- ONE row per (tenant, provider, district_code): `district_code` is an
-- `awcms_idn_admin_regions` code (Issue #107's `getRegionByCode` is what
-- resolves it to a district/city name pair before the provider's own
-- destination search runs) — `application/shipping-rate-directory.ts`'s
-- `resolveDestination` reads this cache first and only calls the provider's
-- `GET /destination/domestic-destination` on a miss, storing the result
-- here so a district is looked up by name AT MOST ONCE per tenant per
-- provider, forever (barring the row's own purge/refresh). `resolved_at` is
-- purely informational (when the name search last ran) — this cache has no
-- TTL of its own; a district's provider destination id essentially never
-- changes, unlike a RATE, which is why only `awcms_commerce_shipping_rates`
-- below carries `expires_at`.
--
-- ## `awcms_commerce_shipping_rates`
--
-- ONE row per (tenant, provider, origin_id, destination_id, weight_bucket,
-- courier, service) — `weight_bucket` is the grams value
-- `domain/weight-bucket.ts`'s `computeWeightBucketGrams` produces (rounded
-- up to the next 100 g, minimum 1000 g — RajaOngkir's own minimum billable
-- weight), never the raw cart weight, so two carts that round to the same
-- bucket share one cache row. `expires_at` is `fetched_at + 6 hours`
-- (Issue #107's own TTL); `application/shipping-rate-directory.ts`'s
-- `getCourierRates` only ever reads a row where `expires_at > now()` as a
-- cache HIT, and `application/order-directory.ts`'s order-creation
-- validation makes the exact same "non-expired" check against this table
-- before accepting a chosen `{courier, service, cost}` — an order can never
-- be created against a stale/expired rate.

CREATE TABLE IF NOT EXISTS awcms_commerce_courier_destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  district_code text NOT NULL,
  provider text NOT NULL,
  destination_id text NOT NULL,
  label text NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_courier_destinations_tenant_provider_district_key
  ON awcms_commerce_courier_destinations (tenant_id, provider, district_code);

CREATE INDEX IF NOT EXISTS awcms_commerce_courier_destinations_tenant_idx
  ON awcms_commerce_courier_destinations (tenant_id);

-- `data-lifecycle:registry:check` requires an index covering both the
-- tenant column and this table's own cursor column (`resolved_at`) — the
-- generic purge/batching engine's own filter+order shape.
CREATE INDEX IF NOT EXISTS awcms_commerce_courier_destinations_tenant_resolved_idx
  ON awcms_commerce_courier_destinations (tenant_id, resolved_at);

ALTER TABLE awcms_commerce_courier_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_courier_destinations FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_courier_destinations_tenant_isolation
  ON awcms_commerce_courier_destinations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

GRANT SELECT, DELETE ON awcms_commerce_courier_destinations TO awcms_worker;

CREATE TABLE IF NOT EXISTS awcms_commerce_shipping_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  provider text NOT NULL,
  origin_id text NOT NULL,
  destination_id text NOT NULL,
  weight_bucket integer NOT NULL,
  courier text NOT NULL,
  service text NOT NULL,
  name text NOT NULL,
  cost numeric(14, 2) NOT NULL,
  etd text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_shipping_rates_weight_bucket_check
    CHECK (weight_bucket >= 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_shipping_rates_lookup_key
  ON awcms_commerce_shipping_rates
  (tenant_id, provider, origin_id, destination_id, weight_bucket, courier, service);

CREATE INDEX IF NOT EXISTS awcms_commerce_shipping_rates_tenant_idx
  ON awcms_commerce_shipping_rates (tenant_id);

-- `commerce:shipping-rates:purge`'s own scan: every expired row, across
-- tenants, bounded per tick.
CREATE INDEX IF NOT EXISTS awcms_commerce_shipping_rates_expires_at_idx
  ON awcms_commerce_shipping_rates (expires_at);

ALTER TABLE awcms_commerce_shipping_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_shipping_rates FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_shipping_rates_tenant_isolation
  ON awcms_commerce_shipping_rates
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

GRANT SELECT, DELETE ON awcms_commerce_shipping_rates TO awcms_worker;

COMMENT ON TABLE awcms_commerce_courier_destinations IS
  'Issue #107 (contract #106 D4) — tenant-scoped cache of an idn_admin_regions district code resolved to a courier provider''s own destination id; no TTL, resolved once per (tenant, provider, district).';
COMMENT ON TABLE awcms_commerce_shipping_rates IS
  'Issue #107 (contract #106 D4) — tenant-scoped courier rate cache keyed by (provider, origin, destination, weight bucket, courier, service); TTL 6 hours via expires_at, purged by commerce:shipping-rates:purge.';
