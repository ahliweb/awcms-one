---
bump: minor
type: structure
impact: public
---

# `commerce` reaches full BjekMart product-model parity

Issue #23 (part of epic #21) brings `apps/cms`'s `commerce` module from Issue #4's
13-column catalog core to the full legacy `commerce_bj_mart.products` shape, and
gives it the two related tables a real product page cannot render without.

- `awcms_commerce_products` gains every column Issue #4 deliberately deferred:
  tiered pricing (`price_level_2/3/4`), admin-only `cost_price`, weight,
  minimum purchase, manual rating/sold-count, insurance, promo banners, a size
  chart (image or table), a service intake form, subscription period, a
  digital download link, deposit/free-shipping flags, variant attributes, and
  explicit `is_featured`/`is_recommended` merchandising flags.
- Two new tables, `awcms_commerce_product_images` and
  `awcms_commerce_product_variants`, with their own CRUD routes under
  `/api/v1/commerce/products/{id}/{images,variants}`. `commerce` now depends
  on `media_library` so a product image's public URL resolves through
  `MediaLibraryPort`, the same capability `blog_content` already consumes.
- `GET /api/v1/commerce/products` gains `?categoryId=&status=&q=&sort=&
  featured=&recommended=` filters; every product response carries a
  server-computed `finalPrice` (exact integer-cents arithmetic, never a
  float) plus resolved `images[]`/`variants[]`. A new
  `GET .../products/by-slug/{slug}` route serves the storefront's detail
  fetch. `GET /api/v1/commerce/categories` gains `?parentId=` and a computed
  `productCount` per row.
- Restore endpoints for both categories and products
  (`POST .../{id}/restore`), the shape `office-directory.ts` already
  established, with a new `restore` permission on both activity codes.
- `/admin/commerce` is now a full product CRUD screen (filters, create/edit,
  an images picker sourced from the media registry, a variants editor,
  status transition, soft delete, restore); `/admin/commerce-categories` is
  a new category CRUD screen. Both are off `NOT_YET_SCREENED`.
- `packages/kontrak` re-exports the four new unions (`SizeChartType`,
  `SubscriptionPeriod`, `ServiceFormFieldType`, `ProductSort`) from
  `apps/cms`'s `domain/*.ts`, type-only, per ADR-0004.

Deliberate scope decisions, recorded here for #31 to fold into the schema/API
docs:

- `awcms_commerce_categories` also gained a `restored_at` column (the issue's
  own column table only listed it for products) — both restore endpoints need
  the same "when" fact, and this module's README already treats
  `awcms_offices`' restore shape as the precedent for both tables alike.
- Keyset pagination (`cursor`/`nextCursor`) stays scoped to the default
  `sort=newest`; `price_asc`/`price_desc`/`name` return a single bounded page
  (`PRODUCT_LIST_LIMIT` = 100, `nextCursor: null`) rather than a keyset walk
  ordered by a second column.
- `sizeChartMediaId`/a variant's `imageMediaObjectId` are validated as
  UUID-shaped only, not checked for live/verified existence — unlike a
  product IMAGE row's `mediaObjectId`, which is the one write path this issue
  checks against `MediaLibraryPort.isMediaReferenceSafe` before insert. A
  stale/foreign id in either scalar field simply resolves to no public URL at
  render time; RLS still keeps it from crossing a tenant boundary.
- `apps/cms/scripts/client-asset-budget.ts`'s `APP_BUDGET_BYTES` raised
  218,000 -> 219,000 B for the two admin screens' client script (4,974 B,
  measured on a clean build) — no new CSS, both screens reuse the existing
  admin design-system classes.
