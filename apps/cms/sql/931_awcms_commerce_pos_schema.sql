-- Issue #116 (epic #33 C7, contract #106 D6, ADR-0017) — POS schema: a
-- `channel` column distinguishing a counter sale from the anonymous
-- storefront checkout, `cash` joining `payment_method`'s allow-list, and a
-- `pos_cashier_tenant_user_id` column recording WHICH staff member rang up a
-- counter sale (`listPosOrders`' own `cashier` filter reads this column;
-- `order_events.actor` only ever records the ROLE `'admin'`, never a
-- specific tenant user id — see `sql/913`'s own `order_events` definition).
--
-- Same conventions as `sql/901`'s header (not repeated in full): every new
-- column keeps the table's existing RLS policy (it is not a new table), a
-- `CHECK` constraint enumerates the full allow-list rather than trusting the
-- application layer alone, and an index exists for every new WHERE/ORDER BY
-- shape a route actually needs.
--
-- ## Why `channel` gets its own column rather than being inferred
--
-- `payment_method = 'cash'` would ALMOST always imply `channel = 'pos'`
-- (nothing else in this codebase ever creates a `cash` order), but the two
-- are independent facts on the row: a channel is WHERE an order was placed,
-- payment method is HOW it was paid, and #116's own contract asks for a
-- distinct `(tenant, channel, created_at)` index for the POS history query
-- — inferring the channel from payment method would still need a functional
-- index over an expression, which is both slower and a hidden coupling the
-- next payment method added to POS (if any) would silently break.
--
-- ## Why `payment_method`'s CHECK constraint must be dropped and re-added
--
-- PostgreSQL has no `ALTER CONSTRAINT ... ADD VALUE` for a plain `CHECK`
-- (unlike a native `ENUM` type, which this column deliberately is not — see
-- `sql/901`'s header on why every enumerated commerce column is `text` +
-- `CHECK`, not a `CREATE TYPE ... AS ENUM`, so a future value never needs a
-- blocking `ALTER TYPE` on a live table). The constraint is dropped and
-- recreated with the same name, widened by exactly one value.

ALTER TABLE awcms_commerce_orders
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'storefront';

-- A plain uuid STAMP, not a foreign key — the same shape every `created_by`/
-- `deleted_by`/`actor_tenant_user_id` column in this schema uses: an order is
-- a fiscal record that must outlive the staff account that rang it up, so a
-- FK here would either block removing that tenant user or force `ON DELETE
-- SET NULL` to rewrite the tenant's own record of who took the cash. The
-- stamp resolves through `awcms_tenant_users` while the row exists and to
-- nobody once identity anonymisation runs (module.ts `subjectData`).
ALTER TABLE awcms_commerce_orders
  ADD COLUMN IF NOT EXISTS pos_cashier_tenant_user_id uuid;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'awcms_commerce_orders_channel_check'
  ) THEN
    ALTER TABLE awcms_commerce_orders DROP CONSTRAINT awcms_commerce_orders_channel_check;
  END IF;
END
$$;

ALTER TABLE awcms_commerce_orders
  ADD CONSTRAINT awcms_commerce_orders_channel_check
  CHECK (channel IN ('storefront', 'pos'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'awcms_commerce_orders_payment_method_check'
  ) THEN
    ALTER TABLE awcms_commerce_orders DROP CONSTRAINT awcms_commerce_orders_payment_method_check;
  END IF;
END
$$;

ALTER TABLE awcms_commerce_orders
  ADD CONSTRAINT awcms_commerce_orders_payment_method_check
  CHECK (payment_method IN ('manual_bank', 'manual_qris', 'dp', 'gateway', 'cash'));

-- `GET /api/v1/commerce/pos/orders`'s own history scan (contract's own
-- `(tenant, channel, created_at)` index) — `DESC` on `created_at` matches
-- the keyset page's own `ORDER BY created_at DESC, id DESC`, the same shape
-- `awcms_commerce_orders_tenant_status_idx` (`sql/913`) already uses for the
-- plain admin order list.
CREATE INDEX IF NOT EXISTS awcms_commerce_orders_tenant_channel_created_idx
  ON awcms_commerce_orders (tenant_id, channel, created_at DESC);

-- `listPosOrders`' own `cashier` filter scan; partial because every
-- storefront order leaves the column NULL and would only bloat the index.
CREATE INDEX IF NOT EXISTS awcms_commerce_orders_tenant_pos_cashier_idx
  ON awcms_commerce_orders (tenant_id, pos_cashier_tenant_user_id, created_at DESC)
  WHERE pos_cashier_tenant_user_id IS NOT NULL;

-- No new GRANT is needed here: `awcms_worker` already holds whatever it was
-- granted on `awcms_commerce_orders`/`_order_items`/`_order_events` by
-- `sql/908`/`sql/916` (the commerce lifecycle/expire worker grants) — this
-- migration only widens two existing columns' allow-lists and adds two new
-- columns to a table those grants already cover; a `GRANT` is per-table, not
-- per-column, so nothing here needs restating.

COMMENT ON COLUMN awcms_commerce_orders.channel IS
  'Issue #116 (contract #106 D6) — "storefront" for every anonymous/bearer checkout path, "pos" for a counter sale created via POST /api/v1/commerce/pos/orders. Every order created before #116 lands is "storefront" (the column DEFAULT).';
COMMENT ON COLUMN awcms_commerce_orders.pos_cashier_tenant_user_id IS
  'Issue #116 — the tenant user who rang up a POS sale (`auth.context.tenantUserId` at creation time). NULL for every "storefront" order; `listPosOrders`'' own `cashier` filter reads this column.';
