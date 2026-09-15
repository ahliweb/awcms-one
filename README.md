🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](README.id.md)

[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE) [![runtime](https://img.shields.io/badge/runtime-Bun-blue?logo=bun&logoColor=white)](https://bun.sh)

# awcms-one

**awcms-one** is the borneojek-mart commerce platform, re-platformed from PHP/Laravel/MySQL/React-Inertia onto the AWCMS stack — Bun, Astro, and PostgreSQL under row-level security. This is a **re-platform, not a refactor**: no Laravel code is carried over. The source schema is read from the live `commerce_bj_mart` MySQL database and re-expressed as AWCMS module tables under PostgreSQL RLS. The framing and the full epic are in [issue #1](https://github.com/ahliweb/awcms-one/issues/1).

## Where this sits in the AWCMS family

| | |
| --- | --- |
| **This repo** | `ahliweb/awcms-one` — a Bun monorepo: one commerce backend (`apps/cms`), one public storefront (`apps/storefront`), one shared DTO contract (`packages/kontrak`) |
| **Backend / system of record** | `apps/cms`, in this repo — `ahliweb/awcms` embedded whole via `git subtree`, preserving upstream history |
| **Model repo** | [`ahliweb/media-lenterakalteng`](https://github.com/ahliweb/media-lenterakalteng) — the workspace layout, audit gates, changeset convention, and governance-document structure in this repo are adapted from it |

## Why `apps/cms` embeds `awcms` whole

The commerce module this platform needs cannot stand on its own — it depends on `awcms` shared infrastructure that has no standalone package: `withTenant` (RLS tenant context), `authorizeInTransaction` (RBAC/ABAC), `appendDomainEvent` (outbox), `recordAuditEvent`, `_shared/module-contract` (`defineModule`), `getDatabaseClient`, the SQL migration runner, and `_shared/api-response`. So `awcms` is embedded whole, via `git subtree`, rather than depended on as a package — see [`AGENTS.md`](AGENTS.md#the-subtree-embed) for the sync mechanics and the one rule that protects them.

## Approach: foundation first, then one thin vertical slice

Scaffold-first, then **one thin vertical slice** — catalog listing + product detail — to prove the stack end to end before the full commerce build.

**Increment 1 (this epic): foundation + authored slice, no live database.** Everything type-checks and every gate that does not need PostgreSQL runs green. Migrating and seeding a real PostgreSQL instance and rendering from it is increment 2 — AWCMS is PostgreSQL-only while the borneojek server runs MySQL, so a Postgres instance has to be provisioned first.

Out of scope for increment 1: cart, checkout, payment, orders, shipping, affiliate, flash sales, variants, tiered pricing, insurance, size charts, promo banners. The schema slice is deliberately the catalog core; the rest of the source `products` table lands in later increments.

## What is here today, and what is not

Every child issue of [issue #1](https://github.com/ahliweb/awcms-one/issues/1) has landed: the workspace root and its governance, `packages/config`, `packages/gerbang`, `packages/kontrak`, `tools/`, `knowledge/`, `docs/`, `apps/storefront`, and `apps/cms` (carrying the `commerce` module). Where this document or `AGENTS.md` needs to describe a surface increment 1 does not build, it says so plainly rather than describing a path that is not there — see [`docs/arsitektur.md`](docs/arsitektur.md) and [`docs/cms.md`](docs/cms.md) for that full, current list (cart, checkout, payment, orders, shipping, variants, flash sales, affiliate links, tiered pricing, advertising, logo management, product imagery).

```
apps/
├── cms/                     ahliweb/awcms v10.3.0, embedded via git subtree with full history —
│                             the commerce backend and system of record, carrying the commerce
│                             module (catalog domain, persistence, API — closes #2, #4)
└── storefront/              the public Astro storefront: catalog listing + product detail,
                              output: "static", fetching apps/cms's API at build time only (closes #5)
packages/
├── config/                  shared tsconfig preset
├── gerbang/                 this workspace's audit gates, as a package
└── kontrak/                 the type-only DTO contract apps/storefront imports from apps/cms,
                              plus its import-direction gate (closes #6)
tools/                       cross-workspace scripts: release, lockfile check, docs i18n stamp,
                              knowledge-graph update/combine/export
tests/                       the root-level gate tests (docs, changesets, toolchain, scripts,
                              import direction)
docs/                        architecture, schema, API, CMS, routing, SEO, accessibility,
                              responsive, UI/UX, testing, deployment, and workflow reference,
                              plus docs/adr/ (closes #7)
knowledge/                   the federated Graphify + Obsidian knowledge-graph workflow (closes #11)
.changesets/, .github/       stay at the repo root — decisions about the whole repo
```

PostgreSQL provisioning for increment 2 — migrating and seeding a live database for `apps/cms` to run against — is **not done**; see [`docs/deployment.md`](docs/deployment.md).

## Running it

```bash
cp .env.example .env
bun install
bun test               # the root gate suite — see "Gates" below
```

This repo is **Bun-only**: Bun is both the runtime and the package manager, its version is pinned in `packageManager`/`engines.bun`, and `bun.lock` is the only lockfile.

| Command | Purpose |
| --- | --- |
| `bun install` | Resolves the whole workspace |
| `bun test` | The root gate suite. `bunfig.toml` excludes `apps/cms/**` — that suite is ~500 files and needs a live PostgreSQL; it runs under its own gate, `bun run check:cms` |
| `bun run check:lockfile` | Proves `bun.lock` actually belongs to this repo's `package.json`, for the root and every workspace member |
| `bun run audit:dokumen` | Dead markdown links, the `docs/adr/` index (complete in both directions, status agreement), file paths a document names, `ADR-NNNN` citations, and marked linked counts |
| `bun run audit:rilis` | The waiting `.changesets/` backlog, bounded at 10 files and 14 days |
| `bun run audit:translation` | Stale or missing Indonesian mirrors of the governance documents |
| `bun run audit:graf` (alias: `knowledge:check`) | The root knowledge-graph corpus describes itself honestly — see [`knowledge/README.md`](knowledge/README.md) |
| `bun run knowledge:graph:update` | Rebuilds the root Graphify graph (`--code-only`, no LLM) — needs `graphify` on `PATH`, not run in CI |
| `bun run knowledge:graph:combine` | Merges the root graph with `apps/cms`'s own into a gitignored, on-demand federated graph — needs `graphify` on `PATH` |
| `bun run knowledge:obsidian:export` | Stages, validates, and syncs a safe Obsidian export of the root graph to `knowledge/generated/graphify/` — needs `graphify` on `PATH` |
| `bun run docs:i18n:stamp` | Writes the language banners and source-hash markers on every `.id.md` mirror |
| `bun run check:cms` | `apps/cms`'s own full gate chain (lint, typecheck, its own tests, its own build) |
| `bun run db:migrate:cms` | Runs `apps/cms`'s migrations against `DATABASE_URL` — see `apps/cms/.env.example` |
| `bun run release` | Cuts a tagged release from the waiting changesets — see [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| `dev` / `build` / `check` / `serve` | Delegate into `apps/storefront` — `bun run build` type-checks, fetches the catalog from `apps/cms` at build time, and bakes static output; `bun run serve` runs the built `apps/storefront/server/penyaji.mjs` — see [`docs/deployment.md`](docs/deployment.md) |

### Gates

`bun test` plus four `audit:*` scripts, all adapted from `ahliweb/media-lenterakalteng`'s `packages/gerbang`. None of them need a build, a network, or `apps/cms`, so all of them run unconditionally on every push.

`audit:graf` (graphify artefact hygiene) used to sit on the "not ported" list below — this repository had no `graphify-out/` corpus for it to guard. [Issue #11](https://github.com/ahliweb/awcms-one/issues/11) built one: a root-owned, `--code-only` Graphify graph that deliberately excludes `apps/cms/**` (which already has its own graph and its own gate), plus a federated command family (`bun run knowledge:graph:update` / `knowledge:graph:combine` / `knowledge:obsidian:export`) documented in [`knowledge/README.md`](knowledge/README.md). `audit:graf` now checks that corpus for real — see that document for exactly what.

**Still not ported**, and deliberately so: `media-lenterakalteng` also carries `audit:konten` (published-output content checks), `audit:aset` (reader byte budget), and `audit:serapan` (upstream ADR uptake). Every one of them guards a surface — built HTML output, a crawlable running server — that this repository does not have yet. Porting them now would ship a gate that always passes trivially, which reads as more dangerous than no gate at all: a green check that has checked nothing looks exactly like one that checked something and found it clean.

## Documentation

| Document | Contents |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | This repo's working contract — read before doing anything else, human or agent |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup, workflow, branch/commit conventions, Definition of Done |
| [`SECURITY.md`](SECURITY.md) | How to report a vulnerability, and this repo's attack surface today |
| [`GOVERNANCE.md`](GOVERNANCE.md) | Roles, decision flow, releases |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | Expected conduct |
| [`SUPPORT.md`](SUPPORT.md) | Where a question or a bug report goes |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history, folded from changesets |
| [`.changesets/README.md`](.changesets/README.md) | How to write a change note |
| [`knowledge/README.md`](knowledge/README.md) | The federated Graphify + Obsidian knowledge-graph workflow |
| [`docs/README.md`](docs/README.md) | Architecture, schema, API, CMS, routing, SEO, accessibility, responsive, UI/UX, testing, deployment, and workflow reference, plus [`docs/adr/`](docs/adr/README.md) |

## Language

English at the bare path is the authoritative source; Indonesian at `<name>.id.md` is the mirror, and it records the hash of the English it was translated from. `bun run audit:translation` fails when a mirror goes stale. This document's mirror is [`README.id.md`](README.id.md).

This repository's own code (`packages/gerbang/`, `tools/`, `tests/`) is written in English throughout — identifiers, comments, and gate messages alike. `apps/cms` carries its own, separate convention as `ahliweb/awcms`'s embedded code; this repository does not govern or change it.

## Licence

[MIT](LICENSE) for the code in this repo. `apps/cms` carries `ahliweb/awcms`'s own licence and copyright notices as part of its embedded history; see that workspace's own `LICENSE`.
