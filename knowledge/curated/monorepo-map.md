# Monorepo map

What is root-owned, what is a synchronised subtree, and what is still planned — the one fact code alone cannot tell a reader, because a directory that does not exist yet leaves no trace to grep for.

| Path | What it is | Owned by |
| --- | --- | --- |
| `apps/cms/` | `ahliweb/awcms` v10.3.0, embedded whole via `git subtree`, full history preserved — carries the one `commerce` module (catalog, marketing, orders — [ADR-0008](../../docs/adr/0008-one-commerce-module-carries-the-whole-store-not-three.md)) | upstream (`ahliweb/awcms`) — sync only, never hand-edited locally |
| `apps/storefront/` | The public Astro storefront — full catalog + news parity, cart, checkout, order tracking, wishlist; `output: "static"` throughout, cart/checkout call `apps/cms`'s anonymous API from the browser ([ADR-0007](../../docs/adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md)) | this repo |
| `packages/config/` | Shared `tsconfig` preset | this repo |
| `packages/gerbang/` | This workspace's audit gates, as a package | this repo |
| `packages/kontrak/` | The type-only DTO contract `apps/storefront` imports from `apps/cms`, plus its import-direction gate | this repo |
| `tools/`, `tests/`, `.changesets/` | Cross-workspace scripts (incl. `tools/seed-borneojek-mart.ts`), root gate tests, release notes | this repo |
| `knowledge/` | This directory — the federated Graphify + Obsidian workflow | this repo |
| `.claude/skills/` | `awcms-one-storefront`, `awcms-one-commerce` — how-to guides for adding a storefront page or a commerce table/endpoint through the module | this repo |
| `compose.yaml`, `docker/postgres-init/` | A disposable local/CI PostgreSQL ([issue #25](https://github.com/ahliweb/awcms-one/issues/25)) — never production | this repo |

## Why `apps/cms` embeds `awcms` whole, not as a dependency

The commerce module this platform needs depends on `awcms` shared infrastructure with no standalone package — `withTenant`, `authorizeInTransaction`, `appendDomainEvent`, `recordAuditEvent`, the module contract, the SQL migration runner. Depending on it as a package would mean re-exporting all of that; embedding it via `git subtree` keeps upstream's full commit history inside this repo instead, so fixes flow in both directions. Full reasoning: root [`README.md`](../../README.md#why-apps-cms-embeds-awcms-whole).

## Why this repo exists at all

`awcms-one` re-platforms the borneojek-mart commerce store — PHP/Laravel/MySQL/React-Inertia — onto Bun/Astro/PostgreSQL-RLS. A **re-platform, not a refactor**: no Laravel code is carried over, and the source schema is read from the live `commerce_bj_mart` MySQL database and re-expressed as AWCMS module tables under PostgreSQL RLS. Full framing: [issue #1](https://github.com/ahliweb/awcms-one/issues/1); the rationale for *why* this path rather than an in-place Laravel upgrade is in [`lessons-learned.md`](lessons-learned.md).

## Approach

Scaffold-first, then one thin vertical slice (increment 1: catalog listing + product detail, no live database), then the full store (increment 2, epic [#21](https://github.com/ahliweb/awcms-one/issues/21)): a provisioned PostgreSQL, the complete `commerce` module, and the complete public site — catalog, news, cart, checkout, order tracking, wishlist. See root [`AGENTS.md`](../../AGENTS.md#what-is-here-today-and-what-is-not) for the current, up-to-date state of what exists versus what is still planned — this file names the STRUCTURE, that one names the STATUS, and the status changes far more often than the structure does.
