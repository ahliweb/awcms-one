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
| `awcms_commerce_customers` | `name NOT NULL`, `phone NOT NULL` (unique per tenant, live), `email`, `level integer NOT NULL DEFAULT 1` (`CHECK BETWEEN 1 AND 4`), `status` (`CHECK IN ('active','blocked')`) | No `password_hash`/`identity_id` on this table itself — a customer stays reachable by order code + phone as a guest ([ADR-0009](adr/0009-guest-checkout-by-order-code-and-phone.md)); the account/OTP/session identity built on top of it lives in `awcms_commerce_customer_accounts`/`_customer_otps`/`_customer_sessions` below (ADR-0016) |
| `awcms_commerce_customer_addresses` | `customer_id` (FK), `label`, `recipient_name NOT NULL`, `phone NOT NULL`, `province_code`/`name`, `city_code`/`name`, `district_code`/`name` (all `text NOT NULL` **snapshots**, not a live FK to `idn_admin_regions`), `postal_code`, `street NOT NULL`, `latitude numeric(9,6)`, `longitude numeric(9,6)`, `is_default` | Snapshotted so a later region-master-data change never rewrites a customer's own delivered address. Exactly one `is_default` per `(tenant_id, customer_id)` among live rows is enforced by `sql/920`'s partial unique index (`WHERE is_default AND deleted_at IS NULL`), added for Issue #91's account address routes — any duplicate default the guest-checkout era may have left is demoted to the most-recently-created survivor by that same migration, before the index is created |
| `awcms_commerce_orders` | `order_code NOT NULL` (unique per tenant — **forever**, not scoped to live rows, since an order is never actually deleted), `customer_id` (FK), `status` (7-value CHECK, see [`docs/cms.md`](cms.md)), `payment_method` (`CHECK IN ('manual_bank','manual_qris','dp','gateway','cash')` — `gateway` since [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md)/issue #110, `cash` added by `sql/931` for the POS counter sale only, issue #116), `payment_status` (`CHECK IN ('unpaid','dp_paid','paid','refunded')`), `shipping_method` (`CHECK IN ('alternative','self_pickup','courier')`), `shipping_service_name`, `shipping_cost`, `address jsonb` (snapshot, nullable for self-pickup), `subtotal`/`discount`/`voucher_code`/`voucher_discount`/`insurance_fee`/`tax`/`total`/`dp_amount`, `notes`, `paid_at`/`shipped_at`/`completed_at`/`cancelled_at`/`expires_at`, **`channel text NOT NULL DEFAULT 'storefront'` (`CHECK IN ('storefront','pos')`, `sql/931`)**, **`pos_cashier_tenant_user_id uuid`** (`sql/931`; NULL on every storefront order) | Indexes include the expiry job's own scan shape, `(tenant_id, status, expires_at) WHERE status = 'pending_payment'`, the admin list's `(tenant_id, status, created_at DESC)`, the POS history's `(tenant_id, channel, created_at DESC)` and the cashier filter's partial `(tenant_id, pos_cashier_tenant_user_id, created_at DESC) WHERE pos_cashier_tenant_user_id IS NOT NULL` (both `sql/931`). `payment_method`'s CHECK is a plain `text` constraint, dropped and re-created by name to widen it — the reason every enumerated commerce column is `text + CHECK` rather than a native `ENUM` |
| `awcms_commerce_order_items` | `order_id`, `product_id`, `variant_id` (nullable), `flash_sale_id` (nullable FK — set when the line was bought at a flash-sale price), `name`/`variant_name`/`sku` (snapshots), `unit_price NOT NULL`, `quantity integer NOT NULL CHECK (> 0)`, `weight_grams`, `service_form_values jsonb`, `line_total NOT NULL` | |
| `awcms_commerce_order_events` | `order_id`, `from_status` (nullable — null on the creation row), `to_status NOT NULL`, `actor` (`CHECK IN ('customer','admin','system')`), `note`, `created_at` | **Append-only — no `deleted_at` at all**, the one exception to every other table's soft-delete shape; the order-tracking timeline's own source |
| `awcms_commerce_payment_confirmations` | `order_id`, `method` (`CHECK IN ('manual_bank','manual_qris')`), `amount NOT NULL`, `bank_name`, `account_name`, `transferred_at`, `proof_media_object_id` (**no FK constraint, no index** — a stub column, matching the always-`503` upload path, see [`docs/cms.md`](cms.md)), `status` (`CHECK IN ('submitted','accepted','rejected')`), `reviewed_by` (**no FK constraint**), `reviewed_at` | |
| `awcms_commerce_reviews` | `product_id`, `customer_id`, `order_id` (all `NOT NULL` FKs), `rating integer NOT NULL CHECK BETWEEN 1 AND 5`, `body NOT NULL`, `status` (`CHECK IN ('pending','published','rejected')`) | Unique `(customer_id, product_id, order_id) WHERE deleted_at IS NULL` — one review per customer, per product, per order |
| `awcms_commerce_wishlists` | `customer_id`, `product_id` (both `NOT NULL` FKs) | Unique `(customer_id, product_id) WHERE deleted_at IS NULL`; shipped ahead of the account system it needed, now reachable through `GET`/`PUT /api/v1/commerce/storefront/account/wishlist` and `DELETE .../wishlist/{productId}` (Issue #91) |

All eight: RLS `ENABLE`+`FORCE`, tenant-isolation policy. `deleted_at` exists on seven of eight (every table but `order_events`) purely as a uniform data-lifecycle purge cursor — orders, order items, customers, and payment confirmations are never actually soft-deleted by this module's own code.

## Customer accounts, OTP, sessions: three tables (`sql/917`-`918`)

Issue #87 (C1, contract #86/ADR-0016 — this awcms repo's own ADR, not yet written as of this table). No password anywhere — authentication is a 6-digit e-mail OTP; a session is an opaque bearer token, only its `sha256:` hash stored.

| Table | Key columns | Notes |
| --- | --- | --- |
| `awcms_commerce_customer_accounts` | `customer_id` (FK, `UNIQUE (tenant_id, customer_id)` — 1:1 with `awcms_commerce_customers`), `email_normalized` (`UNIQUE (tenant_id, email_normalized)`), `status` (`CHECK IN ('active','blocked')`), `email_verified_at`, `history_from timestamptz NOT NULL`, `last_login_at` | No `password_hash`, no `identity_id`/`principal_id` — ADR-0016 D1 (contract issue #86). Carries a `deleted_at` column that this module's own code never actually sets — blocked is `status = 'blocked'`, never deleted; the column exists only as an honest, always-`NULL` cursor for the `dataLifecycle` descriptor (`module.ts`), the same trick `awcms_commerce_orders` already uses. `history_from` is ADR-0016 D4's resolved starting point for order history, computed once at registration by the pure `resolveHistoryFrom` function |
| `awcms_commerce_customer_otps` | `email_normalized NOT NULL`, `purpose` (`CHECK IN ('login','register')`), `code_hash NOT NULL` (never the raw code), `registration jsonb` (pending name/phone for `register`), `attempts integer NOT NULL DEFAULT 0`, `expires_at NOT NULL`, `consumed_at` | 10-minute TTL, 5 attempts, single use — ADR-0016 D2. `consumeOtp` verifies + consumes in one `UPDATE ... RETURNING`, never read-then-write |
| `awcms_commerce_customer_sessions` | `account_id` (FK), `token_hash text NOT NULL UNIQUE` (`sha256:` prefixed — a FRESH namespace, not `apps/cms/src/lib/auth`'s admin session hash), `issued_at`, `expires_at`, `last_seen_at`, `revoked_at`, `client_ip_hash`, `user_agent_summary` | 30-day sliding TTL (`touchSession` only writes when `last_seen_at` is 5+ minutes stale); `cs_` + 32 random bytes base64url bearer token — ADR-0016 D3 |

All three: RLS `ENABLE`+`FORCE`, tenant-isolation policy, FK indexes. `commerce:customer-auth:purge` (worker role, `sql/918`'s grants) deletes expired OTPs and expired/revoked-7-days-ago sessions on a schedule; the accounts table has no purge behaviour at all (see `module.ts`'s `dataLifecycle` comment).

## Affiliate program: two tables (`sql/921`)

Issue #92, contract #86's D5 — a fresh design, no legacy `affiliate_*` column or `product_affiliate_links` row carried over (see [`docs/kamus-data.md`](kamus-data.md)).

| Table | Key columns | Notes |
| --- | --- | --- |
| `awcms_commerce_affiliates` | `customer_id NOT NULL` (FK, `UNIQUE (tenant_id, customer_id) WHERE deleted_at IS NULL` — 1:1 with `awcms_commerce_customers`), `code NOT NULL` (`UNIQUE (tenant_id, code) WHERE deleted_at IS NULL`, 8-char unambiguous alphabet — `domain/affiliate-code.ts`), `commission_rate numeric(5,2) NOT NULL` (`CHECK BETWEEN 0 AND 100`), `status` (`CHECK IN ('active','suspended')`, default `active`) | `commission_rate` is a SNAPSHOT copied from `store_settings.affiliate_commission_rate` at enrolment time — a later store-wide rate change never reprices an already-enrolled affiliate; only `PATCH /api/v1/commerce/affiliates/{id}` changes one affiliate's own rate afterwards |
| `awcms_commerce_affiliate_commissions` | `affiliate_id NOT NULL` (FK), `order_id NOT NULL` (FK, `UNIQUE` — **not scoped to live rows**, one commission per order forever, the same "unique for the FK target's own lifetime" shape `awcms_commerce_orders.order_code` uses), `base_amount numeric(14,2) NOT NULL`, `rate numeric(5,2) NOT NULL`, `amount numeric(14,2) NOT NULL`, `status` (`CHECK IN ('pending','approved','paid','void')`, default `pending`), `approved_at`/`paid_at`/`voided_at` | `base_amount`/`rate`/`amount` are all SNAPSHOTS taken when the referenced order reached `completed` (`domain/affiliate-commission.ts`); `base = subtotal − discount − voucher_discount` floored at zero, `amount = round(base × rate / 100, 2)` |

Plus one column on each of two existing tables: `awcms_commerce_orders.affiliate_id` (nullable FK, indexed `WHERE affiliate_id IS NOT NULL`) — set once at order-creation time by `resolveAffiliateForOrder` (unknown/suspended code → `NULL`, never a validation error) and never changed afterwards; `awcms_commerce_store_settings.affiliate_commission_rate numeric(5,2)` (nullable, `CHECK BETWEEN 0 AND 100` when set) — a real column outside the `settings` jsonb blob (see that table's own entry above for why jsonb is the default choice; this column is read by the hot `resolveAffiliateForOrder`/enrolment-check path and never needed the jsonb schema's own versioning), `NULL` meaning the affiliate program is OFF for the tenant.

## Courier rates: two cache tables (`sql/924`)

Issue #107, contract #106's D4 — a district-code→provider-destination-id cache and a per-(origin, destination, weight bucket, courier, service) rate cache, both purely additive caches with no `deleted_at` (a stale row is deleted outright, never soft-deleted — there is nothing to restore about a cached price).

| Table | Key columns | Notes |
| --- | --- | --- |
| `awcms_commerce_courier_destinations` | `district_code NOT NULL`, `provider NOT NULL`, `destination_id NOT NULL`, `label NOT NULL`, `resolved_at NOT NULL DEFAULT now()`, `UNIQUE (tenant_id, provider, district_code)` | No TTL — a district's provider destination id essentially never changes. Resolved once per (tenant, provider, district) by a name search against `idn_admin_regions`, then cached forever (barring a future refresh sweep) |
| `awcms_commerce_shipping_rates` | `provider NOT NULL`, `origin_id NOT NULL`, `destination_id NOT NULL`, `weight_bucket integer NOT NULL` (`CHECK >= 1000`), `courier NOT NULL`, `service NOT NULL`, `name NOT NULL`, `cost numeric(14,2) NOT NULL`, `etd`, `fetched_at NOT NULL DEFAULT now()`, `expires_at NOT NULL`, `UNIQUE (tenant_id, provider, origin_id, destination_id, weight_bucket, courier, service)` | TTL 6 hours (`expires_at`); `weight_bucket` is always `domain/weight-bucket.ts`'s `computeWeightBucketGrams` output (rounded up to the next 100 g, floored at 1000 g — RajaOngkir's own minimum billable weight), never the cart's raw weight, so two carts within the same 100 g band share one row. `commerce:shipping-rates:purge` (hourly) `DELETE`s every row past `expires_at`, across tenants, `awcms_worker`-granted like every other purge job in this module |

Both tables follow `sql/901`'s conventions (`ENABLE`/`FORCE ROW LEVEL SECURITY`, one tenant-isolation policy, an FK index on `tenant_id`) but are never written to by `application/order-directory.ts`'s write transaction directly for a NEW rate — `application/shipping-rate-directory.ts`'s `getCourierRates`/`resolveDestination` always read the cache in one short transaction, call the `ShippingRateProvider` (Komerce RajaOngkir API v2, or the `log` fixture adapter) with NO transaction open at all, then write the result back in a second short transaction (ADR-0006/0010's "never call a provider inside a DB transaction", applied here the same way `email`'s outbox already applies it). Order creation validates a chosen `{courier, service, cost}` against `awcms_commerce_shipping_rates` ONLY — a plain, transaction-safe `SELECT ... WHERE expires_at > now()`, never a second live provider call from inside the order's own write transaction.

Both new tables: RLS `ENABLE`+`FORCE`, tenant-isolation policy, FK indexes. Neither is ever soft-deleted by this module's own code in practice — `deleted_at` exists purely as the uniform data-lifecycle purge cursor, the same "always-`NULL` cursor" shape `awcms_commerce_orders` and `awcms_commerce_customer_accounts` already use.

## Commerce inbox: two tables (`sql/927`)

Issue #111, contract #106's D8 — a customer account's own thread with the store.

| Table | Key columns | Notes |
| --- | --- | --- |
| `awcms_commerce_conversations` | `account_id NOT NULL` (FK to `awcms_commerce_customer_accounts` — an inbox thread requires a verified account, unlike guest checkout), `subject NOT NULL` (`CHECK char_length BETWEEN 1 AND 150`), `status` (`CHECK IN ('open','closed')`, default `open`), `last_message_at timestamptz NOT NULL DEFAULT now()`, `unread_for_store boolean NOT NULL DEFAULT true`, `unread_for_customer boolean NOT NULL DEFAULT false` | `last_message_at`/both `unread_for_*` flags are DENORMALIZED and kept in step with `awcms_commerce_messages` inside the SAME transaction as every message insert — never a join-derived value at read time. `deleted_at` exists purely as the uniform data-lifecycle purge cursor (this module's own code never sets it), the same "always-`NULL` cursor" shape `awcms_commerce_orders`/`awcms_commerce_customer_accounts` already use |
| `awcms_commerce_messages` | `conversation_id NOT NULL` (FK), `sender NOT NULL` (`CHECK IN ('customer','store')`), `sender_tenant_user_id` (nullable; a `CHECK` requires it set for `sender='store'` and NULL for `sender='customer'`), `body NOT NULL` (`CHECK char_length BETWEEN 1 AND 4000`) | Append-only, like `awcms_commerce_order_events` — no `deleted_at`, no `updated_at`; a sent message is never edited or retracted |

Both new tables: RLS `ENABLE`+`FORCE`, tenant-isolation policy, FK indexes. `commerce.conversations`'s `dataLifecycle` descriptor uses the usual `deleted_at` cursor; `commerce.messages`, being append-only, uses `created_at` instead — the one exception `commerce.order_events` already established for exactly this shape.

## Customer campaigns: two tables + one column (`sql/929`)

Issue #114, contract #106's D9 — a consent-gated mass e-mail/WhatsApp send.

| Table | Key columns | Notes |
| --- | --- | --- |
| `awcms_commerce_customer_accounts.marketing_consent_at` (new column, not a new table) | `timestamptz`, nullable | Non-null means the account opted into marketing communication at that instant; `NULL` means never opted in (or withdrawn). Toggled ONLY by the account itself via `PATCH .../account/me {marketingConsent}` — never by staff |
| `awcms_commerce_campaigns` | `channel NOT NULL` (`CHECK IN ('email','whatsapp')`), `subject` (nullable — required for `email`, ignored for `whatsapp` at the application boundary), `body NOT NULL` (`CHECK char_length BETWEEN 1 AND 4000`), `audience jsonb NOT NULL DEFAULT '{}'` (validated at the application boundary, not by a database CHECK — a small, evolving filter shape), `status NOT NULL` (`CHECK IN ('draft','scheduled','sending','sent','cancelled')`, default `draft`), `scheduled_at`/`sent_at timestamptz`, `recipient_count integer` | `recipient_count`/`sent_at` start `NULL` on a fresh `draft`, populated only once the campaign has actually been dispatched (`commerce:campaigns:dispatch`'s FINALIZE phase) |
| `awcms_commerce_campaign_recipients` | `campaign_id NOT NULL` (FK), `customer_id NOT NULL` (FK), `address_masked NOT NULL` (masked e-mail/phone ONLY, never a raw address), `status NOT NULL` (`CHECK IN ('queued','enqueued','skipped')`, default `queued`), `outbox_ref` (nullable), `UNIQUE (campaign_id, customer_id)` | One row per resolved recipient — the resumability/audit ledger a partial send relies on. The `UNIQUE` constraint plus `ON CONFLICT DO NOTHING` at insert time is what makes the dispatcher's crash-recovery safe to retry; `resolveCampaignAudiencePage`'s own `NOT EXISTS` against this table is what makes its resume cursor correct without a separate cursor column on the campaign row |

Both new tables: RLS `ENABLE`+`FORCE`, tenant-isolation policy, FK indexes. `commerce.campaigns`'s `dataLifecycle` descriptor uses the usual `deleted_at` cursor; `commerce.campaign_recipients`, being append-only per campaign, uses `created_at` instead — the same `commerce.messages` shape just above. Permission catalog seed: `sql/930` (`commerce.campaigns.{read,update,send}`).

## Payment gateway: sessions, event ledger, webhook-endpoint tokens (`sql/926`)

Issue #110, contract #106's D2/D3 — a hosted-checkout session table, a replay-protection ledger for inbound provider webhooks (no writer yet; the webhook INTAKE route is issue #113's own scope), and the tenant-scoped webhook-endpoint tokens D2's bootstrap lookup resolves.

| Table | Key columns | Notes |
| --- | --- | --- |
| `awcms_commerce_payment_gateway_sessions` | `order_id NOT NULL` (FK), `provider NOT NULL` (`CHECK IN ('midtrans','log')`), `provider_ref NOT NULL`, `redirect_url NOT NULL`, `status NOT NULL DEFAULT 'created'` (`CHECK IN ('created','pending','paid','expired','failed','refunded')`), `expires_at NOT NULL`, `last_checked_at`, `raw_status jsonb`, `UNIQUE (provider, provider_ref)` | One row per hosted-checkout attempt. `application/payment-gateway-directory.ts`'s `createGatewaySession` is the only writer: validates the order and checks for a still-live session in one short transaction, calls the provider with NO transaction open, persists in a second short transaction. A genuinely concurrent double-create hits the `UNIQUE (provider, provider_ref)` constraint (`23505`) and re-fetches the winning row rather than erroring |
| `awcms_commerce_payment_events` | `provider NOT NULL` (`CHECK IN ('midtrans','log')`), `event_key NOT NULL`, `provider_ref NOT NULL`, `order_id` (FK, nullable), `payload jsonb NOT NULL`, `received_at NOT NULL DEFAULT now()`, `outcome NOT NULL` (`CHECK IN ('applied','ignored','replay')`), `UNIQUE (tenant_id, provider, event_key)` | The D2 replay-protection ledger — nothing in this issue's own scope writes to it yet; the webhook INTAKE route (#113) is its first writer |
| `awcms_commerce_webhook_endpoints` | `provider NOT NULL` (`CHECK IN ('midtrans')`), `token_hash NOT NULL` (`UNIQUE`), `label`, `created_by` (FK to `awcms_tenant_users`, nullable), `revoked_at` | ONE row per (tenant, provider) endpoint an owner minted. Only the SHA-256 hash of the plaintext token is ever stored — `application/webhook-endpoint-directory.ts`'s `createWebhookEndpoint` returns the plaintext exactly once and never persists it, the same discipline `awcms_machine_credentials` already applies to a structurally identical secret |

Plus two nullable columns on the existing `awcms_commerce_orders`: `gateway_provider text`, `gateway_ref text` — which gateway/reference paid this order, if any (added `ADD COLUMN IF NOT EXISTS`, so the migration stays additive against an already-populated `orders` table).

All three new tables: RLS `ENABLE`+`FORCE`, tenant-isolation policy, FK indexes (including a composite `(tenant_id, <cursor column>)` index on each, per this repo's own `data-lifecycle:table-coverage:check` convention). A fourth object, `awcms_resolve_commerce_webhook_endpoint(token_hash)`, is a `SECURITY DEFINER` function mirroring `sql/048`'s `awcms_resolve_tenant_domain_lookup` bootstrap-read pattern exactly — a dedicated `NOLOGIN` owner role (`awcms_webhook_endpoint_bootstrap`), an explicit `FOR SELECT` policy scoped to that role only, a fixed non-sensitive return shape (`tenant_id`, `provider` — never `token_hash`/`label`/`created_by`), and `EXECUTE` restricted to `awcms_app`. It resolves `(tenant_id, provider)` from a hashed, opaque token before any tenant context exists, the same bootstrap gap the tenant-domain function closes for a hostname.

## Point of sale: two columns and one widened CHECK on `awcms_commerce_orders` (`sql/931`, permission seed `sql/932`)

Issue #116, contract #106's D6 — no new table. `channel` records WHERE an order was placed (`storefront` for every anonymous/bearer checkout, and for every order that existed before the migration, via the column default; `pos` for a counter sale created through `POST /api/v1/commerce/pos/orders`), independently of `payment_method`, which records HOW it was paid — nothing in this codebase creates a `cash` order outside POS today, but the two are separate facts and the history query wants a plain `(tenant_id, channel, created_at DESC)` index rather than an expression over the payment method. `pos_cashier_tenant_user_id` is the one place this module records WHICH staff member did something on the row itself (see "No actor-stamp columns" below for the nuance): a plain `uuid` stamp, deliberately **not** a foreign key to `awcms_tenant_users` — an order is a fiscal record that must outlive the staff account that rang it up, and a FK would either block removing that user or force `ON DELETE SET NULL` to rewrite the tenant's own record of who took the cash. `order_events.actor` keeps recording only the ROLE (`admin`) for a POS sale, exactly as for every other admin transition; the audit log (`commerce.pos.sale`) carries the same tenant user id as `actor_tenant_user_id`. No new `awcms_worker` grant: the job grants of `sql/908`/`sql/916` are per table and already cover these columns. `sql/932` seeds the one new permission, `commerce.pos.create` (`INSERT ... ON CONFLICT DO NOTHING`).

The walk-in customer is NOT a schema construct — it is an ordinary `awcms_commerce_customers` row per tenant, found or created by `createPosOrder` under the documented sentinel phone `+620000000000` (`POS_WALK_IN_CUSTOMER_SENTINEL_PHONE`, [`docs/kamus-data.md`](kamus-data.md)); `customers.phone` stays `NOT NULL` and unique per tenant, which is exactly what makes that row unique.

## Sales-report projections: three derived tables (`sql/933`)

Issue #117, contract #106's D7 — the read models of the three `cursor_table` reporting projections `commerce` contributes (`commerce.sales_daily`, `commerce.sales_by_product`, `commerce.sales_by_category`), maintained by the `reporting` engine's own worker from `awcms_commerce_order_events` (see [`docs/cms.md`](cms.md) "Sales reports" for the delta rules). Derived and fully rebuildable — never written by a request path, never a source of truth.

| Table | Key columns | Notes |
| --- | --- | --- |
| `awcms_commerce_sales_daily` | `PRIMARY KEY (tenant_id, day)`, `day date`, `orders_paid integer`, `gross`/`discount`/`shipping`/`net numeric(14,2)` | One row per report-zone day (`Asia/Jakarta`) that had a paid order. `orders_paid` and the four money columns are additive deltas: `+` on `-> paid`, `-` on `-> cancelled|refunded` after a paid state, on the SAME day row (attributed to the order's `paid_at`). A day that sold and fully refunded reads `0`, not absent |
| `awcms_commerce_sales_by_product` | `PRIMARY KEY (tenant_id, day, product_id)`, `product_name text` (snapshot), `qty integer`, `gross numeric(14,2)` | Per day and product; `gross` is the sum of line totals. No FK to `awcms_commerce_products` on purpose — the name is a snapshot (the same posture `awcms_commerce_order_items.name` takes) and a purged product must not make its sales history unrebuildable. `(tenant_id, product_id)` index for the grouped read |
| `awcms_commerce_sales_by_category` | `PRIMARY KEY (tenant_id, day, category_id)`, `category_name text` (snapshot), `qty integer`, `gross numeric(14,2)` | Per day and product category, attributed through `products.category_id` at processing time. `category_id` is `NOT NULL` because it is part of the key: a product without a category lands on the all-zero sentinel uuid, which the read routes map back to `categoryId: null`. `(tenant_id, category_id)` index |

All three: RLS `ENABLE`+`FORCE`, tenant-isolation policy, `updated_at`, money as `numeric(14,2)` written from integer cents as decimal strings (never a float). Rows are upserted by primary key with `INSERT ... ON CONFLICT DO UPDATE SET x = x + EXCLUDED.x` inside the engine's bounded pass transaction, after the (tenant, projection) advisory lock and before the cursor advance; a rebuild `DELETE`s the tenant's rows in the same transaction that resets the cursor. `awcms_worker` is granted `SELECT, INSERT, UPDATE, DELETE` (`bun run reporting:projections:refresh` upserts; the generic data-lifecycle purge deletes; the rebuild reset's own delete runs as `awcms_app` in the API route's transaction) — mirrored in `WORKER_ROLE_GRANTS`. Retention: three `dataLifecycle` descriptors in `commerce/module.ts` (`commerce.sales_daily`/`_by_product`/`_by_category`, cursor `day`, the same 365–3650-day window as `commerce.order_events` — a row older than its source's retention can never be rebuilt and is safe to purge). Subject data: `NO_SUBJECT_DATA` in the script ledger (a day/product/category figure is a fact about nobody).

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

No commerce table carries `created_by`/`updated_by`/`deleted_by`. WHO created, changed, or soft-deleted an owner-side row lives only in the audit log; WHO drove an order's own status changes lives in `order_events`' `actor` column (`customer`/`admin`/`system`) — see [`docs/cms.md`](cms.md). The one deliberate exception since issue #116 is `awcms_commerce_orders.pos_cashier_tenant_user_id` — a business fact (which cashier rang up a counter sale, the POS history's own filter axis), not a housekeeping stamp; it is a plain `uuid`, never a foreign key, for the reasons given under "Point of sale" above.

## `dataLifecycle` and `subjectData`: the purge engine can never reach a live row, and every table is `unreachableBySubject`

Every one of the nineteen commerce tables opts into `apps/cms`'s generic data-lifecycle purge engine (`commerce/module.ts`'s `dataLifecycle` array), `cursorColumn: "deleted_at"` for eighteen of them and `"created_at"` for the append-only `order_events` — `NULL < $2` is neither true nor false in SQL, so a live row can never match the purge predicate; only a row already soft-deleted, past its retention window, becomes eligible. `orders`/`order_items`/`payment_confirmations` use a fiscal retention window (`retentionMinDays: 365`, `defaultRetentionDays: 3650`); the rest use `30`/`3650`/`365`.

Every one of the nineteen tables is also `unreachableBySubject: true` in the module's `subjectData` descriptors, `exportable: false`, `erasure: "retain_under_obligation"` — **including the customer/address/order tables that hold real guest PII** — with one narrowing since issue #116: `commerce.orders` now declares `subjectColumns: [{column: "pos_cashier_tenant_user_id", references: "tenant_user"}]` (so a STAFF subject's plan reaches the counter sales they rang up), while its erasure stays `retain_under_obligation` (the row is a fiscal record; the stamp resolves to nobody once `identity_access.identities` anonymises) and the CUSTOMER side of the same row stays unreachable for the reason that follows. This is a deliberate reading of `apps/cms`'s subject-data vocabulary (`SubjectDataColumn.references` is `"tenant_user" | "identity" | "profile" | "principal"` — every one a staff-side identity concept), not an oversight: a guest identified only by a phone number typed into a checkout form has none of those. A genuine erasure/export request is handled as an ordinary admin lookup (`GET`/`PATCH /api/v1/commerce/customers/{id}`), outside the automated engine's scope by construction — see [ADR-0009](adr/0009-guest-checkout-by-order-code-and-phone.md). Since Issue #91, `customer_addresses` and `wishlists` are additionally reachable by the SUBJECT directly, through their own bearer-secured `/api/v1/commerce/storefront/account/{addresses,wishlist}` routes — a genuine self-service path this registry's fixed vocabulary still cannot describe, so both stay `unreachableBySubject: true`, but the `module.ts` rationale now records that the gap is closed for the person themselves, just not for this automated engine.

## Permissions (`sql/902`, `sql/906`, `sql/911`, `sql/914`, …, `sql/932`)

39 keys in total across four areas as of increment 2, grown since by each increment-5 child (`sql/922` affiliates, `sql/928` conversations, `sql/930` campaigns, `sql/932` `commerce.pos.create`) — see [`docs/cms.md`](cms.md) and [`docs/api.md`](api.md) for the full table. Worker grants for the data-lifecycle purge engine's generic `SELECT, DELETE` are seeded per table in `sql/903`/`908`/`912`/`915`; `sql/916` grants the additional, narrower write privileges (`UPDATE`/`INSERT` on specific tables) that `commerce:orders:expire` and `commerce:flash-sales:tick` need to run at all as the least-privilege `awcms_worker` role.

## Deliberately not in this schema

Live carrier integration (no RajaOngkir rate/tracking table — `shipping_method`/`shipping_service_name` on an order are merchant-defined labels, never a live carrier response); a payment-gateway transaction record (the `gateway` enum value is accepted, unimplemented); a `password_hash` column anywhere — customer accounts are OTP-only by design ([ADR-0016](adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) D1), never a password to store or reset; a `restore` column/endpoint for any marketing, order, customer, or review table.
