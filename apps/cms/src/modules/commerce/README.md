🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](README.id.md)

# `commerce`

Tenant-scoped product **categories** (hierarchical, self-referencing) and
**products** (with images and variants), ported from the legacy MySQL
`commerce_bj_mart.{categories,products}` schema. Issue #4 (part of epic #1)
shipped the catalog core; Issue #23 (part of epic #21) brings it to full
product-model parity with the legacy schema.

| Aspect      | Value                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key / type  | `commerce` · `domain`, `isCore: false`                                                                                                                                 |
| Tables      | `awcms_commerce_categories`, `awcms_commerce_products` (`sql/153`, extended `sql/156`), `awcms_commerce_product_images`, `awcms_commerce_product_variants` (`sql/157`) |
| Permissions | `categories.{read,create,update,delete,restore}`, `products.{read,create,update,delete,restore}` (`sql/154`, `sql/158`)                                                |
| API         | `/api/v1/commerce/{categories,products}` (`openapi/modules/commerce.openapi.yaml`)                                                                                     |
| Events      | `commerce.product.{created,updated,status_changed}` — unchanged by Issue #23, see below                                                                                |
| Depends on  | `tenant_admin`, `identity_access`, `domain_event_runtime`, `media_library` (added by Issue #23 — product images resolve through `MediaLibraryPort`)                    |

## What Issue #23 adds, and what stays a later increment

Issue #4's slice took the catalog core (`categoryId`, `type`, `sku`, `name`,
`slug`, `description`, `digitalNote`, `price`, `discountPercent`, `stock`,
`status`, `label`, `labelColor`) and deferred the rest of the legacy
`products` table. Issue #23 lands every one of those deferred fields:

- **Tiered pricing & cost**: `priceLevel2/3/4` (nullable `numeric(14,2)`
  strings), `costPrice` (same shape, **admin-only** — see below).
- **Inventory & shipping**: `minPurchase` (`>= 1`), `weightGrams`, `allowDp`,
  `allowFreeShipping`.
- **Merchandising**: `isFeatured`, `isRecommended` — explicit flags that
  replace BjekMart's ad-hoc `featuredProducts`/`recommendedProducts`
  heuristics; `manualRating`/`manualSoldCount`, exposed on the DTO as
  `averageRating`/`soldCount` until Issue #29 lands real reviews/orders.
- **Insurance**: `withInsurance`, `insuranceRequired`, `insuranceFee`.
- **Promo banner**: `promoBannerShow` plus title/subtitle/badge/icon/color.
- **Size chart**: `sizeChartType` (`none`/`image`/`table`), `sizeChartMediaId`
  (required when `image`), `sizeChartDetails` (`jsonb`, required when
  `table`) — the cross-field rule lives in `domain/size-chart.ts`'s
  `reconcileSizeChart`, called from both the create validator (against
  already-defaulted values) and `updateProduct` (against the row MERGED with
  the patch), and mirrored as a coarse `CHECK` in `sql/156`.
  `sizeChartMediaId` is validated as UUID-shaped only, not checked for live
  existence — see "What is still NOT checked" below.
- **Service intake form**: `serviceForm` (`jsonb`, `domain/service-form-validation.ts`)
  — an array of `{id, type, label, required, options}` field descriptors for
  a `type: "service"` product's booking form. Shape-validated, stored as-is;
  nothing renders it server-side.
