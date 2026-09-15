🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](skema-basis-data.id.md)

# Database schema

The `awcms_commerce_*` tables: columns, types, constraints, indexes, and the row-level security that scopes every query to one tenant. Source of truth is [`apps/cms/sql/153_awcms_commerce_schema.sql`](../apps/cms/sql/153_awcms_commerce_schema.sql) (the tables and indexes), [`sql/154_awcms_commerce_permissions.sql`](../apps/cms/sql/154_awcms_commerce_permissions.sql) (the permission catalog seed), and [`sql/155_awcms_commerce_worker_lifecycle_purge_grants.sql`](../apps/cms/sql/155_awcms_commerce_worker_lifecycle_purge_grants.sql) (grants for the purge worker) — this document explains them, it does not replace reading them.

## `awcms_commerce_categories`

Hierarchical, self-referencing.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | PK, `DEFAULT gen_random_uuid()` |
| `tenant_id` | `uuid NOT NULL` | `REFERENCES awcms_tenants (id)` |
| `parent_id` | `uuid` | `REFERENCES awcms_commerce_categories (id)`, nullable; set only at creation — see "No re-parenting" below |
| `name` | `text NOT NULL` | |
| `slug` | `text NOT NULL` | Unique per tenant among live rows — see Indexes |
| `icon` | `text` | Nullable |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `deleted_at` | `timestamptz` | Nullable — see "Two independent axes" below |

