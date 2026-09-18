🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](kamus-data.id.md)

# Data dictionary

Every column across the nineteen `awcms_commerce_*` tables, its meaning, its unit/enum domain, and — where one exists — its source column in the legacy `commerce_bj_mart` MySQL schema.

## Provenance, stated once so every row below does not have to repeat it

The legacy column list was **recorded from the live `commerce_bj_mart` database on 2026-09-14**, during the work that produced issue #4's source-schema section and `apps/cms/sql/153_awcms_commerce_schema.sql`. **`commerce_bj_mart` is not reachable from the machine any of this documentation was written on** — every "source column" cell is stated **as recorded on 2026-09-14**, not independently re-checked since. The catalog-core and BjekMart-parity columns (this document's first two tables) were ported from the legacy schema's own column names, unchanged — `sql/153`'s and `sql/156`'s own headers, and `commerce/module.ts`'s docblock, all describe this as a direct port; corroborated by the deferred-column list still matching legacy `commerce_bj_mart.products` column names verbatim. The marketing and orders tables (issues #26/#29) are this platform's **own new design**, not a column-for-column port — mart.borneojek.com has settings and order records with a similar shape, but no legacy column list for them was captured during this repository's development, so no "source column" is claimed for that section; each column's meaning is stated on its own terms instead.

## `awcms_commerce_categories` ← `commerce_bj_mart.categories`

| AWCMS column | Legacy source column | Meaning | Unit / domain |
| --- | --- | --- | --- |
| `id` | `id` | Primary key | `uuid` here |
| `tenant_id` | *(none — new)* | Row ownership under this platform's multi-tenant model | `uuid`, FK to `awcms_tenants` |
| `parent_id` | `parent_id` | Self-referencing hierarchy — this category's parent, or root if null | `uuid`, FK to this same table; set once at creation |
| `name` | `name` | Display name | Free text |
| `slug` | `slug` | URL-facing identifier | Free text, unique per tenant among live rows |
| `icon` | `icon` | An icon reference for this category | Free text |
| `created_at`/`updated_at` | *(timestamps)* | Row lifecycle timestamps | `timestamptz` |
| `deleted_at` | *(none — new)* | Soft-delete marker; null means live | `timestamptz`, nullable |
| `restored_at` | *(none — new)* | When a soft delete was undone (`sql/156`) | `timestamptz`, nullable |

## `awcms_commerce_products` ← `commerce_bj_mart.products`

| AWCMS column | Legacy source column | Meaning | Unit / domain |
| --- | --- | --- | --- |
| `id` | `id` | Primary key | `uuid` here |
| `tenant_id` | *(none — new)* | Row ownership | `uuid`, FK `awcms_tenants` |
| `category_id` | `category_id` | The product's category | `uuid`, FK; cross-tenant refs rejected at the application layer |
| `type` | `type` | Product kind | `physical`, `digital`, `service`, `subscription` |
| `sku` | `sku` | Stock-keeping unit code | Free text, unique per tenant among live rows |
| `name` | `name` | Display name | Free text |
| `slug` | `slug` | URL-facing identifier | Free text, unique per tenant among live rows — see the migration constraint below |
| `description` | `description` | Long-form description | Free text, nullable |
| `digital_note` | `digital_note` | Note shown for digital products in place of shipping info | Free text, nullable |
| `price` | `price` | Unit price (level 1) | `numeric(14,2)`, decimal string on the wire — [ADR-0003](adr/0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) |
| `price_level_2`/`_3`/`_4` | `price_level_2`/`_3`/`_4` | Tiered pricing by customer level | `numeric(14,2)`, nullable |
| `cost_price` | `cost_price` | Admin-only unit cost, for margin reporting | `numeric(14,2)`, nullable — never on a public read model |
| `discount_percent` | `discount_percent` | Discount applied to `price` | Integer 0–100 |
| `stock` | `stock` | Units on hand | Non-negative integer |
| `status` | `status` | Lifecycle state | `draft`, `active`, `inactive`, `archived` — see [`docs/cms.md`](cms.md) |
| `label`/`label_color` | `label`/`label_color` | Merchandising badge and its background color | Free text / hex string, nullable |
| `min_purchase` | `min_purchase` | Minimum order quantity for this product | Integer, `>= 1` |
| `weight_grams` | `weight_grams` | Shipping weight | Grams, `>= 0` |
| `manual_rating` | `manual_rating` | An owner-entered rating, shown until real reviews accumulate | `numeric(2,1)`, 0.0–5.0, nullable |
| `manual_sold_count` | `manual_sold_count` | An owner-entered "sold" counter, for social proof | Non-negative integer |
| `with_insurance`/`insurance_required`/`insurance_fee` | `with_insurance`/`insurance_required`/`insurance_fee` | Whether shipping insurance is offered/mandatory, and its fee | Boolean / boolean / `numeric(14,2)` |
| `promo_banner_show`/`_title`/`_subtitle`/`_badge`/`_icon`/`_color` | same names | An optional promotional banner rendered on the product detail page | Boolean / free text ×5 |
| `size_chart_type` | `size_chart_type` | How a size chart is presented, if at all | `none`, `image`, `table` |
| `size_chart_media_id` | `size_chart_media_id` | The size-chart image, when `type = "image"` | `uuid`, FK `awcms_news_media_objects` (the media registry), UUID-shaped validation only |
| `size_chart_details` | `size_chart_details` | The size-chart rows, when `type = "table"` | `jsonb`, nullable |
| `service_form` | `service_form` | A service product's intake-form field definitions | `jsonb`, nullable |
| `subscription_period` | `subscription_period` | Billing cadence for a subscription product | `day`, `week`, `month`, `year`, nullable |
| `download_link` | `download_link` | A digital product's paid asset location | Free text, nullable; **never on a public read model** — see [`docs/cms.md`](cms.md) |
| `allow_dp` | `allow_dp` | Whether a down-payment checkout is permitted | Boolean |
| `allow_free_shipping` | `allow_free_shipping` | Whether this product can be shipped free (e.g. under a voucher) | Boolean, default `true` |
| `variant_attributes` | `variant_attributes` | The attribute set (e.g. size/color axes) this product's variants vary along | `jsonb`, nullable |
| `is_featured`/`is_recommended` | `is_featured`/`is_recommended` | Home-page placement flags | Boolean |
| `created_at`/`updated_at`/`deleted_at`/`restored_at` | *(timestamps / new)* | Row lifecycle | `timestamptz` |

