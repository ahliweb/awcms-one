# Changelog

Every entry below is folded from `.changesets/` by `bun run release`, which also tags the release. The version is `MAJOR.MINOR.PATCH`, tagged `vX.Y.Z`; the next version is the largest `bump` declared among the changesets a release folds (see [`.changesets/README.md`](.changesets/README.md)) — never a level chosen at release time from a list of file names.

## [0.2.0] — 2026-09-15

### Architecture and reference documentation, describing the merged tree as it actually is

Adds `docs/` (issue #7): architecture, six ADRs, the database schema, a data dictionary mapping every `awcms_commerce_*` column to its legacy `commerce_bj_mart` source column, the commerce API, the CMS authoring workflow, storefront routing, SEO, accessibility, responsive design, UI/UX, testing, deployment, and the development workflow — plus `docs/README.md` as the index. Every document is mirrored to Indonesian (`docs:i18n:stamp`) and lands with `AGENTS.md`/`README.md` updated to describe the tree as it now is: every child issue of #1 (#2, #4, #5, #6, #11) has landed, so the "not here yet" framing both documents carried is retired.

- `bun run audit:dokumen`'s ADR-index and `ADR-NNNN`-citation checks run for real for the first time in this repository, now that `docs/adr/` exists — both green against the six ADRs landed here.
- Where the tree disagreed with the original issue text, the documents follow the tree: the URL shape (`/product/{slug}`, per the live-site evidence on issue #5), the real API envelope (`{ items, nextCursor }`, not the originally assumed shape), and the real, verified branch-protection settings (a required `Check` status check; no merge-strategy restriction) are what is documented, not what was planned.
- A pre-existing, unrelated defect surfaced by activating the ADR-citation check for the first time — a generated Obsidian note under `knowledge/generated/graphify/` extracts `packages/gerbang/audit-dokumen.mjs`'s own illustrative example (`` `ADR-0042` ``) as a false citation — is filed as [issue #15](https://github.com/ahliweb/awcms-one/issues/15) rather than patched here, since fixing it needs a change to `packages/gerbang/` or a knowledge-graph regeneration, both outside this change's own scope.

### audit:dokumen no longer reads knowledge/generated/

`bun run audit:dokumen` now skips `knowledge/generated/` the way it already skips `apps/cms/` (issue #15). Graphify's Obsidian export extracts notes from source code; it does not author them. The first false positive was concrete: the moment `docs/adr/` existed, the ADR-citation check fired on three generated notes quoting the gate's own illustrative example citation (a placeholder ADR number in a comment in `packages/gerbang/audit-dokumen.mjs`). Every other check in the gate would misfire on generated notes the same way — their links are wikilinks the gate does not parse, and a stale path in one is graph staleness, which `bun run audit:graf` deliberately leaves alone. `knowledge/curated/` and `knowledge/README.md` are authored and stay in scope; two fixture tests pin both sides of that line.

### apps/cms: the `commerce` module — catalog domain, persistence, migrations, API

Adds the `commerce` module to the embedded CMS (issue #4): categories (hierarchical) and products, the catalog core of the legacy `commerce_bj_mart` schema, as `awcms_commerce_categories` and `awcms_commerce_products` under PostgreSQL row-level security, with `GET`/`POST` list-and-create and `GET`/`PATCH`/`DELETE` by id at `/api/v1/commerce/{products,categories}`, an OpenAPI fragment, three domain events, and a read-only `/admin/commerce` screen.

- Every table is `ENABLE` **and** `FORCE ROW LEVEL SECURITY` with a `tenant_id = current_setting('app.current_tenant_id')` policy. Proven, not declared: as the unprivileged `awcms_app` role, a query with no tenant context fails closed and an insert whose `tenant_id` differs from the session tenant is refused by the policy.
- `price` is `numeric(14,2)` and stays a **string** through the directory, the DTO, and the API — never a JS `number`. `discount_percent` and `stock` are `integer` with `CHECK` bounds.
- `status` (`draft`→`active`→`inactive`→`archived`, with legal transitions in the domain layer) and `deleted_at` are independent axes: unavailable-for-sale and deleted-by-the-merchant are different states.
- Migrations `sql/153`–`sql/155`. The full chain `001`→`155` was applied from an **empty** database, which is what a real deployment does. `sql/155` grants the lifecycle worker the rights the generic purge engine needs; `cursorColumn: "deleted_at"` means that engine is mathematically unable to purge a live row.
- Twenty-nine upstream files in `apps/cms/` are modified — the module registry, the event-type registry, the AsyncAPI and OpenAPI catalogues, the sidebar registry, the admin-screen coverage ledger, and the generated inventories and module-count lines that awcms's own `check` chain regenerates or enforces when a module is admitted. Each one is a future `git subtree pull` conflict point; the resolution is to re-run the generators after a sync, not to hand-merge generated output.
- The list endpoints return the awcms house envelope `{items, nextCursor}`; the storefront's local assumption of `{products}` / `{categories}` is reconciled in issue #6.

### Federated knowledge-graph workflow: root Graphify graph, `audit:graf`, safe Obsidian export

Adds a monorepo-level Graphify + Obsidian workflow (issue #11) without duplicating or corrupting the Graphify state already embedded inside `apps/cms` via the `ahliweb/awcms` subtree. Two graphs, federated on demand rather than one graph built twice — the same discipline the rest of this repo already applies to `apps/cms`'s own tree.

- Root `.graphifyignore` + a real, committed root graph (`graphify-out/graph.json`, 396 nodes) built `--code-only` — structural AST extraction, no LLM, no API key, no network, ever, by default. Excludes `apps/cms/**`, which already owns its own graph and its own gate.
- `bun run audit:graf` (alias `knowledge:check`) — the fourth `audit:*` gate, modelled on `apps/cms/scripts/graph-artifacts-check.ts`: tracked-artefact hygiene, report/graph agreement, chosen community names, `.graphifyignore` still excluding `apps/cms`, no duplicate-extracted node, the federated graph never tracked, and `apps/cms/graphify-out/` untouched by this repo's own tooling. Runs in CI (`.github/workflows/ci.yml`) — it reads only committed artefacts, no `graphify` installation needed.
- `bun run knowledge:graph:combine` — merges the root graph with `apps/cms/graphify-out/graph.json` into a gitignored, on-demand `graphify-out/combined/graph.json`, failing closed on a missing, malformed, empty, or `directed`-mismatched component graph (checks `graphify merge-graphs` itself does not make).
- `bun run knowledge:obsidian:export` — stages the root graph's Obsidian export, validates every file (rejecting a symlink, an unexpected extension, path traversal, or a curated-filename collision), and syncs only the allowlisted result to `knowledge/generated/graphify/`. `knowledge/curated/` is read only for collision-checking, never written.
- `packages/gerbang/lib/subtree-guard.mjs` guards every write both new tools perform; `tests/knowledge-no-subtree-write.test.mjs` runs both tools for real against a fixture tree and proves `apps/cms/` comes out byte-for-byte unchanged.
- `knowledge/README.md` + five thin `knowledge/curated/*.md` files record what code alone cannot state: ownership boundaries, cross-repo source-of-truth rules, the tracked/untracked table, and a nine-item threat model — no ISO/IEC certification claimed.
- `README.md`/`AGENTS.md` (and their Indonesian mirrors) revisit the earlier, now-outdated statement that `audit:graf` was not ported — it is, and both documents say why and what changed.

### packages/kontrak: the type-only DTO contract, and the storefront reconciled to the real envelope

Adds the fifth workspace member, `@awcms-one/kontrak` (issue #6): `ProductType`/`ProductStatus` re-exported, `export type` only, from `apps/cms`'s commerce domain layer (`apps/cms/src/modules/commerce/domain/{product-type,product-status}.ts`) — never hand-copied again. `tests/kontrak-arah-impor.test.mjs` guards the one-way import direction (`storefront -> kontrak -> cms`) that keeps `apps/cms`'s `git subtree pull` safe: a dependency pointing back at this repo's own code would turn every future sync into a merge conflict against code upstream never wrote.

Reconciles `apps/storefront/src/lib/catalog.ts` against the real commerce API that landed with issue #4, closing four mismatches a side-by-side review of the two merged PRs surfaced:

- Both list responses are read as `{ items, nextCursor }` — the awcms house keyset-page shape — not the invented `{ products }` / `{ categories }` this app shipped with, which would have crashed the build on `undefined`.
- Categories are now keyset-paginated with the same cursor walk products already use, not fetched as a single unpaginated page.
- `status` and `limit` are no longer sent as query parameters — the CMS route accepts only `cursor` and fixes the page size server-side; sending parameters it silently ignores was a lie in the request log.
- `getProducts()` now filters with an exhaustive `switch` (`isPubliclyVisible`) instead of a bare `status === "active"` comparison, so a `ProductStatus` `apps/cms` adds later cannot silently fall through — verified by hand: widening the union in a worktree turned `bun run check` red at that exact line (the captured error is in this change's pull request description).

`CommerceProduct`/`CommerceCategory` — the row DTO shapes — stay declared locally in `catalog.ts` rather than moving into `@awcms-one/kontrak`: they live in `apps/cms/src/modules/commerce/application/{product,category}-directory.ts`, not `domain/`, so they are out of that package's scope by its own rule (`application/` may carry I/O-bearing imports on other lines of the same file).

Fixtures (`apps/storefront/tests/fixtures/awcms/*.json`) and `apps/storefront/scripts/stub-awcms.mjs` now emit the real envelope too, so the offline build proof against the stub is honest rather than agreeing with the bug it used to ship with.

### Monorepo foundation: audit gates, release tooling, governance docs, and CI

Stands up the machinery `apps/storefront` (issue #5) and `packages/kontrak` (issue #6) will land into, modelled on `ahliweb/media-lenterakalteng`: `packages/gerbang`'s three audit gates (`audit:dokumen`, `audit:rilis`, `audit:translation`), `tools/rilis.mjs` + `cek-lockfile.mjs` + `docs-i18n-stamp.mjs`, the `.changesets/` convention itself, every governance document with its Indonesian mirror, and a CI workflow that runs the check job unconditionally.

- `bun install` resolves the workspace; `bun test` from the root is green and does not execute anything under `apps/cms/` (already excluded via `bunfig.toml`, proven here rather than merely trusted).
- Content, asset, and crawl gates (`audit:konten`, `audit:aset`, `audit:graf`, `audit:serapan`) are deliberately **not** ported: this repository has no built content, asset, or crawl surface yet for them to guard. Porting them now would ship gates that always pass trivially, which is worse than not having them — a green gate that checks nothing reads exactly like one that checked something and found it clean.
- `AGENTS.md` records the `git subtree` sync discipline for `apps/cms`: a subtree-sync PR must be merged with a merge commit, never squashed or rebased, or the next `git subtree pull` loses the merge base it needs.

### apps/storefront: the public catalog and product-detail storefront

Adds the fourth workspace member, `apps/storefront` (issue #5): an Astro app with `output: "static"` that fetches the catalog from `apps/cms` at **build** time and bakes it — the running container holds no API token and never reaches the database. Catalog at `/`, product pages at `/product/{slug}` with no trailing slash, matching the live `mart.borneojek.com` URL shape so indexed URLs, bookmarks, and shared links survive the cutover unchanged; `/products` (with or without a query string) 301s to `/`.

- `price` is carried as the `numeric(14,2)` **string** PostgreSQL emits and formatted only for display with `Intl.NumberFormat`; nothing in the app parses it into money arithmetic.
- The build fails loudly on a non-2xx, a `{success:false}` envelope, a catalog where no product is `active`, or a cursor that never terminates — a storefront that silently publishes an empty catalog is worse than a red build.
- CSP-strict by construction: `inlineStylesheets: "never"` and `assetsInlineLimit: 0`, so no inline `<style>`, `<script>`, or `data:` URI is ever emitted. CMS-supplied `labelColor` badges are compiled into a generated external stylesheet (`product-labels.css`) rather than inline styles, with a WCAG-contrast-chosen foreground.
- JSON-LD is written through an escaper that turns `<`, `>`, `&` into `\uXXXX` after `JSON.stringify` — the HTML parser closes a `<script>` at the first `</script>` regardless of `type`, so a product name containing one would otherwise break out of the data block. A committed fixture (`XSS-REGRESI-01`) guards it.
- The build is reproducible offline against `apps/storefront/scripts/stub-awcms.mjs` + `apps/storefront/tests/fixtures/awcms/`.
- The DTO unions are declared locally for now; issue #6 replaces them with a re-export from `@awcms-one/kontrak`.

## [0.1.0] — 2026-09-15

Initial workspace scaffolding, landed before the `.changesets/` convention itself existed — recorded here by hand rather than folded from a changeset entry.

- Bun workspace root (`workspaces: ["apps/*", "packages/*"]`), pinned toolchain (`bun@1.4.0`), and the dotfiles that govern it (`.gitignore`, `.editorconfig`, `.dockerignore`).
- `packages/config` — the shared `tsconfig.base.json` preset.
- `apps/cms` — `ahliweb/awcms` v10.3.0, embedded whole via `git subtree` with full history (closes #2).
