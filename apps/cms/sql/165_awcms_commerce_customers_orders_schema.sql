-- Issue #29 (part of epic #21) — customers, addresses, orders and their
-- lifecycle, payment confirmations, reviews, wishlists: the transactional
-- half of BjekMart. Eight new tenant-scoped tables, following `sql/153`'s
-- conventions exactly (see that file's header for the full reasoning this
-- migration does not repeat): `ENABLE` + `FORCE ROW LEVEL SECURITY`, one
-- tenant-isolation `USING` policy, `id uuid` PK `DEFAULT gen_random_uuid()`,
-- `created_at`/`updated_at timestamptz DEFAULT now()`, an FK index for every
-- FK column, no per-table GRANT (`sql/019`'s `ALTER DEFAULT PRIVILEGES`
-- already covers `awcms_app`), and a plain single-column FK on the target's
-- `id` (not a composite `(tenant_id, id)` FK) — the same choice
-- `sql/161`'s `awcms_commerce_flash_sale_products` already makes for
-- `product_id`/`variant_id`: `id` is already a globally unique PK, RLS
-- already prevents a live cross-tenant SELECT, and the application layer
-- checks the referenced row's `tenant_id` before every write that would
-- otherwise let one tenant's row point at another's.
--
-- `deleted_at` is added to every table below, including the ones this
-- module's own application code never actually soft-deletes (`orders`,
-- `order_items`, `customers`) — the same "safe cursor even though it is
-- always NULL" trick `commerce/module.ts`'s existing `dataLifecycle`
-- descriptors already rely on: a `WHERE deleted_at < $2` purge predicate can
-- never match a row while it stays NULL forever, so the generic retention
-- engine gets one uniform cursor across the whole module. `orders`
-- specifically must never actually be purged while `retain_under_obligation`
-- applies (fiscal retention) — see `module.ts`'s `dataLifecycle` entry for
-- `commerce.orders`. `awcms_commerce_order_events` is the one exception: it
-- is an append-only log, so it carries no `deleted_at` at all and its
-- `dataLifecycle` descriptor keys off `created_at` instead (see
-- `module.ts`'s own comment on that entry).
--
-- ## `awcms_commerce_customers` / `_customer_addresses`
--
-- A **guest** order creates or reuses the customer row by phone (E.164,
-- normalised at the application layer, `domain/phone-normalisation.ts`) —
-- accounts/passwords are a later issue (#32), so there is no
-- `password_hash`/`identity_id` column here yet. `phone` is stored in the
-- clear (not hashed) because it doubles as the tracking credential a guest
-- types back in (`GET .../orders/{code}?phone=`) — the same trade the
-- issue's own schema section states plainly ("phone (E.164, unique per
-- tenant among live rows)"). Masking happens at the read/audit/log layer
-- (`domain/phone-normalisation.ts`'s `maskPhone`), never in storage.
--
-- `awcms_commerce_customer_addresses` carries a full region snapshot
-- (`province_code/name`, `city_code/name`, `district_code/name`) rather than
-- a live FK into `idn_admin_regions` — an address must keep reading the same
-- once saved even if the region dataset is re-imported later, the same
-- "snapshot, not a live join" choice `awcms_commerce_orders.address` makes
-- for an order's own address at the moment it was placed.
--
-- ## `awcms_commerce_orders` / `_order_items` / `_order_events`
--
-- `order_code` is the tenant-facing identifier (`BJM-YYYYMMDD-XXXX`,
-- `domain/order-code.ts`) and is unique per tenant FOREVER (not just among
-- live rows) — an order is never soft-deleted, so there is no "among live
-- rows" qualifier to make on this index, unlike every other unique key in
-- this module.
--
-- `address` is a `jsonb` SNAPSHOT of the address at order time (or `NULL`
-- for `self_pickup`) — never a live FK to `awcms_commerce_customer_addresses`,
-- because an order's shipping address must never change retroactively when a
-- customer edits or deletes their saved address later.
--
-- Money columns are all `numeric(14, 2)`, never a float (`sql/153`'s header
-- has the full arithmetic-drift reasoning) — every one of them is produced by
-- `domain/cart-quote.ts`'s integer-cent arithmetic and travels as a STRING on
-- the wire (ADR-0003).
--
-- `awcms_commerce_order_items` is append-only once its parent order exists —
-- "Immutable once `paid`" (the issue's own words) applies to the order
-- header; the line items are immutable from the moment they are written,
-- full stop, since every one of `name`/`sku`/`unit_price`/`weight_grams` is a
-- SNAPSHOT of the product at order time (the same reasoning `address` above
-- follows), not a live join to `awcms_commerce_products`.
--
-- `awcms_commerce_order_events` is the audit trail for every status
-- transition (`domain/order-status.ts`'s legal-transition table) — one row
-- per transition, `from_status IS NULL` for the very first row (the order's
-- creation).
--
-- ## `awcms_commerce_payment_confirmations`
--
-- One row per confirmation attempt a customer submits (manual bank transfer
-- or QRIS) — `status` starts `submitted` and an owner/admin
-- accepts/rejects it (`reviewed_by`/`reviewed_at`) through the same
-- `domain/order-status.ts` rules the order's own status machine uses.
-- `proof_media_object_id` is nullable: Issue #29's own contract accepts a
-- confirmation without a proof image when the media upload path is
-- unavailable (`payment.proofUpload: false`, see the module's README).
--
-- ## `awcms_commerce_reviews` / `_wishlists`
--
-- A review requires a `completed` order that actually contains the product
-- (checked at the application layer, `application/review-directory.ts`) —
-- the composite unique index below is the DATABASE's half of "one review per
-- (customer, product, order)"; the ORDER/PRODUCT relationship itself is not
-- something a single-table constraint can express.
--
-- `awcms_commerce_wishlists` ships its schema now (the issue's own schema
-- section names it) but gets no API route in this increment — "Wishlist
-- stays client-side in this increment (no account) — no endpoint" (the
-- issue's own words, since there is no customer identity to persist one
-- against yet). The table exists so a later, account-bearing increment does
-- not need its own schema migration.

CREATE TABLE IF NOT EXISTS awcms_commerce_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  name text NOT NULL,
  phone text NOT NULL,
  email text,
  level integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_customers_level_check
    CHECK (level BETWEEN 1 AND 4),
  CONSTRAINT awcms_commerce_customers_status_check
    CHECK (status IN ('active', 'blocked'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_customers_tenant_phone_key
  ON awcms_commerce_customers (tenant_id, phone)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_customers_tenant_idx
  ON awcms_commerce_customers (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_customers_tenant_deleted_idx
  ON awcms_commerce_customers (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_customers FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_customers_tenant_isolation
  ON awcms_commerce_customers
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  customer_id uuid NOT NULL REFERENCES awcms_commerce_customers (id),
  label text,
  recipient_name text NOT NULL,
  phone text NOT NULL,
  province_code text NOT NULL,
  province_name text NOT NULL,
  city_code text NOT NULL,
  city_name text NOT NULL,
  district_code text NOT NULL,
  district_name text NOT NULL,
  postal_code text,
  street text NOT NULL,
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  notes text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS awcms_commerce_customer_addresses_tenant_idx
  ON awcms_commerce_customer_addresses (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_customer_addresses_tenant_deleted_idx
  ON awcms_commerce_customer_addresses (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_customer_addresses_customer_idx
  ON awcms_commerce_customer_addresses (customer_id)
  WHERE deleted_at IS NULL;

ALTER TABLE awcms_commerce_customer_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_customer_addresses FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_customer_addresses_tenant_isolation
  ON awcms_commerce_customer_addresses
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  order_code text NOT NULL,
  customer_id uuid NOT NULL REFERENCES awcms_commerce_customers (id),
  status text NOT NULL DEFAULT 'pending_payment',
  payment_method text NOT NULL,
  payment_status text NOT NULL DEFAULT 'unpaid',
  shipping_method text NOT NULL,
  shipping_service_name text,
  shipping_cost numeric(14, 2) NOT NULL DEFAULT 0,
  address jsonb,
  subtotal numeric(14, 2) NOT NULL,
  discount numeric(14, 2) NOT NULL DEFAULT 0,
  voucher_code text,
  voucher_discount numeric(14, 2) NOT NULL DEFAULT 0,
  insurance_fee numeric(14, 2) NOT NULL DEFAULT 0,
  tax numeric(14, 2) NOT NULL DEFAULT 0,
  total numeric(14, 2) NOT NULL,
  dp_amount numeric(14, 2),
  notes text,
  paid_at timestamptz,
  shipped_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_orders_status_check
    CHECK (status IN ('pending_payment', 'paid', 'processing', 'shipped', 'completed', 'cancelled', 'expired')),
  CONSTRAINT awcms_commerce_orders_payment_method_check
    CHECK (payment_method IN ('manual_bank', 'manual_qris', 'dp', 'gateway')),
  CONSTRAINT awcms_commerce_orders_payment_status_check
    CHECK (payment_status IN ('unpaid', 'dp_paid', 'paid', 'refunded')),
  CONSTRAINT awcms_commerce_orders_shipping_method_check
    CHECK (shipping_method IN ('alternative', 'self_pickup', 'courier'))
);

-- Never scoped to live rows (`WHERE deleted_at IS NULL`) — see this
-- migration's header: an order code is unique for the tenant forever.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_orders_tenant_code_key
  ON awcms_commerce_orders (tenant_id, order_code);

CREATE INDEX IF NOT EXISTS awcms_commerce_orders_tenant_idx
  ON awcms_commerce_orders (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_orders_tenant_deleted_idx
  ON awcms_commerce_orders (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_orders_customer_idx
  ON awcms_commerce_orders (customer_id);

-- The `commerce:orders:expire` job's own scan: every `pending_payment` order
-- whose window has closed, tenant by tenant.
CREATE INDEX IF NOT EXISTS awcms_commerce_orders_expiry_idx
  ON awcms_commerce_orders (tenant_id, status, expires_at)
  WHERE status = 'pending_payment';

-- `GET .../orders?status=&paymentStatus=`'s own admin list scan.
CREATE INDEX IF NOT EXISTS awcms_commerce_orders_tenant_status_idx
  ON awcms_commerce_orders (tenant_id, status, created_at DESC);

ALTER TABLE awcms_commerce_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_orders FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_orders_tenant_isolation
  ON awcms_commerce_orders
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  order_id uuid NOT NULL REFERENCES awcms_commerce_orders (id),
  product_id uuid NOT NULL REFERENCES awcms_commerce_products (id),
  variant_id uuid REFERENCES awcms_commerce_product_variants (id),
  flash_sale_id uuid REFERENCES awcms_commerce_flash_sales (id),
  name text NOT NULL,
  variant_name text,
  sku text,
  unit_price numeric(14, 2) NOT NULL,
  quantity integer NOT NULL,
  weight_grams integer NOT NULL DEFAULT 0,
  service_form_values jsonb,
  line_total numeric(14, 2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_order_items_quantity_check
    CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_order_items_tenant_idx
  ON awcms_commerce_order_items (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_order_items_tenant_deleted_idx
  ON awcms_commerce_order_items (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_order_items_order_idx
  ON awcms_commerce_order_items (order_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_order_items_product_idx
  ON awcms_commerce_order_items (product_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_order_items_variant_idx
  ON awcms_commerce_order_items (variant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_order_items_flash_sale_idx
  ON awcms_commerce_order_items (flash_sale_id);

ALTER TABLE awcms_commerce_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_order_items FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_order_items_tenant_isolation
  ON awcms_commerce_order_items
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  order_id uuid NOT NULL REFERENCES awcms_commerce_orders (id),
  from_status text,
  to_status text NOT NULL,
  actor text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_order_events_actor_check
    CHECK (actor IN ('customer', 'admin', 'system'))
);

-- The generic data-lifecycle engine's own (tenant, cursor) batching/purge
-- scan — `commerce.order_events`'s dataLifecycle descriptor keys off
-- `created_at` (no `deleted_at` on this append-only table, this migration's
-- header), so this is that table's equivalent of every sibling table's
-- `(tenant_id, deleted_at)` index.
CREATE INDEX IF NOT EXISTS awcms_commerce_order_events_tenant_created_idx
  ON awcms_commerce_order_events (tenant_id, created_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_order_events_order_idx
  ON awcms_commerce_order_events (order_id, created_at);

ALTER TABLE awcms_commerce_order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_order_events FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_order_events_tenant_isolation
  ON awcms_commerce_order_events
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_payment_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  order_id uuid NOT NULL REFERENCES awcms_commerce_orders (id),
  method text NOT NULL,
  amount numeric(14, 2) NOT NULL,
  bank_name text,
  account_name text,
  transferred_at timestamptz,
  proof_media_object_id uuid,
  status text NOT NULL DEFAULT 'submitted',
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_payment_confirmations_method_check
    CHECK (method IN ('manual_bank', 'manual_qris')),
  CONSTRAINT awcms_commerce_payment_confirmations_status_check
    CHECK (status IN ('submitted', 'accepted', 'rejected'))
);

CREATE INDEX IF NOT EXISTS awcms_commerce_payment_confirmations_tenant_idx
  ON awcms_commerce_payment_confirmations (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_payment_confirmations_tenant_deleted_idx
  ON awcms_commerce_payment_confirmations (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_payment_confirmations_order_idx
  ON awcms_commerce_payment_confirmations (order_id)
  WHERE deleted_at IS NULL;

ALTER TABLE awcms_commerce_payment_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_payment_confirmations FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_payment_confirmations_tenant_isolation
  ON awcms_commerce_payment_confirmations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  product_id uuid NOT NULL REFERENCES awcms_commerce_products (id),
  customer_id uuid NOT NULL REFERENCES awcms_commerce_customers (id),
  order_id uuid NOT NULL REFERENCES awcms_commerce_orders (id),
  rating integer NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_reviews_rating_check
    CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT awcms_commerce_reviews_status_check
    CHECK (status IN ('pending', 'published', 'rejected'))
);

-- One review per (customer, product, order) — the database's half of the
-- rule; whether the order actually CONTAINS the product and is `completed`
-- is an application-layer check (`application/review-directory.ts`).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_reviews_customer_product_order_key
  ON awcms_commerce_reviews (customer_id, product_id, order_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_reviews_tenant_idx
  ON awcms_commerce_reviews (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_reviews_tenant_deleted_idx
  ON awcms_commerce_reviews (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_reviews_product_idx
  ON awcms_commerce_reviews (product_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_reviews_order_idx
  ON awcms_commerce_reviews (order_id);

ALTER TABLE awcms_commerce_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_reviews FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_reviews_tenant_isolation
  ON awcms_commerce_reviews
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_wishlists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  customer_id uuid NOT NULL REFERENCES awcms_commerce_customers (id),
  product_id uuid NOT NULL REFERENCES awcms_commerce_products (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_wishlists_customer_product_key
  ON awcms_commerce_wishlists (customer_id, product_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_wishlists_tenant_idx
  ON awcms_commerce_wishlists (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_wishlists_tenant_deleted_idx
  ON awcms_commerce_wishlists (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_wishlists_product_idx
  ON awcms_commerce_wishlists (product_id);

ALTER TABLE awcms_commerce_wishlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_wishlists FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_wishlists_tenant_isolation
  ON awcms_commerce_wishlists
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