**Indexes:** a unique index on `(tenant_id, slug) WHERE deleted_at IS NULL` (a deleted row's slug frees up immediately for reuse); a plain index on `tenant_id`; a composite index on `(tenant_id, deleted_at)` (the generic data-lifecycle purge engine's own filter shape); an index on `parent_id` (both the hierarchy walk and `apps/cms`'s `db:fk-index:check` gate, which requires every FK column to carry one).

## `awcms_commerce_products`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | PK, `DEFAULT gen_random_uuid()` |
| `tenant_id` | `uuid NOT NULL` | `REFERENCES awcms_tenants (id)` |
| `category_id` | `uuid` | `REFERENCES awcms_commerce_categories (id)`, nullable |
| `type` | `text NOT NULL DEFAULT 'physical'` | `CHECK IN ('physical', 'digital', 'service', 'subscription')` |
| `sku` | `text NOT NULL` | Unique per tenant among live rows |
| `name` | `text NOT NULL` | |
| `slug` | `text NOT NULL` | Unique per tenant among live rows |
| `description` | `text` | Nullable |
| `digital_note` | `text` | Nullable |
| `price` | `numeric(14, 2) NOT NULL` | `CHECK (price >= 0)` — see [ADR-0003](adr/0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) |
| `discount_percent` | `integer NOT NULL DEFAULT 0` | `CHECK BETWEEN 0 AND 100` |
| `stock` | `integer NOT NULL DEFAULT 0` | `CHECK (stock >= 0)` |
| `status` | `text NOT NULL DEFAULT 'draft'` | `CHECK IN ('draft', 'active', 'inactive', 'archived')` — see [`docs/cms.md`](cms.md) for the legal transition table |
| `label` | `text` | Nullable, e.g. a merchandising badge like "Baru" |
| `label_color` | `text` | Nullable, an arbitrary hex string; see [`docs/ui-ux.md`](ui-ux.md) for how the storefront renders it safely |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `deleted_at` | `timestamptz` | Nullable |

**Indexes:** unique indexes on `(tenant_id, slug) WHERE deleted_at IS NULL` and `(tenant_id, sku) WHERE deleted_at IS NULL`; a plain index on `tenant_id`; a composite index on `(tenant_id, deleted_at)`; an index on `category_id` (the FK-index gate, and the natural index a future category-browse page would need).

## Row-level security: `ENABLE` and `FORCE`, proven under the unprivileged role

Both tables carry `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` **and** `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, with one policy each:

```sql
CREATE POLICY awcms_commerce_products_tenant_isolation
  ON awcms_commerce_products
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

`FORCE` matters specifically because the table owner would otherwise bypass RLS entirely — `ENABLE` alone protects against every role except the one that created the table. The application connects as `awcms_app`, an unprivileged, non-superuser role (`apps/cms/sql/019_awcms_db_role_separation.sql`) — never the owner — so this policy is the actual, load-bearing tenant boundary for every commerce query, not a defence-in-depth line that never gets exercised.

This is proven, not merely declared: `apps/cms`'s generic RLS test suite (`apps/cms/tests/db-role-separation-migration.test.ts`, `apps/cms/tests/security-readiness-rls.test.ts`, `apps/cms/tests/integration/db-role-separation.integration.test.ts`) derives its table list from every `awcms_%` table's own `ENABLE`/`FORCE` statements across `sql/` (`apps/cms/scripts/lib/table-rls-states.ts`), rather than naming tables by hand — so `awcms_commerce_categories`/`awcms_commerce_products` are covered automatically, the same way every other RLS table in this codebase is, with no commerce-specific test needed. As the unprivileged `awcms_app` role: a query issued with no tenant context set fails closed (the policy's `current_setting('app.current_tenant_id')` raises rather than returning an empty string that would coincidentally match nothing), and an attempt to insert a row under one tenant's context while naming another tenant's id is refused by the same policy. These integration tests need a live PostgreSQL and were not re-run to write this document (see [`docs/pengujian.md`](pengujian.md) for why); the claim above is the codebase's standing, generic guarantee for every `FORCE ROW LEVEL SECURITY` table, commerce included, not a re-verification done specifically for this document.

**`category_id` crossing tenants is closed at the application layer, not by the foreign key.** A PostgreSQL FK constraint has no tenant awareness — it only proves a `category_id` names *some* row in `awcms_commerce_categories`, not one belonging to the caller's own tenant. `commerce/application/product-directory.ts`'s `createProduct`/`updateProduct` instead call `fetchCategoryById(tx, tenantId, categoryId)` — a query scoped by the RLS-bearing transaction, inside the same `tx` — and reject the request (400) if it returns nothing. An id that is unknown, soft-deleted, or genuinely belongs to another tenant is rejected **identically**, on purpose: telling those three causes apart in the response would let the field be used to probe for category ids that exist elsewhere on the platform (the GHSA-r7cx-c4jh-cvvw existence-oracle shape). The same pattern, for the same reason, guards a category's own `parentId`.

## `status` and `deleted_at`: two independent axes

A product's lifecycle `status` (`draft`/`active`/`inactive`/`archived`) and whether its row is soft-deleted (`deleted_at`) answer two different questions and are never conflated. Pulling a product from sale without losing its record is `status = 'inactive'`; removing it from the tenant's own catalog view entirely is `deleted_at`. Categories carry `deleted_at` but no `status` column at all — a category has no independent lifecycle beyond existing or being removed.

## No actor-stamp columns

Neither table carries `created_by`, `updated_by`, or `deleted_by`. WHO created, changed, or soft-deleted a row lives **only** in the audit log (`recordAuditEvent`'s `actorTenantUserId` — see [`docs/cms.md`](cms.md)), never as a column here. This is also what makes `commerce/module.ts`'s `subjectData` descriptors honestly `unreachableBySubject: true`: with no column that could join a row to a person even in principle, there is nothing here a data-subject request could reach.

## No restore endpoint in this slice

Neither table carries `restored_at`/`restored_by`, and there is no `[id]/restore.ts` route or `restore` permission for either resource. A soft-deleted category or product is retained — so any row still referencing it (a child category, a product's `category_id`) keeps a valid foreign key — but this slice exposes no way to bring it back through the API. `sql/153`'s own header calls this out as additive: two nullable columns and an endpoint, not a migration of existing rows, whenever restore is actually built.

## `dataLifecycle`: the purge engine can never reach a live row

Both tables opt into `apps/cms`'s generic data-lifecycle purge engine (`commerce/module.ts`'s `dataLifecycle` array) rather than a hand-rolled purge job, with `cursorColumn: "deleted_at"` — not `created_at`, unlike most tables that use this engine. This is deliberately what makes the purge safe: the engine's own query is `WHERE ... AND deleted_at < $2`, and in SQL `NULL < $2` is neither true nor false, so a **live** row (`deleted_at IS NULL`) can never match that predicate. Only a row already soft-deleted becomes purge-eligible, and only after sitting deleted for the configured retention window (30–3650 days, default 365) — the engine is mathematically incapable of reaching a live row, not merely configured not to.

## Permissions (`sql/154`)

Two activity codes, `categories` and `products`, each with the same four CRUD actions, seeded into the global `awcms_permissions` catalog and mirrored exactly by `commerce/module.ts`'s `permissions` array (a gate keeps the two in step): `commerce.categories.{read,create,update,delete}`, `commerce.products.{read,create,update,delete}` — eight permissions in total. There is deliberately no `restore` permission for either resource, matching the absence of a restore endpoint above.

## Worker grants (`sql/155`)

`awcms_worker` — the role the data-lifecycle purge job connects as — gets `GRANT SELECT, DELETE` on both tables, and nothing wider. No `UPDATE`: the purge engine only ever deletes an eligible row, never anonymises one, so a grant the code never exercises is not issued. `apps/cms/sql/019_awcms_db_role_separation.sql`'s default privileges only ever cover `awcms_app`; `awcms_worker` needs this explicit, per-table grant to run at all.

## Deliberately not in this schema

Per `sql/153`'s own header and [`docs/kamus-data.md`](kamus-data.md), these columns and tables carry no code reference anywhere in this slice, so admitting them later is additive rather than a migration of existing data: tiered pricing (`price_level_2`, `price_level_3`, `price_level_4`), `cost_price`, every `affiliate_*` column, every `size_chart_*` column, every `insurance_*` column, every `promo_banner_*` column, `variant_attributes`, and the related tables `product_images`, `product_variants`, `flash_sale_products`, `product_affiliate_links`.
