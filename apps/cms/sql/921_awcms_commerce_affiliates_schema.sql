-- Issue #92 (part of epic #32, contract #86's D5) — the affiliate program:
-- a customer enrols, gets an 8-character referral code
-- (`domain/affiliate-code.ts`), and earns a commission on every OTHER
-- customer's order that reaches `completed` while carrying that code (never
-- on their own — self-referral, `domain/affiliate-commission.ts`'s
-- `shouldEarnCommission`). Two new tenant-scoped tables plus one column each
-- on two existing tables, following `sql/901`'s conventions exactly (see
-- that file's header for the full reasoning this migration does not
-- repeat): `ENABLE` + `FORCE ROW LEVEL SECURITY`, one tenant-isolation
-- `USING` policy, `id uuid` PK `DEFAULT gen_random_uuid()`,
-- `created_at`/`updated_at timestamptz DEFAULT now()`, soft delete via
-- `deleted_at`, no per-table GRANT (`sql/019`'s `ALTER DEFAULT PRIVILEGES`
-- already covers `awcms_app`), an FK index for every FK column.
--
-- ## `awcms_commerce_affiliates`
--
-- ONE row per (tenant, customer) — `customer_id` is UNIQUE per tenant among
-- live rows, the same "1:1 with a customer" shape the OpenAPI draft's own
-- `Affiliate` schema description already commits to. `code` is likewise
-- UNIQUE per tenant among live rows (a soft-deleted affiliate's old code may
-- be reissued — this module never actually soft-deletes one in practice,
-- since `PATCH .../affiliates/{id}` only ever changes `status`/
-- `commission_rate`, but the index still follows this module's own
-- live-rows-only convention for consistency). `commission_rate numeric(5,2)`
-- is COPIED from `awcms_commerce_store_settings.affiliate_commission_rate`
-- at enrolment time and never re-derived from it afterwards — an owner
-- lowering the storefront-wide rate must not reprice an affiliate who is
-- already mid-payout-cycle at their original rate; `PATCH
-- .../affiliates/{id}` is the only way to change one affiliate's own rate
-- after enrolment. `status` is `active`/`suspended` — a suspended affiliate
-- keeps their row and history but earns no further commission
-- (`shouldEarnCommission`) and cannot be attributed to a NEW order
-- (`application/affiliate-directory.ts`'s `resolveAffiliateForOrder` refuses
-- to link a suspended code to an order at creation time).
--
-- ## `awcms_commerce_affiliate_commissions`
--
-- ONE row per order that ever earned a commission — `order_id` is UNIQUE
-- per tenant (not just among live rows: this table's own rows are never
-- soft-deleted in practice, the same "the FK target's own uniqueness already
-- prevents a second row for the same order" shape `awcms_commerce_orders`'s
-- own `order_code` index takes, sql/913's header) — the database's own half
-- of "one commission per order" (Issue #92's own words), the application
-- layer's other half being that `application/order-directory.ts` only ever
-- calls the insert once, from the single `pending_payment -> … -> completed`
-- transition path. `base_amount`/`rate`/`amount` are all SNAPSHOTS taken at
-- the moment the commission is created (`domain/affiliate-commission.ts`) —
-- a later change to the order or to the affiliate's own rate never reprices
-- an existing commission row, the same "snapshot, not a live join" choice
-- `awcms_commerce_order_items`'s own `unit_price`/`name` columns already
-- make for a product. `status` is the four-state
-- `pending -> approved -> paid` / `pending|approved -> void` machine
-- `application/affiliate-directory.ts`'s `applyCommissionStatusTransition`
-- enforces; `approved_at`/`paid_at`/`voided_at` are the timestamp columns for
-- the three terminal-adjacent transitions, the same "one nullable timestamp
-- column per transition" shape `awcms_commerce_orders`'s own
-- `paid_at`/`shipped_at`/`completed_at`/`cancelled_at` already use.
--
-- ## `awcms_commerce_orders.affiliate_id` / `awcms_commerce_store_settings.affiliate_commission_rate`
--
-- `orders.affiliate_id` is set ONCE, at order-creation time, by
-- `resolveAffiliateForOrder` (unknown/suspended `?ref=` code -> `NULL`,
-- never a validation error — a bad referral code must never block a
-- checkout, Issue #92's own words) and never changed afterwards; a plain
-- FK, not a composite `(tenant_id, id)` one, the same choice `sql/913`'s
-- header already explains for `order_items.product_id`.
-- `store_settings.affiliate_commission_rate numeric(5,2) NULL` is the
-- program's own on/off switch: `NULL` means the program is OFF for this
-- tenant (`application/affiliate-directory.ts`'s `isAffiliateProgramEnabled`
-- checks exactly this), a non-null value is both "the program is on" and
-- "the rate a NEW enrolment copies into its own `commission_rate`". It lives
-- as a real COLUMN, not inside `store_settings.settings`'s jsonb blob
-- (sql/910's own "why jsonb, not columns" section) — unlike the settings a
-- store owner tunes for its own sake, this value is read by a HOT
-- application-layer path (`resolveAffiliateForOrder`, the enrolment check)
-- that should not have to deserialize and validate the entire settings blob
-- just to read one boolean-shaped fact, and it never needed the settings
-- schema's own versioning (`STORE_SETTINGS_SCHEMA_VERSION`) since it is not
-- part of that validated shape at all.

CREATE TABLE IF NOT EXISTS awcms_commerce_affiliates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  customer_id uuid NOT NULL REFERENCES awcms_commerce_customers (id),
  code text NOT NULL,
  commission_rate numeric(5, 2) NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_affiliates_status_check
    CHECK (status IN ('active', 'suspended')),
  CONSTRAINT awcms_commerce_affiliates_commission_rate_check
    CHECK (commission_rate >= 0 AND commission_rate <= 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_affiliates_tenant_customer_key
  ON awcms_commerce_affiliates (tenant_id, customer_id)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_affiliates_tenant_code_key
  ON awcms_commerce_affiliates (tenant_id, code)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_affiliates_tenant_idx
  ON awcms_commerce_affiliates (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_affiliates_tenant_deleted_idx
  ON awcms_commerce_affiliates (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_affiliates_customer_idx
  ON awcms_commerce_affiliates (customer_id);

ALTER TABLE awcms_commerce_affiliates ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_affiliates FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_affiliates_tenant_isolation
  ON awcms_commerce_affiliates
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_affiliate_commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  affiliate_id uuid NOT NULL REFERENCES awcms_commerce_affiliates (id),
  order_id uuid NOT NULL REFERENCES awcms_commerce_orders (id),
  base_amount numeric(14, 2) NOT NULL,
  rate numeric(5, 2) NOT NULL,
  amount numeric(14, 2) NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  approved_at timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_affiliate_commissions_status_check
    CHECK (status IN ('pending', 'approved', 'paid', 'void'))
);

-- Never scoped to live rows — see this migration's header: an order earns at
-- most one commission row, forever, the same "unique for the FK target's own
-- lifetime" shape `awcms_commerce_orders_tenant_code_key` (sql/913) takes.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_affiliate_commissions_order_key
  ON awcms_commerce_affiliate_commissions (order_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_affiliate_commissions_tenant_idx
  ON awcms_commerce_affiliate_commissions (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_affiliate_commissions_tenant_deleted_idx
  ON awcms_commerce_affiliate_commissions (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_affiliate_commissions_affiliate_idx
  ON awcms_commerce_affiliate_commissions (affiliate_id, created_at DESC);

-- `GET .../affiliate-commissions?status=`'s own admin list scan.
CREATE INDEX IF NOT EXISTS awcms_commerce_affiliate_commissions_tenant_status_idx
  ON awcms_commerce_affiliate_commissions (tenant_id, status, created_at DESC);

ALTER TABLE awcms_commerce_affiliate_commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_affiliate_commissions FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_affiliate_commissions_tenant_isolation
  ON awcms_commerce_affiliate_commissions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

ALTER TABLE awcms_commerce_orders
  ADD COLUMN IF NOT EXISTS affiliate_id uuid REFERENCES awcms_commerce_affiliates (id);

CREATE INDEX IF NOT EXISTS awcms_commerce_orders_affiliate_idx
  ON awcms_commerce_orders (affiliate_id)
  WHERE affiliate_id IS NOT NULL;

ALTER TABLE awcms_commerce_store_settings
  ADD COLUMN IF NOT EXISTS affiliate_commission_rate numeric(5, 2);

ALTER TABLE awcms_commerce_store_settings
  ADD CONSTRAINT awcms_commerce_store_settings_affiliate_rate_check
    CHECK (affiliate_commission_rate IS NULL
      OR (affiliate_commission_rate >= 0 AND affiliate_commission_rate <= 100));

COMMENT ON TABLE awcms_commerce_affiliates IS
  'Issue #92 (contract #86 D5) — one row per (tenant, customer) affiliate enrolment; commission_rate is a snapshot copied at enrolment time, never re-derived from store_settings afterwards.';
COMMENT ON TABLE awcms_commerce_affiliate_commissions IS
  'Issue #92 (contract #86 D5) — one row per order that earned a commission (order_id unique for the tenant, forever); base_amount/rate/amount are snapshots taken when the referenced order reached completed.';
COMMENT ON COLUMN awcms_commerce_store_settings.affiliate_commission_rate IS
  'Issue #92 — NULL means the affiliate program is OFF for this tenant; a non-null value both turns the program on and is the rate a NEW enrolment copies.';
