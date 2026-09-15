🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](kamus-data.id.md)

# Data dictionary

Every column in `awcms_commerce_categories`/`awcms_commerce_products`, its meaning, its unit or enum domain, and its source column in the legacy `commerce_bj_mart` MySQL schema.

## Provenance, stated once so every row below does not have to repeat it

The legacy column list was **recorded from the live `commerce_bj_mart` database on 2026-09-14**, one day before this document was written, during the work that produced [issue #4](https://github.com/ahliweb/awcms-one/issues/4)'s source-schema section and `apps/cms/sql/153_awcms_commerce_schema.sql`. **`commerce_bj_mart` is not reachable from the machine this document was written on** — there is no live connection to re-verify any of the mapping below against the source database today. Every "source column" cell is therefore stated **as recorded on 2026-09-14**, not as independently re-checked while writing this document. If the legacy schema has changed since that date, this table has not moved with it.

Both AWCMS tables were built by porting the legacy schema's **core catalog columns forward under their own names** — `sql/153`'s own header and `commerce/module.ts`'s docblock both describe this as a direct port, and the deferred-column list below (drawn from the same source) is itself a list of legacy `commerce_bj_mart.products` column names, which corroborates that the kept columns carry their legacy names unchanged rather than having been renamed in the port. Every source-column cell below is that same legacy name unless noted otherwise.

## `awcms_commerce_categories` ← `commerce_bj_mart.categories`

| AWCMS column | Legacy source column | Meaning | Unit / domain |
| --- | --- | --- | --- |
| `id` | `id` | Primary key | `uuid` here; the legacy key's own type was not re-verified for this document (see Provenance) |
| `tenant_id` | *(none — new)* | Row ownership under this platform's multi-tenant model | `uuid`, FK to `awcms_tenants`; `commerce_bj_mart` has no tenant concept, since it served one store |
| `parent_id` | `parent_id` | Self-referencing hierarchy — this category's parent, or root if null | `uuid`, FK to this same table; set once at creation, see [`docs/cms.md`](cms.md) |
| `name` | `name` | Display name | Free text |
| `slug` | `slug` | URL-facing identifier | Free text, unique per tenant among live rows |
| `icon` | `icon` | An icon reference for this category | Free text |
| `created_at` | *(timestamps)* | Row creation time | `timestamptz` |
| `updated_at` | *(timestamps)* | Row last-modified time | `timestamptz` |
| `deleted_at` | *(none — new)* | Soft-delete marker; null means live | `timestamptz`, nullable |

## `awcms_commerce_products` ← `commerce_bj_mart.products`

| AWCMS column | Legacy source column | Meaning | Unit / domain |
| --- | --- | --- | --- |
| `id` | `id` | Primary key | `uuid` here |
| `tenant_id` | *(none — new)* | Row ownership under this platform's multi-tenant model | `uuid`, FK to `awcms_tenants` |
| `category_id` | `category_id` | The product's category | `uuid`, FK to `awcms_commerce_categories`; cross-tenant references are rejected at the application layer, not by the FK — see [`docs/skema-basis-data.md`](skema-basis-data.md) |
| `type` | `type` | Product kind | Enum: `physical`, `digital`, `service`, `subscription` — all four carried forward unchanged; see `commerce/domain/product-type.ts` |
| `sku` | `sku` | Stock-keeping unit code | Free text, unique per tenant among live rows |
| `name` | `name` | Display name | Free text |
| `slug` | `slug` | URL-facing identifier | Free text, unique per tenant among live rows — **see the migration constraint below** |
| `description` | `description` | Long-form product description | Free text, nullable |
| `digital_note` | `digital_note` | A note shown for digital products in place of shipping information | Free text, nullable |
| `price` | `price` | Unit price | `numeric(14,2)`, a decimal string on the wire, never a float — see [ADR-0003](adr/0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) |
| `discount_percent` | `discount_percent` | Discount applied to `price` | Integer percentage, 0–100 |
| `stock` | `stock` | Units currently on hand | Non-negative integer; see [`docs/cms.md`](cms.md) for why the storefront never reads this at runtime |
| `status` | `status` | Lifecycle state | Enum: `draft`, `active`, `inactive`, `archived` — see [`docs/cms.md`](cms.md) for the legal transition table |
| `label` | `label` | A short merchandising badge, e.g. "Baru" | Free text, nullable |
| `label_color` | `label_color` | The badge's background color | An arbitrary hex string, nullable; see [`docs/ui-ux.md`](ui-ux.md) for how it is validated and rendered |
| `created_at` | *(timestamps)* | Row creation time | `timestamptz` |
| `updated_at` | *(timestamps)* | Row last-modified time | `timestamptz` |
| `deleted_at` | *(none — new)* | Soft-delete marker; null means live | `timestamptz`, nullable |

## The increment-2 migration constraint

**The data migration must carry every legacy product slug verbatim, including its 4-character Laravel-generated uniqueness suffix (for example `beras-5-kg-dbfc`, `jasa-jemput-kbj1`) — the CMS must never regenerate a slug from a product's name.** [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.md) commits this platform's product URLs to the live site's own shape, `/product/{slug}`, specifically so every indexed link, bookmark, and shared URL keeps resolving at cutover with no redirect map. That match is only real if the migrated `slug` column is byte-identical to the legacy one; a migration that re-derives slugs from `name` would produce different suffixes (or none), and every URL ADR-0005 preserves would silently point at nothing.

## Deferred columns and tables — legacy names, not ported

These carry no code reference anywhere in this slice (`sql/153`'s own header, `commerce/module.ts`'s docblock), so their legacy source columns are recorded here only as a target for a later increment's own port, not as something this schema already maps:

- **Columns on `commerce_bj_mart.products` not carried into `awcms_commerce_products`:** `price_level_2`, `price_level_3`, `price_level_4` (tiered pricing), `cost_price`, every `affiliate_*` column, every `size_chart_*` column, every `insurance_*` column, every `promo_banner_*` column, `variant_attributes`.
- **Legacy tables with no AWCMS counterpart in this slice:** `product_images`, `product_variants`, `flash_sale_products`, `product_affiliate_links`.

A later increment admitting any of these is additive — new columns and a migration for the rows that need them, not a rewrite of the tables documented above.
