🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](api.id.md)

# API

The `/api/v1/commerce/*` endpoints `apps/cms` exposes and `apps/storefront` reads at build time. Source of truth is [`apps/cms/openapi/modules/commerce.openapi.yaml`](../apps/cms/openapi/modules/commerce.openapi.yaml) — a source fragment merged by `bun run openapi:bundle` (inside `apps/cms`) into the full `openapi/awcms-public-api.openapi.yaml` document; this page explains the shape, it is not a second copy of the spec.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/commerce/categories` | List categories for the current tenant, keyset-paginated |
| `POST` | `/api/v1/commerce/categories` | Create a category |
| `GET` | `/api/v1/commerce/categories/{id}` | Fetch one category |
| `PATCH` | `/api/v1/commerce/categories/{id}` | Update a category's `name`/`slug`/`icon` — **no `parentId`**, see below |
| `DELETE` | `/api/v1/commerce/categories/{id}` | Soft-delete a category (audited) |
| `GET` | `/api/v1/commerce/products` | List products for the current tenant, keyset-paginated |
| `POST` | `/api/v1/commerce/products` | Create a product (always starts `status: draft`) |
| `GET` | `/api/v1/commerce/products/{id}` | Fetch one product |
| `PATCH` | `/api/v1/commerce/products/{id}` | Update a product, including a legal status transition |
| `DELETE` | `/api/v1/commerce/products/{id}` | Soft-delete a product (audited) |

## Envelope

Every response is wrapped `{ success: true, data }` or `{ success: false, error: { code, message } }` — the same shape every `awcms` module uses, always, including error responses, so a non-2xx response still parses as JSON. Both list endpoints put their page inside `data`: `{ success: true, data: { items: [...], nextCursor } }`.

## Pagination: keyset, fixed page size, no filter

Both list endpoints are **keyset-paginated**, newest first (`ORDER BY created_at DESC, id DESC`), accepting only an opaque `cursor` query parameter (from a previous response's `nextCursor`, `null` on the last page). The page size is **fixed at 100 server-side** and is not a request parameter — sending `?limit=` has no effect, because `commerce/application/{product,category}-directory.ts`'s `prepare` step reads only `cursor` from the query string.

**There is no `status` filter on the products list route.** `GET /api/v1/commerce/products` returns every live product regardless of lifecycle status; a caller that wants only `active` products filters client-side. This is exactly what `apps/storefront/src/lib/catalog.ts`'s `getProducts()` does — fetches every page, then keeps only `status === "active"` via an exhaustive `switch` (`isPubliclyVisible`) that fails to compile if `apps/cms` ever adds a fifth status without the storefront being updated to say what it means. Adding a server-side `status` filter is a reasonable follow-up for build-time efficiency — the storefront currently fetches and discards non-active products — but it is not built in this slice, and doing so is a CMS change with its own OpenAPI and gate ripple, not a documentation gap.

## Request/response shapes

`CommerceCategory`:

```
{ id: uuid, parentId: uuid | null, name: string, slug: string, icon: string | null }
```

`CommerceProduct`:

```
{
  id: uuid, categoryId: uuid | null, type: "physical" | "digital" | "service" | "subscription",
  sku: string, name: string, slug: string, description: string | null, digitalNote: string | null,
  price: string,            // numeric(14,2), a decimal string — see ADR-0003
  discountPercent: number,  // 0-100
  stock: number,
  status: "draft" | "active" | "inactive" | "archived",
  label: string | null, labelColor: string | null
}
```

`price` is the one field worth calling out explicitly here even though [`docs/skema-basis-data.md`](skema-basis-data.md) and [ADR-0003](adr/0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) cover it in full: it is a JSON **string**, e.g. `"19999.00"`, never a JSON number, on every request and response.

## Errors this API defines beyond the generic envelope

| Status | When | Code |
| --- | --- | --- |
| `400` | `categoryId`/`parentId` does not resolve to a live category in the caller's own tenant | — (see below) |
| `400` | A product's requested `status` is not a legal transition from its current one | — |
| `409` | A category `slug` already taken by a live row in this tenant | `CATEGORY_SLUG_ALREADY_EXISTS` |
| `409` | A product `slug`/`sku` already taken by a live row in this tenant | `PRODUCT_SLUG_ALREADY_EXISTS` / `PRODUCT_SKU_ALREADY_EXISTS` |

A `categoryId`/`parentId` that is unknown, soft-deleted, or belongs to another tenant is rejected with the **same** 400 in every case — see [`docs/skema-basis-data.md`](skema-basis-data.md) for why telling those three causes apart would be a cross-tenant existence oracle.

## Authorization: eight permissions

<!-- hitung:mulai key=commerce-permissions source=table-rows -->

This module defines eight permission keys, each listed below.

| Permission key | Grants |
| --- | --- |
| `commerce.categories.read` | List/fetch categories |
| `commerce.categories.create` | Create a category |
| `commerce.categories.update` | Update a category |
| `commerce.categories.delete` | Soft-delete a category |
| `commerce.products.read` | List/fetch products |
| `commerce.products.create` | Create a product |
| `commerce.products.update` | Update a product, including its status |
| `commerce.products.delete` | Soft-delete a product |

<!-- hitung:selesai -->

Two activity codes (`categories`, `products`), each with the same four CRUD actions — mirrored exactly in [`apps/cms/sql/154_awcms_commerce_permissions.sql`](../apps/cms/sql/154_awcms_commerce_permissions.sql), with a gate keeping the seed and `commerce/module.ts`'s `permissions` array in step. There is no `restore` permission for either resource — this slice ships no restore endpoint at all (see [`docs/skema-basis-data.md`](skema-basis-data.md)).

## Domain events: three, products only

`categories` publishes no domain events — the same choice `tenant_admin` makes for the structurally closest table in this codebase (`awcms_offices`); a soft delete is an audit-log fact, not something a downstream consumer needs to react to. `products` publishes three, all on the `commerce.product` aggregate, registered in the three places `awcms` keeps in sync (`domain-event-runtime/domain/event-type-registry.ts`, `asyncapi/awcms-domain-events.asyncapi.yaml`, `commerce/module.ts`'s `events.publishes`):

- `awcms.commerce.product.created` — a product was created (always `status: draft`).
- `awcms.commerce.product.updated` — any field other than `status` changed.
- `awcms.commerce.product.status_changed` — `status` transitioned; carries `previousStatus` and `status`.

A single `PATCH` that changes both ordinary fields and `status` in the same request publishes both `.updated` and `.status_changed` — they record independent facts. There is no `product.deleted` event, for the same reason categories publish nothing: a consumer that cares whether a product is still sellable already has `.status_changed` (e.g. a transition to `archived`).

## Not built

A runtime read of this API by the storefront — every call happens at `astro build` time only (see [ADR-0002](adr/0002-static-output-with-build-time-fetch-for-the-storefront.md)). Cart, checkout, payment, orders, shipping, variant, flash-sale, and affiliate endpoints — none exist; this API surfaces exactly the two resources named above. Media/image endpoints for either resource — there is no `product_images` table in this slice (see [`docs/skema-basis-data.md`](skema-basis-data.md)).
