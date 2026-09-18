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

## seputarborneo.com → `blog_content` / `seo_distribution` (issue #58)

Column mapping for `tools/import-seputarborneo.ts` (`bun run import:seputarborneo`), which reads seputarborneo's legacy MariaDB archive and writes into `apps/cms`'s public `/api/v1/*` surface — never a legacy column list ported verbatim into a new table, since `blog_content`'s schema (Portable Text body, term/institution classification) already exists and predates this importer.

### `berita_red` → a `blog_content` post

| Legacy column | AWCMS field | Notes |
| --- | --- | --- |
| `id_ber` | *(none — see below)* | No public field stores it; the redirect map is derived from the URL this importer builds, not a stored legacy id (see "What is NOT preserved" below) |
| `judul` | `title`, and the slug source | `slug = sbSlug(judul)`, de-duplicated with `-{id_ber}` on collision |
| `sub_judul` | `excerpt` | |
| `isi_berita` | `bodyPortableText` | CKEditor HTML → Portable Text via `tools/lib/html-to-portable-text.ts`; `<script>`/`<iframe>`/`<embed>`/`<object>` dropped entirely, an `<img>` becomes a `gallery` block only once a media object id is resolved, else dropped and reported |
| `jenis_rubrik` + `kategori` | `termIds` / `institutionIds` | Normalized identically to `migrations/2026-09-02-normalize-legacy-taxonomy.sql`, then classified into a rubrik term, a `daerah` region, a `mitra-borneo` institution, or a `umum` child — see the importer's own `mapLegacyTaxonomy` |
| `tgl` + `jam` | `publishedAt` (via `.../schedule`) or import time (via `.../publish`) | Asia/Jakarta (UTC+7, no DST) wall-clock → UTC instant; see `docs/deployment.md`'s "Importing seputarborneo" for why a PAST date cannot be backdated through the public API |
| `user` | `contentJson.legacySource.author` | NOT the rendered byline — `authorByline` is derived from the authenticated tenant user on this API, not a free-text field; see the importer's own header |
| `id_logo` | *(manifest only)* | Matched against `logo` by id; institution logos have no field on `apps/cms` yet — see [issue #59](https://github.com/ahliweb/awcms-one/issues/59) |
| `foto_berita` | `featuredMediaId` once uploaded | Named in the import manifest's `mediaNeeded` list until then |
| `status` | *(never read)* | The legacy site itself never read this column (`include/rubrik.php` uses the `berita_red_tayang` VIEW's own `tgl`+`jam` <= now filter instead) |
| `sub_up`, `text_foto`, `uk`, `tp`, `rate_view`, `like_view`, `unlike_viuew`, `hari`, `bln` | *(not imported)* | No corresponding concept on `blog_content` |

**What is NOT preserved:** `id_ber` itself. `apps/cms` DOES carry a `legacy_source_id`/`legacy_source_system` pair on `awcms_blog_posts` (`sql/138`) for exactly this purpose, but nothing on the PUBLIC API this importer is restricted to (AGENTS.md "Workspace boundaries") ever writes it — only the internal `bun run blog:legacy:import` pipeline does, from inside `apps/cms`. This importer's redirects (below) are built directly from the row at import time instead of being derived from a stored id afterwards.

### `awcms_seo_redirects` (origin `legacy_blog`)

One row per importable `berita_red`/`berita_vid` article, `target` set to the CMS's own canonical `/blog/{tenantCode}/{slug}` URL (never a guessed storefront path — `docs/routing.md`'s own documented contract for what `penyaji.mjs`'s legacy-redirect rebuild expects):

| Source path | Built from |
| --- | --- |
| `/news/{id_ber}-{sbSlug(judul)}.html` | Today's (post-issue-#6) URL shape |
| `/news/{id_ber}_{judul with spaces→underscores, rawurlencode'd}.html` | The pre-2.0 shape a search engine may still have indexed |
| `/video/?video={id_vid}-{sbSlug(judul_vid)}.html` | `berita_vid`'s own URL shape |

### `berita_vid` → a `blog_content` video post

| Legacy column | AWCMS field | Notes |
| --- | --- | --- |
| `judul_vid` | `title`, slug source | Same `sbSlug`/collision rule as `berita_red` |
| `link` | a `videoNews` block's `videoId` | Normalized via a YouTube-id/URL parser kept in exact step with `apps/cms`'s own `normalizeYouTubeVideoId` |
| `text_vid` | `bodyPortableText` (description, before the video block) | Same HTML→Portable Text conversion as `isi_berita` |
| `tgl` + `jam` | `publishedAt` | Legacy-formatted (`YYMMDD`/`HHMMSS`, per seputarborneo's own video-time-normalization migrations), reformatted before the same date logic `berita_red` uses |
| `admin` | `contentJson.legacySource.author` | Same caveat as `berita_red`'s `user` |
| `kategori`, `status` | *(not imported)* | No per-video taxonomy or status concept carried over |

### `ikl_online` → an ad placement (`POST /api/v1/news-portal/ad-placements`)

Read into the import manifest only — creation requires a verified `mediaObjectId`, and `img_ikl` (the creative filename) is not fetched or uploaded by this importer (see `docs/deployment.md`).

### `logo` → institution logo manifest (for issue #59)

Read into the import manifest, matched by `nama` against [issue #57](https://github.com/ahliweb/awcms-one/issues/57)'s 24 seeded institutions — `awcms_blog_institutions` carries no `logo_media_id` column in this repository's `apps/cms` yet (that lands via [issue #59](https://github.com/ahliweb/awcms-one/issues/59)'s upstream subtree pull), so nothing here calls an API for it today.

### `config` → `PUT /api/v1/site-profile` (a full-replace merge with whatever `bun run db:seed:cms` already set)

| Legacy column | AWCMS field | Notes |
| --- | --- | --- |
| `motho` | `tagline` | |
| `coppyright` | `copyrightNotice` | |
| `alamat` | `editorialAddress` | |
| `email` | `contactEmail` | |
| `wasupport` | `whatsappNumber` | |
| `fb`/`tw`/`ig`/`yt`/`tt`/`th` | `socialLinks[]` | Platform labels `facebook`/`x`/`instagram`/`youtube`/`tiktok`/`threads`; only `http(s)` values pass `/api/v1/site-profile`'s own absolute-URL validator (any other value is silently omitted, never sent) |
| `title`, `redaksi`, `link_coppy`, `ico`, `logo` | *(not applied)* | No field on `/api/v1/site-profile` today (checked directly against `site-profile-validation.ts`) |

### Not imported at all, and why

- **`users`** — identities are not migrated (PII); the seputarborneo admin accounts have no equivalent AWCMS user, and the article's `user`/`admin` column becomes provenance text (above), never a login.
- **`counter`** — visitor IP addresses; no consent record, no purpose once BjekMart/seputarborneo runs on `visitor-analytics` (issue #56/A10) instead.
- **`newsletter_subscribers`** — counted and reported, never imported: no consent record survives from the legacy signup form, and `apps/cms`'s own newsletter is double opt-in (epic #46's own Decision 2). A later `--with-subscribers` flag may add them as `pending` after a legal decision, per issue #58's own Scope.
- **`renungan_rmd`, `tanya_jawab`** — dead tables on the live site (nothing links to them).
- **`foto_berita`** (the gallery table, distinct from `berita_red.foto_berita` the COLUMN) — an unused gallery feature the public site never rendered.

## Deferred columns and tables — not ported in this increment

- **Affiliate columns and `product_affiliate_links`** — [issue #32](https://github.com/ahliweb/awcms-one/issues/32), alongside customer accounts.
- **A live RajaOngkir courier-rate/tracking table** — [issue #33](https://github.com/ahliweb/awcms-one/issues/33); `shipping_method`/`shipping_service_name` on an order are merchant-defined labels today, never a live carrier response.
- **A payment-gateway transaction record** — the `payment_method` enum already accepts `gateway` (additive), but no provider integration exists; must be built through the outbox per [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md).
- **A real media upload for product images, slider media, and payment-confirmation proof images** — resolved through `media_library`'s existing reference/URL mechanism, but this increment's seed uses placeholder SVGs and the anonymous proof-upload endpoint is a stub (`503 MEDIA_UNAVAILABLE`) — see [`docs/cms.md`](cms.md) and [`docs/deployment.md`](deployment.md).
