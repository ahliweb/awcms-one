🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](skema-basis-data.id.md)

# Database schema

Every `awcms_commerce_*` table: columns, types, constraints, indexes, and the row-level security that scopes each query to one tenant. Source of truth is `apps/cms/sql/901_awcms_commerce_schema.sql` through `apps/cms/sql/916_awcms_commerce_orders_expire_worker_write_grants.sql` — sixteen migrations, one `commerce` module (see [ADR-0008](adr/0008-one-commerce-module-carries-the-whole-store-not-three.md)) — plus [`apps/cms/src/modules/commerce/README.md`](../apps/cms/src/modules/commerce/README.md); this document explains them, it does not replace reading them.

## Catalog: `awcms_commerce_categories`, `awcms_commerce_products`, `_product_images`, `_product_variants`

### `awcms_commerce_categories` (`sql/901`, `+restored_at` in `sql/904`)

Hierarchical, self-referencing.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | PK, `DEFAULT gen_random_uuid()` |
| `tenant_id` | `uuid NOT NULL` | `REFERENCES awcms_tenants (id)` |
| `parent_id` | `uuid` | `REFERENCES awcms_commerce_categories (id)`, nullable; set only at creation — see [`docs/cms.md`](cms.md) |
| `name` | `text NOT NULL` | |
| `slug` | `text NOT NULL` | Unique per tenant among live rows |
| `icon` | `text` | Nullable |
| `created_at`/`updated_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `deleted_at` | `timestamptz` | Nullable — soft delete |
| `restored_at` | `timestamptz` | Nullable, added `sql/904` — the "when" fact `restore` needs, on the same precedent `awcms_offices` already uses |

**Indexes:** unique `(tenant_id, slug) WHERE deleted_at IS NULL`; `(tenant_id)`; `(tenant_id, deleted_at)`; `(parent_id)`; `(tenant_id, parent_id) WHERE deleted_at IS NULL` (`sql/907`).

### `awcms_commerce_products` (`sql/901` core + `sql/904` BjekMart parity columns)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `tenant_id` | `uuid NOT NULL` | FK `awcms_tenants` |
| `category_id` | `uuid` | FK `awcms_commerce_categories`, nullable |
| `type` | `text NOT NULL DEFAULT 'physical'` | `CHECK IN ('physical','digital','service','subscription')` |
| `sku` | `text NOT NULL` | Unique per tenant among live rows |
| `name`, `slug` | `text NOT NULL` | `slug` unique per tenant among live rows |
| `description`, `digital_note` | `text` | Nullable |
| `price` | `numeric(14,2) NOT NULL` | `CHECK (price >= 0)` — see [ADR-0003](adr/0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) |
| `price_level_2`, `price_level_3`, `price_level_4` | `numeric(14,2)` | Nullable — tiered pricing by customer level (`sql/904`) |
| `cost_price` | `numeric(14,2)` | Nullable, admin-only — never on a public read model |
| `discount_percent` | `integer NOT NULL DEFAULT 0` | `CHECK BETWEEN 0 AND 100` |
| `stock` | `integer NOT NULL DEFAULT 0` | `CHECK (stock >= 0)` |
| `status` | `text NOT NULL DEFAULT 'draft'` | `CHECK IN ('draft','active','inactive','archived')` — see [`docs/cms.md`](cms.md) |
| `label`, `label_color` | `text` | Nullable, merchandising badge |
| `min_purchase` | `integer NOT NULL DEFAULT 1` | `CHECK (>= 1)` |
| `weight_grams` | `integer NOT NULL DEFAULT 0` | `CHECK (>= 0)` |
| `manual_rating` | `numeric(2,1)` | `CHECK BETWEEN 0 AND 5`, nullable |
| `manual_sold_count` | `integer NOT NULL DEFAULT 0` | `CHECK (>= 0)` |
| `with_insurance`, `insurance_required` | `boolean NOT NULL DEFAULT false` | |
| `insurance_fee` | `numeric(14,2)` | Nullable |
| `promo_banner_show` | `boolean NOT NULL DEFAULT false` | |
| `promo_banner_{title,subtitle,badge,icon,color}` | `text` | Nullable |
| `size_chart_type` | `text NOT NULL DEFAULT 'none'` | `CHECK IN ('none','image','table')`, plus a cross-field CHECK reconciling it with the next two columns |
| `size_chart_media_id` | `uuid` | `REFERENCES awcms_news_media_objects` — the media registry's real table name, kept across the `news_portal`→`blog_content` merge; validated UUID-shaped only, not checked live (see [`docs/cms.md`](cms.md)) |
| `size_chart_details` | `jsonb` | Nullable |
| `service_form` | `jsonb` | Nullable — a service product's intake-form field list |
| `subscription_period` | `text` | `CHECK IN ('day','week','month','year')`, nullable |
| `download_link` | `text` | Nullable — a digital product's paid asset; deliberately excluded from every public read model (see [`docs/cms.md`](cms.md)) |
| `allow_dp` | `boolean NOT NULL DEFAULT false` | |
| `allow_free_shipping` | `boolean NOT NULL DEFAULT true` | |
| `variant_attributes` | `jsonb` | Nullable |
| `is_featured`, `is_recommended` | `boolean NOT NULL DEFAULT false` | |
| `created_at`/`updated_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `deleted_at`, `restored_at` | `timestamptz` | Nullable |