- **Subscription / digital**: `subscriptionPeriod` (`day`/`week`/`month`/`year`,
  descriptively tied to `type: "subscription"` but not cross-validated —
  BjekMart's own column carries a value independent of `type`), `downloadLink`.
- **Variant attributes**: `variantAttributes` (`jsonb`,
  `domain/variant-attributes-validation.ts`) — the DECLARED set of attribute
  groups/options a merchant has defined (e.g. `[{name: "Size", options:
[{name: "M"}, {name: "L"}]}]`). Descriptive metadata, not a constraint
  enforced against actual variant rows.
- **Restore**: `restoredAt` on both tables — see "Restore" below.

**`costPrice` never reaches a public response.**
`application/product-directory.ts` keeps two mappers over the same row:
`toRecord` (the public `ProductRecord`/`CommerceProduct` DTO — no
`costPrice`) and `toAdminRecord` (`ProductAdminRecord`, `costPrice` included)
— used only by `src/pages/admin/commerce.astro`'s own fetch. The type system
makes the promise, not a convention every route has to remember.

## Money is `numeric(14,2)`, and crosses the wire as a string

Unchanged principle from Issue #4, now covering more columns: `price`,
`priceLevel2/3/4`, `costPrice`, `insuranceFee`, and the computed `finalPrice`
are all `numeric(14,2)`, never a float — `Bun.SQL` hands each back as a
STRING, and nothing in this module parses one to a `number`. `finalPrice`
(`price` after `discountPercent` off) is computed server-side in
`domain/price-calculation.ts`, entirely in integer CENTS via `BigInt` —
`"19.10"` at 10% becomes `"17.19"`, never `17.189999999999998`.
`discountPercent`, `stock`, `minPurchase`, `weightGrams`, and
`manualSoldCount` are plain `integer`: none is money, and all are exact in
floating point anyway.

## Two independent axes: `status` and soft delete

Unchanged from Issue #4. A product's lifecycle status (`draft` →
`active`/`archived`, `active` ⇄ `inactive`, either → `archived`, `archived` →
`draft` only — `domain/product-status.ts`'s `LEGAL_TRANSITIONS`) and whether
the row is soft-deleted (`deleted_at`) are deliberately separate. Pulling a
product from sale without losing it is `status = 'inactive'`; removing it
from the tenant's own catalog view is `deleted_at`. There is still no
dedicated status-transition endpoint — `status` travels through the same
`PATCH /api/v1/commerce/products/{id}` as every other field, checked by
`updateProduct` before any write.

## Hierarchy, and what re-parenting would cost

Unchanged: `parentId` is self-referencing and set only at creation
(`CreateCategoryInput`); `UpdateCategoryInput` does not carry it at all.
Moving a category to a new parent is therefore "delete and recreate", the
same limitation `office-directory.ts` accepts for `parentOfficeId`. A
category whose `parentId` names another tenant's row, an absent id, or a
soft-deleted one is rejected identically (400, `ParentCategoryNotFoundError`)
— the three causes stay indistinguishable on purpose (GHSA-r7cx-c4jh-cvvw's
shape). `products.categoryId` gets the same treatment and, unlike a
category's parent, IS re-assignable via update.

## Restore (Issue #23)

Both tables now carry a `restored_at timestamptz` column (categories' was not
in the issue's own column table, which only lists it for products — added
here for symmetry: the categories restore endpoint needs the same "when" fact,
and `awcms_offices` is this module's own precedent for both). Unlike offices,
neither table gained `deleted_by`/`delete_reason`/`restored_by` — this
module's tables carry no actor-stamp columns at all (Issue #4's original
choice, unchanged); WHO restored a row is the audit log's own
`actorTenantUserId`.

`POST /api/v1/commerce/{categories,products}/{id}/restore` follow
`office-directory.ts`'s shape: 404 when the id is not currently soft-deleted
(idempotent-safe — a repeat restore is a 404, never a duplicate), 409 when a
live row has since taken the same slug (categories, products) or sku
(products). `restore` is its OWN permission on both activity codes — unlike
`offices/[id]/restore.ts`'s reuse of `.update`, so a future policy can grant
one without the other; see `domain/commerce-permissions.ts`'s header.

## Domain events: products only, three of them — unchanged

Categories still publish none. Products still publish exactly the three
Issue #4 defined (`created`/`updated`/`status_changed`) — Issue #23 adds no
new event type, and image/variant CRUD does not publish events either (same
"a soft delete/sub-resource change is an audit-log fact, not a catalog
event" choice categories' own delete already made). A PATCH that touches
both ordinary fields and `status` still fires both events independently.

## Uniqueness

`(tenant_id, slug)` stays unique per table among LIVE rows; products
additionally enforce `(tenant_id, sku)`. **New in Issue #23**: a variant's
`sku`, when set, must be unique against BOTH `awcms_commerce_products` AND
`awcms_commerce_product_variants` in the tenant — a single-table partial
unique index cannot express that cross-table rule, so
`application/product-variant-directory.ts`'s `checkVariantSkuAvailable` checks
both tables BEFORE every INSERT/UPDATE (load-bearing ordering, same rule as
every other pre-write existence check in this module), and the DB partial
unique index on `awcms_commerce_product_variants` itself remains the
same-table race-safety net. A collision surfaces as `409
VARIANT_SKU_ALREADY_EXISTS`.

## Images and variants (Issue #23)

`awcms_commerce_product_images` (`media_object_id NOT NULL` — the row IS the
reference) and `awcms_commerce_product_variants` are owned by a product and
edited through it: `POST/PATCH/DELETE /api/v1/commerce/products/{id}/images`
(`+ /{imageId}`) and `.../variants` (`+ /{variantId}`), all gated on
`products.update` — sub-resources of editing a product, not a resource with
its own audience.

A product image's `mediaObjectId` IS checked for live/verified/same-tenant
existence before insert — `MediaLibraryPort.isMediaReferenceSafe`, the same
capability `blog_content` consumes, injected at the route (composition-root
pattern: the route imports `mediaLibraryPortAdapter`, `application/` never
imports `media_library` directly). `GET` responses (list/detail/by-slug)
resolve every image's `mediaObjectId` (and a variant's own optional
`imageMediaObjectId`) to a `publicUrl`/`imageUrl` in ONE batched
`resolveMediaReferences` call per response — never N+1 — via
`product-directory.ts`'s `attachProductRelations`.

### What is still NOT checked

- **`sizeChartMediaId` (product) and `imageMediaObjectId` (variant) are
  validated as UUID-shaped only** — not checked for live/verified existence
  the way an image row's `mediaObjectId` is. A stale or foreign id simply
  resolves to no `publicUrl` at render time (RLS still keeps a cross-tenant
  id from ever resolving to another tenant's media); a deliberate scope
  reduction recorded for #31, not a security gap — every reference is
  tenant-isolated regardless.
- **Keyset pagination stays scoped to `sort=newest`.** `?sort=price_asc`/
  `price_desc`/`name` return a single bounded page
  (`PRODUCT_LIST_LIMIT` = 100, `nextCursor: null`) rather than a keyset walk
  ordered by a second column — see `domain/product-sort.ts`'s header.
- **`price_level_n <= price` is not enforced** — BjekMart lets a distributor
  price exceed the retail price, so this module does not second-guess it.

## Admin screens: two, full CRUD (Issue #23)

`/admin/commerce` (`src/pages/admin/commerce.astro`) — filters
(`categoryId`/`status`/`q`/`featured`/`recommended`), a create form covering
every core field plus the common merchandising flags, per-row inline edit for
the core fields, an "Advanced fields (JSON)" editor for the long tail of
parity columns (tiered pricing, insurance, promo banner, size chart, service
form, subscription/digital, variant attributes — a deliberate compression:
thirty individual controls would dwarf the screen, and this keeps every field
genuinely editable without it), an images picker sourced from
`media_library`'s registry, a variants editor, status transition, soft
delete, and restore.

`/admin/commerce-categories` (new) — category CRUD: create with parent, inline
edit (name/slug — `parentId` is create-only, see "Hierarchy" above), soft
delete, restore.

Both screens are off `scripts/admin-screen-coverage-ledger.ts`'s
`NOT_YET_SCREENED` — every one of the ten declared permissions (five per
activity code, including `restore`) is claimed by one of the two screens.

## Deliberately not here

- **No cart/checkout/payment/orders/shipping/flash-sale/affiliate-link
  surface.** This module is still the catalog + its two rendering-dependency
  tables, not the rest of the storefront.
- **No full-text relevance ranking on `q`.** The trigram/`ILIKE` match
  (`sql/159`) is substring search, not a ranked search index — `site_search`
  is this base's cross-content search module, and `commerce` does not
  integrate with it in this increment.
