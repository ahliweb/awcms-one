-- Commerce's adapter over the upstream `inventory` ledger (Issue #282,
-- ADR-0038 D1/D3/D4/D7/D9). ONE file for the whole change, by ADR-0037 D2:
-- it depends only on lower-numbered objects (upstream `sql/169`/`sql/170`, and
-- commerce `sql/910` and below) and never on a 994-999 table.
--
-- ## 1. The per-tenant mode lives in COLUMNS, not in the settings jsonb
--
-- `awcms_commerce_store_settings.settings` is a jsonb blob the owner replaces
-- wholesale (`PUT`) or resets (`DELETE` stamps `deleted_at`). The inventory
-- mode must survive both: a "reset my store to defaults" that silently flipped a
-- ledger-authoritative tenant back to a counter would turn every later sale into
-- a write to the cache while the ledger stood still. So the two fields are real
-- columns that the settings upsert never names, and the readers
-- (`application/commerce-inventory.ts`) ignore `deleted_at` on this row.
--
--   * `inventory_mode`: `counter` (the default: today's single stock count,
--     byte-for-byte) or `ledger` (the upstream ledger is authoritative and
--     `stock` becomes a write-through cache of it).
--   * `inventory_location_id`: the ledger location commerce sells from. A
--     COMPOSITE foreign key `(tenant_id, inventory_location_id)` -> the
--     location's own `UNIQUE (tenant_id, id)` target, so a location of another
--     tenant cannot be named even by a forged id. `ledger` requires it.
--
-- The flip to `ledger` is made by `bun run commerce:inventory:cutover`, in the
-- same transaction as the opening movements. The way back (`counter`) is
-- `POST /api/v1/commerce/inventory/rollback`, audited.
ALTER TABLE awcms_commerce_store_settings
  ADD COLUMN IF NOT EXISTS inventory_mode text NOT NULL DEFAULT 'counter',
  ADD COLUMN IF NOT EXISTS inventory_location_id uuid,
  ADD COLUMN IF NOT EXISTS inventory_mode_changed_at timestamptz;

ALTER TABLE awcms_commerce_store_settings
  ADD CONSTRAINT awcms_commerce_store_settings_inventory_mode_check
    CHECK (inventory_mode IN ('counter', 'ledger')),
  ADD CONSTRAINT awcms_commerce_store_settings_inventory_location_required
    CHECK (inventory_mode = 'counter' OR inventory_location_id IS NOT NULL),
  ADD CONSTRAINT awcms_commerce_store_settings_inventory_location_fk
    FOREIGN KEY (tenant_id, inventory_location_id)
    REFERENCES awcms_inventory_locations (tenant_id, id);

CREATE INDEX IF NOT EXISTS awcms_commerce_store_settings_inventory_location_idx
  ON awcms_commerce_store_settings (tenant_id, inventory_location_id);

COMMENT ON COLUMN awcms_commerce_store_settings.inventory_mode IS
  'Issue #282 / ADR-0038 D1 — counter (stock is the authority) or ledger (the inventory ledger is the authority and stock is a write-through cache). Changed only by commerce:inventory:cutover (to ledger) and POST /commerce/inventory/rollback (to counter).';
COMMENT ON COLUMN awcms_commerce_store_settings.inventory_location_id IS
  'Issue #282 / ADR-0038 D1 — the inventory location commerce sells from; composite FK to awcms_inventory_locations. Required when inventory_mode = ledger.';

-- ## 2. Permission catalog rows
--
-- Two rows, existing `AccessAction` verbs only. `read` opens the mode and the
-- reconciliation; `configure` (high-risk) is the one authority for the two
-- writes that change what the storefront reads: the rollback to counter mode and
-- the resync of the stock cache from the ledger. Neither is implied by
-- `commerce.products.*`, and holding either reveals no price or customer.
-- Existing tenants run `bun run identity-access:permissions:backfill`.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'inventory', 'read', 'Read the stock-ledger mode and the stock-cache reconciliation (Issue #282)'),
  ('commerce', 'inventory', 'configure', 'Roll the stock authority back to counter mode and resync the stock cache from the ledger (Issue #282)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;

-- ## 3. The worker role
--
-- `bun run commerce:orders:expire` restocks an expired order, and in `ledger`
-- mode that is a `sale_return` POSTED through `InventoryLedgerPort` as
-- `awcms_worker`; `bun run domain-events:dispatch` runs the stock-cache
-- projector (ADR-0038 D4) as the same role and re-reads one balance. So the
-- worker holds exactly what the posting core touches, and nothing wider:
--
--   * `awcms_inventory_settings`: SELECT (the tenant's negative-stock policy);
--   * `awcms_inventory_locations`: SELECT, plus UPDATE on the one column
--     `updated_at`. The posting core reads the location `FOR SHARE` (so a
--     concurrent deactivation waits for in-flight postings), and PostgreSQL
--     requires UPDATE privilege on at least one column for any row-lock clause.
--     A column-level grant satisfies that without letting the worker change a
--     location's code, name, status or policy (`has_table_privilege(..., 'UPDATE')`
--     stays false);
--   * `awcms_inventory_balances`: SELECT, INSERT, UPDATE (never DELETE: the row
--     is the lock target for the last unit);
--   * `awcms_inventory_movements`: SELECT, INSERT (append-only; a trigger and
--     the `awcms_app` REVOKE already refuse UPDATE/DELETE);
--   * `awcms_inventory_low_stock_signals`: INSERT (it already holds SELECT from
--     `sql/169` for the reporting engine).
--
-- UPDATE on the product and variant tables (the cache write) and SELECT on the
-- store settings (the mode) were granted by `sql/916` and `sql/912`.
GRANT SELECT ON awcms_inventory_settings TO awcms_worker;
GRANT SELECT ON awcms_inventory_locations TO awcms_worker;
GRANT UPDATE (updated_at) ON awcms_inventory_locations TO awcms_worker;
GRANT SELECT, INSERT, UPDATE ON awcms_inventory_balances TO awcms_worker;
GRANT SELECT, INSERT ON awcms_inventory_movements TO awcms_worker;
GRANT INSERT ON awcms_inventory_low_stock_signals TO awcms_worker;
