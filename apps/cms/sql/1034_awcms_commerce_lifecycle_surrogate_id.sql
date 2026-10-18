-- A surrogate `id` on the thirteen commerce tables the generic purge engine
-- cannot delete from (Issue #377, the awcms#1040 descriptor-failure visibility
-- arriving with the v10.8.0 subtree sync).
--
-- ## What this fixes
--
-- The data-lifecycle generic purge deletes with
-- `DELETE FROM <t> WHERE id IN (SELECT id FROM <t> WHERE ... LIMIT n)`. It
-- needs a column named `id`. These thirteen tables are keyed by their natural
-- key instead (`(tenant_id, day, ...)` for the report projections, `tenant_id`
-- for the one-row-per-tenant settings), so every purge pass for their
-- descriptors raised `42703 column "id" does not exist`, and every dry run of
-- the date-cursor ones raised `22007` (the engine now casts its cutoff; see
-- `data-lifecycle/application/archive-purge-job.ts`). Until upstream made the
-- failure countable (`descriptorFailures`) nothing showed it: the retention of
-- these derived aggregates and settings simply never ran.
--
-- ## What this does
--
-- Adds `id uuid NOT NULL DEFAULT gen_random_uuid()` and a unique index on it to
-- each table. The natural primary key is untouched, so every projection upsert
-- (`ON CONFLICT (tenant_id, day, ...)`) and every report read keeps its shape;
-- `id` is a handle for the purge and nothing else. Existing rows get a value
-- from the default. Every table is small (a few rows per trading day per
-- tenant, or one per tenant), so the rewrite is cheap.
--
-- Idempotent: IF NOT EXISTS on the column and the index.

BEGIN;

ALTER TABLE awcms_commerce_store_settings
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_store_settings_id_uidx
  ON awcms_commerce_store_settings (id);

ALTER TABLE awcms_commerce_sales_daily
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_sales_daily_id_uidx
  ON awcms_commerce_sales_daily (id);

ALTER TABLE awcms_commerce_sales_by_product
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_sales_by_product_id_uidx
  ON awcms_commerce_sales_by_product (id);

ALTER TABLE awcms_commerce_sales_by_category
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_sales_by_category_id_uidx
  ON awcms_commerce_sales_by_category (id);

ALTER TABLE awcms_commerce_report_tender_daily
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_report_tender_daily_id_uidx
  ON awcms_commerce_report_tender_daily (id);

ALTER TABLE awcms_commerce_report_cash_up_tenders
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_report_cash_up_tenders_id_uidx
  ON awcms_commerce_report_cash_up_tenders (id);

ALTER TABLE awcms_commerce_report_expense_daily
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_report_expense_daily_id_uidx
  ON awcms_commerce_report_expense_daily (id);

ALTER TABLE awcms_commerce_report_loyalty_daily
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_report_loyalty_daily_id_uidx
  ON awcms_commerce_report_loyalty_daily (id);

ALTER TABLE awcms_commerce_report_stored_value_daily
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_report_stored_value_daily_id_uidx
  ON awcms_commerce_report_stored_value_daily (id);

ALTER TABLE awcms_commerce_report_returns_daily
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_report_returns_daily_id_uidx
  ON awcms_commerce_report_returns_daily (id);

ALTER TABLE awcms_commerce_report_retention_customers
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_report_retention_customers_id_uidx
  ON awcms_commerce_report_retention_customers (id);

ALTER TABLE awcms_commerce_report_retention_restated
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_report_retention_restated_id_uidx
  ON awcms_commerce_report_retention_restated (id);

ALTER TABLE awcms_commerce_loyalty_redemption_settings
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_loyalty_redemption_settings_id_uidx
  ON awcms_commerce_loyalty_redemption_settings (id);

COMMIT;