**Not ported from `commerce_bj_mart.products`:** every `affiliate_*` column, and the legacy `product_affiliate_links` table — the affiliate program is [issue #32](https://github.com/ahliweb/awcms-one/issues/32)'s to admit, alongside customer accounts.

## `awcms_commerce_product_images` / `awcms_commerce_product_variants` ← `commerce_bj_mart.product_images` / `.product_variants`

Both are new AWCMS tables carrying the legacy tables' own concepts forward: an image is `{product, media reference, sort order, alt text}`; a variant is `{product, an attribute name/value pair such as "Warna"/"Merah", its own price/price-tier/stock/weight overrides, an optional image}`. See [`docs/skema-basis-data.md`](skema-basis-data.md) for the exact columns — this dictionary does not repeat them field-for-field a second time, since neither table's column meaning differs from its schema-doc description.

## The increment-2 migration constraint (unchanged from increment 1)

**The data migration must carry every legacy product slug verbatim, including its 4-character Laravel-generated uniqueness suffix** (for example `beras-5-kg-dbfc`, `jasa-jemput-kbj1`) — the CMS must never regenerate a slug from a product's name. [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.md) commits this platform's product URLs to the live site's own shape, `/product/{slug}`, specifically so every indexed link, bookmark, and shared URL keeps resolving at cutover.

## Marketing tables: this platform's own design, not a legacy port

`awcms_commerce_flash_sales`/`_flash_sale_products`, `_vouchers`, `_sliders`, `_testimonials`, `_popups`, `_store_settings` (issue #26) were designed against mart.borneojek.com's *observed behaviour* (a flash-sale strip with a countdown, a voucher code field at checkout, a home-page slider, a testimonials section, a promo popup, and store-wide settings including bank/QRIS details) rather than against a captured legacy column list — see "Provenance" above. Column meanings are documented in full in [`docs/skema-basis-data.md`](skema-basis-data.md); this dictionary does not duplicate them, since there is no legacy-mapping column to add beside each one.

## Order tables: this platform's own design, addressed by guest identity

`awcms_commerce_customers`/`_customer_addresses`/`_orders`/`_order_items`/`_order_events`/`_payment_confirmations`/`_reviews`/`_wishlists` (issue #29) are likewise this platform's own schema, shaped by [ADR-0009](adr/0009-guest-checkout-by-order-code-and-phone.md) (a customer is identified by phone, not an account) and [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md) (manual payment and a flat alternative-courier cost, not a live gateway/carrier integration). See [`docs/skema-basis-data.md`](skema-basis-data.md) for every column.

## Deferred columns and tables — not ported in this increment

- **Affiliate columns and `product_affiliate_links`** — [issue #32](https://github.com/ahliweb/awcms-one/issues/32), alongside customer accounts.
- **A live RajaOngkir courier-rate/tracking table** — [issue #33](https://github.com/ahliweb/awcms-one/issues/33); `shipping_method`/`shipping_service_name` on an order are merchant-defined labels today, never a live carrier response.
- **A payment-gateway transaction record** — the `payment_method` enum already accepts `gateway` (additive), but no provider integration exists; must be built through the outbox per [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md).
- **A real media upload for product images, slider media, payment-confirmation proof images, and ad-placement creatives** — resolved through `media_library`'s existing reference/URL mechanism, but this increment's seed uses placeholder SVGs/PNGs and the anonymous proof-upload endpoint is a stub (`503 MEDIA_UNAVAILABLE`); ad placements need a REAL R2-verified media object (`mediaObjectId` is required, not optional), so issue #57's seed step creates none of the 12 locally — see [`docs/cms.md`](cms.md) and [`docs/deployment.md`](deployment.md).
