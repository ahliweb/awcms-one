🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](README.id.md)

[![CI](https://github.com/ahliweb/awcms-one/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ahliweb/awcms-one/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE) [![runtime](https://img.shields.io/badge/runtime-Bun-blue?logo=bun&logoColor=white)](https://bun.sh)

# awcms-one

**awcms-one** is a Bun/Astro/PostgreSQL commerce-and-news platform, and a [GitHub template](#use-this-as-a-template) other applications start from. Its own live deployment re-platforms the borneojek-mart commerce store — PHP/Laravel/MySQL/React-Inertia — onto Bun, Astro, and PostgreSQL under row-level security, a genuine re-platform rather than a refactor (no Laravel code carried over; the source schema is read from the live `commerce_bj_mart` MySQL database and re-expressed as AWCMS module tables — see [issue #1](https://github.com/ahliweb/awcms-one/issues/1)).

## Screenshots

An above-the-fold crop of the home page, one per build profile — the same three `SITE_PROFILE` shapes [`docs/template.md`](docs/template.md) documents in full.

| `toko` — commerce + news | `berita` — news portal only | `landing` — company profile |
| --- | --- | --- |
| [![The toko profile's home page: a dark storefront header with search, wishlist, and cart, above a promotional catalog slider](docs/assets/readme-toko.webp)](docs/assets/readme-toko.webp) | [![The berita profile's home page: a news masthead with a "Terkini" ticker, an ad slot, and a headline/sidebar layout](docs/assets/readme-berita.webp)](docs/assets/readme-berita.webp) | [![The landing profile's home page: a plain header above a hero heading, call-to-action buttons, a pages grid, and contact cards](docs/assets/readme-landing.webp)](docs/assets/readme-landing.webp) |

Every image is served from `docs/assets/`, converted to WebP at quality 80; the three together weigh about 72 KB, well inside this document's own 600 KB budget for added image weight, and are rendered against this repo's own stub CMS fixture rather than a seeded one, so their content and branding are placeholder — a real deployment's own content and brand come from its CMS. Regenerated with `apps/storefront`'s own e2e harness (issue #183) — see [`docs/pengujian.md`](docs/pengujian.md#playwright-e2e-a-fourth-tier-its-own-command-its-own-ci-workflow-issue-183) for the exact `bun run screenshots:readme` invocations and the conversion command.

## Where this sits in the AWCMS family

| | |
| --- | --- |
| **This repo** | `ahliweb/awcms-one` — a Bun monorepo: one commerce/news backend (`apps/cms`), one public storefront (`apps/storefront`), one shared DTO contract (`packages/kontrak`) |
| **Backend / system of record** | `apps/cms`, in this repo — `ahliweb/awcms` embedded whole via `git subtree`, preserving upstream history |
| **Model repo** | [`ahliweb/media-lenterakalteng`](https://github.com/ahliweb/media-lenterakalteng) — the workspace layout, audit gates, changeset convention, and governance-document structure in this repo are adapted from it |

## Why `apps/cms` embeds `awcms` whole

The commerce module this platform needs cannot stand on its own — it depends on `awcms` shared infrastructure that has no standalone package: `withTenant` (RLS tenant context), `authorizeInTransaction` (RBAC/ABAC), `appendDomainEvent` (outbox), `recordAuditEvent`, `_shared/module-contract` (`defineModule`), `getDatabaseClient`, the SQL migration runner, and `_shared/api-response`. So `awcms` is embedded whole, via `git subtree`, rather than depended on as a package — see [`AGENTS.md`](AGENTS.md#the-subtree-embed) for the sync mechanics and the one rule that protects them.

## Use this as a template

`awcms-one` runs as the BjekMart reference deployment **and** as a template other applications start from: a build-time `SITE_PROFILE` picks which pages a deployment ships, and an idempotent `bun run template:init` rewrites the brand surface (name, domain, colours, contact) for a repository created from GitHub's own **"Use this template"** button.

1. Click **"Use this template"** on `ahliweb/awcms-one` to create a new, historyless repository — not a fork. Clone it, then `bun install`.
2. Run `bun run template:init`, answering the prompts (or passing every flag non-interactively) — see [`docs/template.md`](docs/template.md#templateinit--cli-reference) for the full flag reference, including `--profil`, the colours, and the contact fields.
3. `cp .env.example .env` and `cp apps/cms/.env.example apps/cms/.env`, filling in what `template:init` did not already set (database credentials, any provider keys — see [ADR-0017](docs/adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md)).
4. `bun run db:up` — a local PostgreSQL via `docker compose`.
5. `bun run db:migrate:cms` — runs `apps/cms`'s own migration chain.
6. `bun run db:seed:cms:profil <toko|berita|landing>` — the neutral sample content matching your chosen profile.
7. `bun run dev` — starts `apps/cms` and `apps/storefront`, the storefront built against the `SITE_PROFILE` from step 2.
8. Deploy per [`docs/deployment.md`](docs/deployment.md) — nothing about being a derived repo changes that mechanism.

| Profile | Composition | What it is |
| --- | --- | --- |
| `toko` (default) | shared + toko + berita | Today's BjekMart shape — commerce and news together |
| `berita` | shared + berita | A news portal only, no commerce |
| `landing` | shared only | A company profile / landing site — pages, contact, SEO chrome; no commerce, no news |

See [ADR-0018](docs/adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md) for the decisions behind the template mechanism and [`docs/template.md`](docs/template.md) for the full walkthrough, the `template:init` CLI reference, the profile matrix, and the per-profile seed sets.

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/status.md`](docs/status.md) | The current-state reference: what exists by surface, what does not yet — start here for "what is actually here today" |
| [`AGENTS.md`](AGENTS.md) | This repo's working contract — read before doing anything else, human or agent |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup, workflow, branch/commit conventions, Definition of Done |
| [`SECURITY.md`](SECURITY.md) | How to report a vulnerability, and this repo's attack surface today |
| [`GOVERNANCE.md`](GOVERNANCE.md) | Roles, decision flow, releases |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | Expected conduct |
| [`SUPPORT.md`](SUPPORT.md) | Where a question or a bug report goes |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history, folded from changesets — the increment-by-increment history this README no longer carries |
| [`.changesets/README.md`](.changesets/README.md) | How to write a change note |
| [`knowledge/README.md`](knowledge/README.md) | The federated Graphify + Obsidian knowledge-graph workflow |
| [`docs/README.md`](docs/README.md) | Architecture, schema, API, CMS, routing, SEO, accessibility, responsive, UI/UX, testing, deployment, workflow, and template reference, plus [`docs/adr/`](docs/adr/README.md) |

## Running locally

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
| `bun run check:cms` | `apps/cms`'s own full gate chain (53 steps — lint, docs, inventories, spec, gates, typecheck, its own tests, its own build) |
| `bun run db:up` / `db:down` / `db:reset` | Starts/stops/resets the disposable local `postgres:18.4` (`compose.yaml`) |
| `bun run db:migrate:cms` | Runs `apps/cms`'s migrations against `DATABASE_URL` — see `apps/cms/.env.example` |
| `bun run db:seed:cms` | Seeds the `borneojek-mart` tenant, catalog, marketing surfaces, and sample orders through `apps/cms`'s own public API — see [`docs/deployment.md`](docs/deployment.md) |
| `bun run deploy:preflight` | Fail-closed production preflight — storefront build-env shape, then delegates to `apps/cms`'s own `commerce:deploy:preflight` — see [`docs/deployment.md`](docs/deployment.md) and ADR-0019 |
| `bun run release` | Cuts a tagged release from the waiting changesets — see [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| `dev` / `build` / `check` / `serve` | Delegate into `apps/storefront` — `bun run build` type-checks, fetches the catalog/marketing/news content from `apps/cms` at build time, and bakes static output including the derived CSP; `bun run serve` runs the built `apps/storefront/server/penyaji.mjs`. All three build-time commands honour `SITE_PROFILE` (`toko` default) — see [`docs/deployment.md`](docs/deployment.md) |
| `bun run template:init` | Idempotent brand/profile initialisation for a derived repository — see [`docs/template.md`](docs/template.md) |

## Architecture at a glance

```
apps/
├── cms/                     ahliweb/awcms, embedded via git subtree with full history — the
│                             commerce/news backend and system of record, carrying the one
│                             commerce module (catalog, marketing, orders, customer accounts,
│                             affiliates, external-provider integrations — see docs/status.md)
│                             plus the anonymous and bearer-secured /api/v1/commerce/storefront/*
│                             API and the public webhook intake route
└── storefront/              the public Astro storefront — output: "static" throughout, built
                              per SITE_PROFILE; cart/checkout and the account surface call
                              apps/cms's storefront API directly from the browser (ADR-0007,
                              ADR-0016)
packages/
├── config/                  shared tsconfig preset
├── gerbang/                 this workspace's audit gates, as a package
└── kontrak/                 the type-only DTO contract apps/storefront imports from apps/cms,
                              plus its import-direction gate
tools/                       cross-workspace scripts: release, lockfile check, docs i18n stamp,
                              knowledge-graph update/combine/export, seed data, template:init
tests/                       the root-level gate tests (docs, changesets, toolchain, scripts,
                              import direction)
docs/                        architecture, schema, API, CMS, routing, SEO, accessibility,
                              responsive, UI/UX, testing, deployment, workflow, and template
                              reference, plus docs/adr/ and docs/status.md
knowledge/                   the federated Graphify + Obsidian knowledge-graph workflow
.claude/skills/               awcms-one-storefront, awcms-one-commerce, awcms-one-template —
                              how-to guides for adding a storefront page, a commerce
                              table/endpoint, or starting a new app from this template
.changesets/, .github/       stay at the repo root — decisions about the whole repo
```

A live, provisioned PostgreSQL exists for local development and CI (`compose.yaml`, `bun run db:up`/`db:migrate:cms`/`db:seed:cms`, the `check-cms` CI job), and a real production topology exists too (`compose.production.yaml`, a fail-closed `bun run deploy:preflight`, ADR-0019) — see [`docs/deployment.md`](docs/deployment.md) for both sequences, [`docs/arsitektur.md`](docs/arsitektur.md) for the full topology and trust-tier design, and [`docs/status.md`](docs/status.md) for what exists today, by surface, and what does not yet.

## Gates

**GitHub Actions workflows are not an accepted implementation path in this repository (ADR-0021, issue #225).** CI, security scanning, template smoke, and end-to-end tests all run as `local-ci/*` legs (`tools/ci/`) instead — on a contributor's own machine, or on AhliWeb's own trusted CI server — reported as commit statuses by `bun run ci:pr -- <pr-number>`/`bun run ci:watch`. `bun test` plus four `audit:*` scripts run unconditionally as part of the `local-ci/check-toko` leg, needing no build, network, or `apps/cms`. The check legs are a **matrix over the three build profiles** — `local-ci/check-toko`, `local-ci/check-berita`, `local-ci/check-landing` — each leg type-checking and profile-smoke-testing `apps/storefront` under its own `SITE_PROFILE`; the root tests and `audit:*` scripts run once, on the `toko` leg. `local-ci/check-cms` runs `apps/cms`'s own full gate chain plus its DB-gated integration suite against a real, ephemeral PostgreSQL — see [`docs/alur-kerja-pengembangan.md`](docs/alur-kerja-pengembangan.md). Four `local-ci/template-*` legs matrix `bun run template:init` over the three profiles into a disposable copy of the repo, plus a `root` leg that runs the full derived-repository test suite once. Three `local-ci/e2e-*` legs run a Playwright matrix over the same three profiles (checkout, the ad popup, axe-core accessibility, a responsive/overflow check). **All twelve `local-ci/*` contexts are required status checks on `main`.**

| Gate | What it catches |
| --- | --- |
| `bun run audit:dokumen` | Dead relative links in markdown; an ADR index incomplete in either direction or carrying a duplicate row; a file path named in backticks that does not exist in this repo; an `ADR-NNNN` citation that resolves to nothing; a spelled-out number that disagrees with the set it claims to count |
| `bun run audit:rilis` | The waiting `.changesets/` backlog crossing its bound — 20 files or 14 days old |
| `bun run audit:translation` | An Indonesian mirror (`<name>.id.md`) whose recorded source hash no longer matches its English source, or a governance document with no mirror at all |
| `bun run audit:graf` (alias: `knowledge:check`) | The root knowledge-graph corpus (`graphify-out/`) describing itself honestly, including that the corpus has not drifted more than `MAX_STALE_FILES` (40) files from the tree it describes — see [`knowledge/README.md`](knowledge/README.md) |
| `bun test` | The root gate test suite — `tests/*.test.mjs` — plus `apps/storefront`'s own unit/build-smoke/route tests |
| `local-ci/check-cms` | `apps/cms`'s own ~53-step `bun run check` chain, then its `tests/integration/` suite against a real, migrated PostgreSQL |

`local-ci/security` (the CodeQL CLI's `security-extended` analysis, gitleaks, and `bun audit`) also runs as part of `bun run ci`/`ci:pr` — see `docs/alur-kerja-pengembangan.md`'s "Local CI: the twelve legs" for why the CLI is run directly rather than through `codeql-action`. Image build/publish and release publication are no longer CI-triggered at all: `bun run release:images -- --publish` (`apps/cms`'s `runtime`/`jobs` images to GHCR with SBOM and provenance) and `bun run release:publish` (a GitHub Release from a tagged version's `CHANGELOG.md` section) are both run by hand from a trusted release host — see [`docs/rilis.md`](docs/rilis.md). See [`docs/README.md`](docs/README.md) for the full documentation index.

## Language

English at the bare path is the authoritative source; Indonesian at `<name>.id.md` is the mirror, and it records the hash of the English it was translated from. `bun run audit:translation` fails when a mirror goes stale. This document's mirror is [`README.id.md`](README.id.md).

This repository's own code (`packages/gerbang/`, `tools/`, `tests/`) is written in English throughout — identifiers, comments, and gate messages alike. `apps/cms` carries its own, separate convention as `ahliweb/awcms`'s embedded code; this repository does not govern or change it.

## Licence

[MIT](LICENSE) for the code in this repo. `apps/cms` carries `ahliweb/awcms`'s own licence and copyright notices as part of its embedded history; see that workspace's own `LICENSE`.
