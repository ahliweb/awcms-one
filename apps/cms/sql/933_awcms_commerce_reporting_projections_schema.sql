-- Commerce — sales-report read-model projection tables (Issue #117, part of
-- epic #33 C8; contract #106 / ADR-0017 D7).
--
-- Three DIMENSIONAL projection tables owned by `commerce`, maintained by the
-- `reporting` module's generic projection engine (Issue #753) through the
-- three `cursor_table` descriptors `commerce` contributes in its own
-- `module.ts` (`reportingProjections`): `commerce.sales_daily`,
-- `commerce.sales_by_product`, `commerce.sales_by_category`. The engine's
-- own tables (`awcms_reporting_projection_{state,cursors,metrics}`,
-- migration 015) keep carrying the cursor, the freshness bookkeeping and the
-- scalar "events consumed" counters; these three carry the per-day /
-- per-product / per-category money and quantity figures a scalar counter
-- cannot express.
--
-- ## Source and delta rules
--
-- The single source stream is `awcms_commerce_order_events` (migration 913),
-- an append-only status-transition log — the ONLY kind of source the
-- `cursor_table` strategy is correct for (see `reporting/README.md`
-- §Projections). `domain/sales-report-deltas.ts` holds the pure rules:
--
--   * an event `-> paid` ADDS the order's totals and its line items
--     (`application/sales-report-projection.ts` reads the order header,
--     the order items and each item's product category inside the same
--     transaction — a read of tables `commerce` already owns, never a write);
--   * an event `-> cancelled` or `-> refunded` whose `from_status` is a paid
--     state SUBTRACTS them again; a cancellation of an order that was never
--     paid contributes nothing.
--
-- Every figure is attributed to the DAY of the order's `paid_at` (falling
-- back to the event's own `created_at`), bucketed in the fixed reporting time
-- zone `SALES_REPORT_TIME_ZONE` (`domain/sales-report-deltas.ts`) — so a
-- reversal always lands on the same day row its payment landed on and the
-- day's `net` stays a true net. Changing that zone constant therefore
-- requires a rebuild (`POST /api/v1/reports/projections/{key}/rebuild`).
--
-- ## Idempotency, rebuild, reconciliation
--
-- Rows are UPSERTED by primary key with additive deltas
-- (`INSERT ... ON CONFLICT DO UPDATE SET x = x + EXCLUDED.x`), inside the
-- engine's own bounded pass transaction, AFTER the (tenant, projection)
-- advisory lock and BEFORE the cursor advance — the same crash-safe shape
-- migration 015's header describes. A rebuild deletes the tenant's rows
-- (`ProjectionDimensionalContract.resetForTenant`) in the SAME transaction
-- that resets the cursor, then re-derives everything through the identical
-- delta functions; reconciliation recomputes control totals through those
-- same functions and compares them with `SUM()` over these tables.
--
-- Money is `numeric(14, 2)` like every commerce money column (sql/901's
-- header has the arithmetic-drift reasoning); the application computes each
-- delta in integer cents and hands Postgres a decimal STRING, never a float.
-- `category_id` is NOT NULL on purpose (it is part of the primary key): a
-- product without a category is attributed to the all-zero sentinel uuid
-- `SALES_REPORT_UNCATEGORISED_ID`, which the read routes map back to
-- `categoryId: null`. No FK to `awcms_commerce_products`/`_categories`:
-- `product_name`/`category_name` are SNAPSHOTS (the same posture
-- `awcms_commerce_order_items.name` takes), and a purged product must not
-- make its own sales history unrebuildable.
--
-- ## Roles
--
-- `awcms_app` receives its verbs from migration 019's default privileges.
-- `awcms_worker` runs `bun run reporting:projections:refresh` (the incremental
-- worker AND the continuation of an in-progress rebuild), so it needs
-- SELECT + INSERT + UPDATE (the upsert, `ON CONFLICT DO UPDATE` requires
-- UPDATE — sql/022's header) on all three, plus DELETE for the generic
-- data-lifecycle purge (`data-lifecycle:archive-purge`, the same
-- `SELECT, DELETE` every lifecycle-registered commerce table carries). The
-- rebuild RESET's own DELETE runs in the API route's transaction as
-- `awcms_app`. The worker already holds SELECT on the four source tables
-- (sql/903, sql/915). Mirrored in `WORKER_ROLE_GRANTS`
-- (`scripts/security-readiness.ts`).
--
-- ## Retention / subject data
--
-- Retention: three `dataLifecycle` descriptors in `commerce/module.ts`
-- (`commerce.sales_daily` / `_by_product` / `_by_category`, cursor `day`,
-- the same 3650-day ceiling as `commerce.order_events` — a row older than
-- its source's retention can never be rebuilt and is safe to purge).
-- Subject data: `NO_SUBJECT_DATA` (`scripts/subject-data-coverage-check.ts`)
-- — a row is a day/product/category figure, never a fact about a person.

CREATE TABLE IF NOT EXISTS awcms_commerce_sales_daily (
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  day date NOT NULL,
  orders_paid integer NOT NULL DEFAULT 0,
  gross numeric(14, 2) NOT NULL DEFAULT 0,
  discount numeric(14, 2) NOT NULL DEFAULT 0,
  shipping numeric(14, 2) NOT NULL DEFAULT 0,
  net numeric(14, 2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day)
);

ALTER TABLE awcms_commerce_sales_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_sales_daily FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_sales_daily_tenant_isolation
  ON awcms_commerce_sales_daily
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_sales_by_product (
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  day date NOT NULL,
  product_id uuid NOT NULL,
  product_name text NOT NULL,
  qty integer NOT NULL DEFAULT 0,
  gross numeric(14, 2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day, product_id)
);

-- `GET /api/v1/reports/commerce/sales-by-product?from&to` groups a date
-- range by product; the primary key already leads on (tenant_id, day).
CREATE INDEX IF NOT EXISTS awcms_commerce_sales_by_product_product_idx
  ON awcms_commerce_sales_by_product (tenant_id, product_id);

ALTER TABLE awcms_commerce_sales_by_product ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_sales_by_product FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_sales_by_product_tenant_isolation
  ON awcms_commerce_sales_by_product
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_sales_by_category (
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  day date NOT NULL,
  category_id uuid NOT NULL,
  category_name text NOT NULL,
  qty integer NOT NULL DEFAULT 0,
  gross numeric(14, 2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day, category_id)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_sales_by_category_category_idx
  ON awcms_commerce_sales_by_category (tenant_id, category_id);

ALTER TABLE awcms_commerce_sales_by_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_sales_by_category FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_sales_by_category_tenant_isolation
  ON awcms_commerce_sales_by_category
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON awcms_commerce_sales_daily TO awcms_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON awcms_commerce_sales_by_product TO awcms_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON awcms_commerce_sales_by_category TO awcms_worker;