**Indexes:** unique `(tenant_id, slug)`/`(tenant_id, sku)` both `WHERE deleted_at IS NULL`; `(tenant_id)`; `(tenant_id, deleted_at)`; `(category_id)`; `(size_chart_media_id)`; GIN trigram indexes on `name`/`sku` (`pg_trgm`, `sql/907`, backing the owner list's `q` substring filter); partial `(tenant_id) WHERE deleted_at IS NULL AND is_featured/is_recommended = true`; `(tenant_id, price)`/`(tenant_id, name)` both `WHERE deleted_at IS NULL`; `(tenant_id, status) WHERE deleted_at IS NULL`.

### `awcms_commerce_product_images` / `awcms_commerce_product_variants` (`sql/905`)

| Table | Key columns |
| --- | --- |
| `_product_images` | `product_id` (FK products), `media_object_id NOT NULL` (FK `awcms_news_media_objects`, checked live via `MediaLibraryPort.isMediaReferenceSafe` before insert), `sort_order`, `alt_text` |
| `_product_variants` | `product_id` (FK products), `name NOT NULL`, `value NOT NULL`, `color_hex`, `image_media_object_id` (FK, UUID-shaped-only validation), `sku` (unique per tenant among live rows, **checked against both this table and `awcms_commerce_products` itself** — a single-table index cannot express that), `price`/`price_level_2/3/4`, `stock`, `weight_grams`, `sort_order` |

Both: `id`/`tenant_id`/`created_at`/`updated_at`/`deleted_at` as usual; RLS `ENABLE`+`FORCE`, tenant-isolation policy; FK indexes on every reference column.

## Marketing: five families, plus store settings (`sql/909`–`sql/910`)

| Table | Key columns |
| --- | --- |
| `awcms_commerce_flash_sales` | `name`, `slug` (unique per tenant, live), `starts_at`/`ends_at NOT NULL` (`CHECK ends_at > starts_at`), `status` (`CHECK IN ('draft','scheduled','active','ended')` — `active`/`ended` are job-derived, never set by an owner directly) |
| `awcms_commerce_flash_sale_products` | `flash_sale_id`, `product_id`, `variant_id` (nullable), `sale_price NOT NULL` (`CHECK >= 0`), `quota`/`sold integer NOT NULL DEFAULT 0`; unique `(flash_sale_id, product_id, variant_id) NULLS NOT DISTINCT WHERE deleted_at IS NULL` |
| `awcms_commerce_vouchers` | `code` (unique per tenant, live), `type` (`CHECK IN ('percentage','nominal','free_shipping')`), `value NOT NULL` (`CHECK >= 0`), `min_order`, `max_discount`, `quota`/`used_count`, `is_public`, `status` (`CHECK IN ('active','inactive')`), `starts_at`/`ends_at NOT NULL` |
| `awcms_commerce_sliders` | `title NOT NULL`, `subtitle`, `media_object_id NOT NULL` (FK), `link_url`, `button_text`, `sort_order`, `is_active`, `starts_at`/`ends_at` (nullable, windowed) |
| `awcms_commerce_testimonials` | `author_name NOT NULL`, `author_role`, `body NOT NULL`, `rating integer NOT NULL DEFAULT 5` (`CHECK BETWEEN 1 AND 5`), `avatar_media_object_id` (FK, nullable), `is_active`, `sort_order` |
| `awcms_commerce_popups` | `title NOT NULL`, `body`, `media_object_id` (FK, nullable), `link_url`, `button_text`, `frequency` (`CHECK IN ('once_per_session','once_per_day','always')`), `is_active`, `starts_at`/`ends_at`; **unique partial index `(tenant_id) WHERE deleted_at IS NULL AND is_active = true`** — at most one active popup per tenant, enforced by the schema, not application code |
| `awcms_commerce_store_settings` | `tenant_id uuid PRIMARY KEY` (one row per tenant — a singleton, not a list), `settings jsonb NOT NULL DEFAULT '{}'` (`CHECK jsonb_typeof(settings) = 'object'`), `deleted_at` (here meaning "reset to defaults", not tenant removal — see [`docs/api.md`](api.md)) |

All six: standard `id`/`created_at`/`updated_at`/`deleted_at`, RLS `ENABLE`+`FORCE`, tenant-isolation policy, FK indexes.

## Orders: eight tables (`sql/913`)

| Table | Key columns | Notes |
| --- | --- | --- |
| `awcms_commerce_customers` | `name NOT NULL`, `phone NOT NULL` (unique per tenant, live), `email`, `level integer NOT NULL DEFAULT 1` (`CHECK BETWEEN 1 AND 4`), `status` (`CHECK IN ('active','blocked')`) | No `password_hash`/`identity_id` — guest-only (see [ADR-0009](adr/0009-guest-checkout-by-order-code-and-phone.md)); accounts are #32 |
| `awcms_commerce_customer_addresses` | `customer_id` (FK), `label`, `recipient_name NOT NULL`, `phone NOT NULL`, `province_code`/`name`, `city_code`/`name`, `district_code`/`name` (all `text NOT NULL` **snapshots**, not a live FK to `idn_admin_regions`), `postal_code`, `street NOT NULL`, `latitude numeric(9,6)`, `longitude numeric(9,6)`, `is_default` | Snapshotted so a later region-master-data change never rewrites a customer's own delivered address |
| `awcms_commerce_orders` | `order_code NOT NULL` (unique per tenant — **forever**, not scoped to live rows, since an order is never actually deleted), `customer_id` (FK), `status` (7-value CHECK, see [`docs/cms.md`](cms.md)), `payment_method` (`CHECK IN ('manual_bank','manual_qris','dp','gateway')` — `gateway` accepted, unimplemented, see [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md)), `payment_status` (`CHECK IN ('unpaid','dp_paid','paid','refunded')`), `shipping_method` (`CHECK IN ('alternative','self_pickup','courier')`), `shipping_service_name`, `shipping_cost`, `address jsonb` (snapshot, nullable for self-pickup), `subtotal`/`discount`/`voucher_code`/`voucher_discount`/`insurance_fee`/`tax`/`total`/`dp_amount`, `notes`, `paid_at`/`shipped_at`/`completed_at`/`cancelled_at`/`expires_at` | Indexes include the expiry job's own scan shape, `(tenant_id, status, expires_at) WHERE status = 'pending_payment'`, and the admin list's `(tenant_id, status, created_at DESC)` |
| `awcms_commerce_order_items` | `order_id`, `product_id`, `variant_id` (nullable), `flash_sale_id` (nullable FK — set when the line was bought at a flash-sale price), `name`/`variant_name`/`sku` (snapshots), `unit_price NOT NULL`, `quantity integer NOT NULL CHECK (> 0)`, `weight_grams`, `service_form_values jsonb`, `line_total NOT NULL` | |
| `awcms_commerce_order_events` | `order_id`, `from_status` (nullable — null on the creation row), `to_status NOT NULL`, `actor` (`CHECK IN ('customer','admin','system')`), `note`, `created_at` | **Append-only — no `deleted_at` at all**, the one exception to every other table's soft-delete shape; the order-tracking timeline's own source |
| `awcms_commerce_payment_confirmations` | `order_id`, `method` (`CHECK IN ('manual_bank','manual_qris')`), `amount NOT NULL`, `bank_name`, `account_name`, `transferred_at`, `proof_media_object_id` (**no FK constraint, no index** — a stub column, matching the always-`503` upload path, see [`docs/cms.md`](cms.md)), `status` (`CHECK IN ('submitted','accepted','rejected')`), `reviewed_by` (**no FK constraint**), `reviewed_at` | |
| `awcms_commerce_reviews` | `product_id`, `customer_id`, `order_id` (all `NOT NULL` FKs), `rating integer NOT NULL CHECK BETWEEN 1 AND 5`, `body NOT NULL`, `status` (`CHECK IN ('pending','published','rejected')`) | Unique `(customer_id, product_id, order_id) WHERE deleted_at IS NULL` — one review per customer, per product, per order |
| `awcms_commerce_wishlists` | `customer_id`, `product_id` (both `NOT NULL` FKs) | Unique `(customer_id, product_id) WHERE deleted_at IS NULL`; **schema-only — no API route in front of it yet**, shipped ahead of the account system it needs |

All eight: RLS `ENABLE`+`FORCE`, tenant-isolation policy. `deleted_at` exists on seven of eight (every table but `order_events`) purely as a uniform data-lifecycle purge cursor — orders, order items, customers, and payment confirmations are never actually soft-deleted by this module's own code.

## Row-level security: `ENABLE` and `FORCE`, proven under the unprivileged role

Every table above carries `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` **and** `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, with one tenant-isolation policy each:

```sql
CREATE POLICY awcms_commerce_products_tenant_isolation
  ON awcms_commerce_products
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

`FORCE` matters specifically because the table owner would otherwise bypass RLS entirely. The application connects as `awcms_app`, an unprivileged, non-superuser role — never the owner — so this policy is the actual, load-bearing tenant boundary for every commerce query. `apps/cms`'s generic RLS test suite derives its table list from every `awcms_%` table's own `ENABLE`/`FORCE` statements across `sql/`, rather than naming tables by hand, so every table above is covered automatically, the same way every other RLS table in this codebase is — no commerce-specific RLS test is needed or written. **The anonymous storefront API's own tenant resolution is a second, earlier boundary**, not a substitute for RLS: `application/public-commerce-tenant.ts` resolves a tenant from the request's `Origin`/`Host` against `awcms_tenant_domains` before a transaction even opens; RLS then still scopes every query inside that transaction to the tenant the resolver found. A cross-tenant `orders/{code}?phone=` lookup and an unresolvable-origin request both answer with the identical neutral `404`.

**`category_id` crossing tenants is closed at the application layer, not by the foreign key** — a PostgreSQL FK only proves a `category_id` names *some* row, not one belonging to the caller's own tenant. `commerce/application/product-directory.ts` calls `fetchCategoryById(tx, tenantId, categoryId)` inside the same RLS-scoped transaction and rejects the request (400) if it returns nothing — an unknown, soft-deleted, or cross-tenant id are rejected identically, on purpose (the GHSA-r7cx-c4jh-cvvw existence-oracle shape). The same pattern guards every other cross-table reference this module writes (a product's `category_id`, an order item's `product_id`/`variant_id`/`flash_sale_id`, a review's `product_id`/`customer_id`/`order_id`).

