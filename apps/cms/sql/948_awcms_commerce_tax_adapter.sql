-- Issue #293 (ADR-0039) — the commerce adapter from the flat store-level tax
-- percentage to upstream AWCMS's `tax` module (ADR-0127, `sql/171`–`sql/173`).
--
-- Three additive pieces, all NULLable/defaulted, so every existing row and every
-- existing code path keeps its behaviour:
--
--   1. `awcms_commerce_store_settings.tax_mode` / `.tax_profile_code` — the
--      per-tenant switch. `flat` (the default, and what every tenant is today)
--      computes tax as `percent` of `subtotal - voucher discount`; `engine`
--      asks the tax module. They are REAL COLUMNS, not part of the `settings`
--      jsonb blob, for the same reason `affiliate_commission_rate` is (`sql/921`):
--      the admin's full-replace `PUT /store-settings` must not be able to flip
--      or clobber them. Only the audited cut-over tooling writes them.
--   2. `awcms_commerce_products.tax_category_code` — the product's tax class, an
--      opaque code that a tax rule version may name (NULL = "standard", i.e. the
--      version's fallback rule). Product level only: a variant is a size or a
--      colour of the same supply, never a different tax class (ADR-0039 D1).
--   3. `awcms_commerce_orders.tax_snapshot_id` — the tax snapshot finalised for
--      this order in engine mode (NULL on every flat-mode order, and on every
--      order placed before the cut-over). A composite tenant FK to
--      `awcms_tax_snapshots (tenant_id, id)`, whose unique key `sql/172` ships.
--      `ON DELETE SET NULL (tax_snapshot_id)`: the snapshot ledger's retention
--      may remove an aged snapshot, which must not be blocked by (or cascade
--      into) the order that cites it. The order keeps its own `tax` figure.
--
-- ADR-0037 D2: this migration depends only on lower-numbered objects (upstream
-- 171–173 and commerce <= 947). It deliberately references NO returns or report
-- table: a refund's tax reversal is a snapshot of kind `reversal` in the tax
-- module's own ledger, keyed by the return id as its document id.

ALTER TABLE awcms_commerce_store_settings
  ADD COLUMN IF NOT EXISTS tax_mode text NOT NULL DEFAULT 'flat';

ALTER TABLE awcms_commerce_store_settings
  ADD COLUMN IF NOT EXISTS tax_profile_code text NOT NULL DEFAULT 'store-default';

ALTER TABLE awcms_commerce_store_settings
  DROP CONSTRAINT IF EXISTS awcms_commerce_store_settings_tax_mode_check;

ALTER TABLE awcms_commerce_store_settings
  ADD CONSTRAINT awcms_commerce_store_settings_tax_mode_check
  CHECK (tax_mode IN ('flat', 'engine'));

-- The tax module's own CODE_PATTERN (`tax-validation.ts`).
ALTER TABLE awcms_commerce_store_settings
  DROP CONSTRAINT IF EXISTS awcms_commerce_store_settings_tax_profile_code_check;

ALTER TABLE awcms_commerce_store_settings
  ADD CONSTRAINT awcms_commerce_store_settings_tax_profile_code_check
  CHECK (tax_profile_code ~ '^[a-z0-9][a-z0-9_.-]{0,62}$');

ALTER TABLE awcms_commerce_products
  ADD COLUMN IF NOT EXISTS tax_category_code text;

ALTER TABLE awcms_commerce_products
  DROP CONSTRAINT IF EXISTS awcms_commerce_products_tax_category_code_check;

ALTER TABLE awcms_commerce_products
  ADD CONSTRAINT awcms_commerce_products_tax_category_code_check
  CHECK (
    tax_category_code IS NULL
    OR tax_category_code ~ '^[a-z0-9][a-z0-9_.-]{0,62}$'
  );

ALTER TABLE awcms_commerce_orders
  ADD COLUMN IF NOT EXISTS tax_snapshot_id uuid;

ALTER TABLE awcms_commerce_orders
  DROP CONSTRAINT IF EXISTS awcms_commerce_orders_tax_snapshot_fk;

ALTER TABLE awcms_commerce_orders
  ADD CONSTRAINT awcms_commerce_orders_tax_snapshot_fk
  FOREIGN KEY (tenant_id, tax_snapshot_id)
  REFERENCES awcms_tax_snapshots (tenant_id, id)
  ON DELETE SET NULL (tax_snapshot_id);

-- A snapshot is finalised for at most one order; the unique index is also the
-- FK's own index (db:fk-index). Partial: flat-mode orders carry NULL.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_orders_tax_snapshot_unique
  ON awcms_commerce_orders (tenant_id, tax_snapshot_id)
  WHERE tax_snapshot_id IS NOT NULL;

COMMENT ON COLUMN awcms_commerce_store_settings.tax_mode IS
  'Issue #293 (ADR-0039) — flat (percent of subtotal - voucher discount; the default) | engine (the tax module, ADR-0127). Written only by the audited cut-over tooling.';
COMMENT ON COLUMN awcms_commerce_store_settings.tax_profile_code IS
  'Issue #293 (ADR-0039) — the tax module profile whose published version prices this tenant''s carts in engine mode.';
COMMENT ON COLUMN awcms_commerce_products.tax_category_code IS
  'Issue #293 (ADR-0039) — the product''s tax class (a tax rule category code); NULL = standard / the version''s fallback rule.';
COMMENT ON COLUMN awcms_commerce_orders.tax_snapshot_id IS
  'Issue #293 (ADR-0039) — the tax snapshot finalised for this order in engine mode; NULL for flat-mode and pre-cut-over orders.';

-- ## The expiry job reverses an expired order's tax
--
-- An engine-mode order finalises its tax snapshot when it is PLACED. A checkout
-- nobody pays is expired by `commerce:orders:expire`, which runs as
-- `awcms_worker` (`WORKER_DATABASE_URL`) and, like every cancellation, must take
-- the order's tax back out of the ledger by appending a `reversal` snapshot —
-- otherwise abandoned checkouts would inflate the tax reconciliation forever.
-- `sql/172` gives the worker only SELECT/DELETE (the retention purge). The
-- reversal needs:
--
--   * INSERT — the reversal row itself;
--   * UPDATE — solely so `SELECT ... FOR UPDATE` may lock the original sale
--     (PostgreSQL requires the UPDATE privilege for a row lock, and both the
--     application's `reverseSnapshot` and `awcms_tax_snapshots_guard` take
--     one). The `awcms_tax_snapshots_immutable` trigger still refuses every
--     actual UPDATE of a row, for every role: the ledger stays append-only.
GRANT INSERT, UPDATE ON awcms_tax_snapshots TO awcms_worker;
