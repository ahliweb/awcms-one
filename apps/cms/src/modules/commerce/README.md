🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](README.id.md)

# `commerce`

The catalog slice of the re-platformed storefront (Issue #4, part of epic #1): tenant-scoped product **categories** (hierarchical, self-referencing) and **products**, ported from the legacy MySQL `commerce_bj_mart.{categories,products}` core catalog columns.

| Aspect      | Value                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Key / type  | `commerce` · `domain`, `isCore: false`                                                         |
| Tables      | `awcms_commerce_categories`, `awcms_commerce_products` (`sql/153`)                             |
| Permissions | `categories.{read,create,update,delete}`, `products.{read,create,update,delete}` (`sql/154`)   |
| API         | `/api/v1/commerce/{categories,products}` (`openapi/modules/commerce.openapi.yaml`)             |
| Events      | `commerce.product.{created,updated,status_changed}` — see below                                |
| Depends on  | `tenant_admin`, `identity_access`, `domain_event_runtime` — nothing depends on this module yet |

## Catalog only, and what is NOT here

This is deliberately a slice, not the full upstream schema. The source table carries 40+ product columns; this module takes the core (`categoryId`, `type`, `sku`, `name`, `slug`, `description`, `digitalNote`, `price`, `discountPercent`, `stock`, `status`, `label`, `labelColor`) and leaves the rest for a later increment: tiered pricing (`price_level_2/3/4`), `cost_price`, affiliate fields, size charts, insurance fields, promo banners, `variant_attributes`, and the related tables `product_images`, `product_variants`, `flash_sale_products`, `product_affiliate_links`. None of this module's code references any of them, so admitting them later is additive — new columns and a migration, not a rewrite.

That is also why this module has **no `media_library` dependency**: `product_images` is one of the deferred tables, so there is nothing here yet that resolves a media reference.

## Money is `numeric(14,2)`, and crosses the wire as a string

`price` is never a float — binary floating point cannot represent `0.10` exactly, and money arithmetic on it drifts. PostgreSQL `numeric(14,2)` is exact; `Bun.SQL` hands a `numeric` column back as a **string**, and `application/product-directory.ts` never parses it to a number. The DTO keeps it a string all the way through the API response; a storefront formats it with `Intl.NumberFormat`, it does not compute with it here. `discountPercent` and `stock` are plain `integer` — neither is money, and both are exact in floating point anyway.

## Two independent axes: `status` and soft delete

A product's lifecycle status (`draft` → `active`/`archived`, `active` ⇄ `inactive`, either → `archived`, `archived` → `draft` only — `domain/product-status.ts`'s `LEGAL_TRANSITIONS`) and whether the row is soft-deleted (`deleted_at`) are deliberately separate. Pulling a product from sale without losing it is `status = 'inactive'`; removing it from the tenant's own catalog view is `deleted_at`. There is no dedicated status-transition endpoint — `status` travels through the same `PATCH /api/v1/commerce/products/{id}` as every other field, and `application/product-directory.ts`'s `updateProduct` is what checks the transition is legal (before any write — see its comment on why the ordering is load-bearing) and rejects an illegal one with 400, naming the states actually reachable from the product's current one.

Categories carry no status and no `parentId` on update (see the next section) — the closest structural analog in this base, `awcms_offices`, makes the same two choices, and for the same reason: a hierarchy position is set once, and re-parenting would need cycle detection this codebase does not build even for offices.

## Hierarchy, and what re-parenting would cost

`parentId` is self-referencing and set only at creation (`CreateCategoryInput`); `UpdateCategoryInput` does not carry it at all. Moving a category to a new parent is therefore "delete and recreate", not an edit — the same limitation `office-directory.ts` accepts for `parentOfficeId`. A category whose `parentId` names another tenant's row, an absent id, or a soft-deleted one is rejected identically (400, `ParentCategoryNotFoundError`) — the three causes are indistinguishable on purpose, so the field cannot be used to probe for category ids elsewhere on the platform (GHSA-r7cx-c4jh-cvvw's shape). `products.categoryId` gets the same treatment (`ProductCategoryNotFoundError`), and unlike a category's parent it **is** re-assignable via update.

## No restore endpoint (yet)

Unlike `awcms_offices`, neither table has `deleted_by`/`restored_at`/`restored_by` columns, and there is no `[id]/restore.ts` route or `restore` permission. A soft-deleted category or product is retained — so that any row still referencing it (a child category, a product's `category_id`) keeps a valid FK — but this slice exposes no way to bring it back. Adding restore later is additive: two nullable columns, a permission, and an endpoint.

WHO created/changed/deleted a row lives only in the audit log (`recordAuditEvent`'s `actorTenantUserId`), never in a column on these two tables — which is also what makes `module.ts`'s `subjectData` entries honestly `unreachableBySubject`: there is no column here that could join a row to a person even in principle.

## Domain events: products only, three of them

`categories` publishes none — the same choice `tenant_admin` makes for `awcms_offices`, the structurally closest table in this base. `products` publishes three, all on the `commerce.product` aggregate:

- `commerce.product.created` — a product was created (always `status: draft`).
- `commerce.product.updated` — any field other than `status` changed.
- `commerce.product.status_changed` — `status` transitioned; carries `previousStatus` and `status`, so a consumer that only cares whether a product is still sellable does not have to diff the row.

A single `PATCH` that changes both ordinary fields and `status` publishes both events — they are independent facts. There is no `product.deleted` event: soft delete is an admin/audit concern (recorded in the audit log, like `categories`' own delete), not a catalog-visibility one — a consumer that cares whether a product is still sellable already has `status_changed`.

## Uniqueness

`(tenant_id, slug)` is unique per table among **live** rows (partial index, `WHERE deleted_at IS NULL` — a deleted row's slug is immediately free for reuse), and products additionally enforce `(tenant_id, sku)`. A collision on either surfaces as `409` with a field-specific code (`CATEGORY_SLUG_ALREADY_EXISTS`, `PRODUCT_SLUG_ALREADY_EXISTS`, `PRODUCT_SKU_ALREADY_EXISTS`) rather than an unhandled `500` — `product-directory.ts` distinguishes the two product constraints by the `PostgresError.constraint` name, since a single `23505` catch could not otherwise say which field to fix.

## Admin screen: one, read-only, products only

`/admin/commerce` (`src/pages/admin/commerce.astro`) lists products — SKU, name, type, price, stock, status — gated on `commerce.products.read`. No create/edit form: Issue #4's checklist is the API, and every module still needs at least one screen (`admin-media-page-contract.test.ts`'s "no active module is left without an admin screen"), so this is the minimum that is both honest and true. `categories.*` and every `products.*` action other than `read` stay on `scripts/admin-screen-coverage-ledger.ts`'s `NOT_YET_SCREENED` until a fuller CRUD screen lands.

## Deliberately not here

- **No filtering/search on the list endpoints.** `GET .../products` and `GET .../categories` take only `cursor`, matching `GET /api/v1/offices`'s shape — no `?categoryId=`/`?status=` yet.
- **No `restore` action** — see above.
