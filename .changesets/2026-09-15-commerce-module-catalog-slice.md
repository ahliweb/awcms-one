---
bump: minor
type: structure
impact: public
---

# apps/cms: the `commerce` module — catalog domain, persistence, migrations, API

Adds the `commerce` module to the embedded CMS (issue #4): categories (hierarchical) and products, the catalog core of the legacy `commerce_bj_mart` schema, as `awcms_commerce_categories` and `awcms_commerce_products` under PostgreSQL row-level security, with `GET`/`POST` list-and-create and `GET`/`PATCH`/`DELETE` by id at `/api/v1/commerce/{products,categories}`, an OpenAPI fragment, three domain events, and a read-only `/admin/commerce` screen.

- Every table is `ENABLE` **and** `FORCE ROW LEVEL SECURITY` with a `tenant_id = current_setting('app.current_tenant_id')` policy. Proven, not declared: as the unprivileged `awcms_app` role, a query with no tenant context fails closed and an insert whose `tenant_id` differs from the session tenant is refused by the policy.
- `price` is `numeric(14,2)` and stays a **string** through the directory, the DTO, and the API — never a JS `number`. `discount_percent` and `stock` are `integer` with `CHECK` bounds.
- `status` (`draft`→`active`→`inactive`→`archived`, with legal transitions in the domain layer) and `deleted_at` are independent axes: unavailable-for-sale and deleted-by-the-merchant are different states.
- Migrations `sql/153`–`sql/155`. The full chain `001`→`155` was applied from an **empty** database, which is what a real deployment does. `sql/155` grants the lifecycle worker the rights the generic purge engine needs; `cursorColumn: "deleted_at"` means that engine is mathematically unable to purge a live row.
- Twenty-nine upstream files in `apps/cms/` are modified — the module registry, the event-type registry, the AsyncAPI and OpenAPI catalogues, the sidebar registry, the admin-screen coverage ledger, and the generated inventories and module-count lines that awcms's own `check` chain regenerates or enforces when a module is admitted. Each one is a future `git subtree pull` conflict point; the resolution is to re-run the generators after a sync, not to hand-merge generated output.
- The list endpoints return the awcms house envelope `{items, nextCursor}`; the storefront's local assumption of `{products}` / `{categories}` is reconciled in issue #6.