## `status`/`payment_status` and `deleted_at`: independent axes

A product's `status`, an order's `status`/`payment_status`, and whether a row is soft-deleted (`deleted_at`) answer different questions and are never conflated — see [`docs/cms.md`](cms.md) for both state machines in full. `order_events` alone carries no `deleted_at`: it is append-only by design, the one durable, un-editable record of an order's history.

## No actor-stamp columns anywhere in this module

No commerce table carries `created_by`/`updated_by`/`deleted_by`. WHO created, changed, or soft-deleted an owner-side row lives only in the audit log; WHO drove an order's own status changes lives in `order_events`' `actor` column (`customer`/`admin`/`system`) — see [`docs/cms.md`](cms.md).

## `dataLifecycle` and `subjectData`: the purge engine can never reach a live row, and every table is `unreachableBySubject`

Every one of the nineteen commerce tables opts into `apps/cms`'s generic data-lifecycle purge engine (`commerce/module.ts`'s `dataLifecycle` array), `cursorColumn: "deleted_at"` for eighteen of them and `"created_at"` for the append-only `order_events` — `NULL < $2` is neither true nor false in SQL, so a live row can never match the purge predicate; only a row already soft-deleted, past its retention window, becomes eligible. `orders`/`order_items`/`payment_confirmations` use a fiscal retention window (`retentionMinDays: 365`, `defaultRetentionDays: 3650`); the rest use `30`/`3650`/`365`.

Every one of the nineteen tables is also `unreachableBySubject: true` in the module's `subjectData` descriptors, `exportable: false`, `erasure: "retain_under_obligation"` — **including the customer/address/order tables that hold real guest PII.** This is a deliberate reading of `apps/cms`'s subject-data vocabulary (`SubjectDataColumn.references` is `"tenant_user" | "identity" | "profile" | "principal"` — every one a staff-side identity concept), not an oversight: a guest identified only by a phone number typed into a checkout form has none of those. A genuine erasure/export request is handled as an ordinary admin lookup (`GET`/`PATCH /api/v1/commerce/customers/{id}`), outside the automated engine's scope by construction — see [ADR-0009](adr/0009-guest-checkout-by-order-code-and-phone.md).

## Permissions (`sql/902`, `sql/906`, `sql/911`, `sql/914`)

39 keys in total across four areas — see [`docs/cms.md`](cms.md) and [`docs/api.md`](api.md) for the full table. Worker grants for the data-lifecycle purge engine's generic `SELECT, DELETE` are seeded per table in `sql/903`/`908`/`912`/`915`; `sql/916` grants the additional, narrower write privileges (`UPDATE`/`INSERT` on specific tables) that `commerce:orders:expire` and `commerce:flash-sales:tick` need to run at all as the least-privilege `awcms_worker` role.

## Deliberately not in this schema

Live carrier integration (no RajaOngkir rate/tracking table — `shipping_method`/`shipping_service_name` on an order are merchant-defined labels, never a live carrier response); a payment-gateway transaction record (the `gateway` enum value is accepted, unimplemented); customer accounts (`password_hash`, session tables — [issue #32](https://github.com/ahliweb/awcms-one/issues/32)); a `restore` column/endpoint for any marketing, order, customer, or review table.
