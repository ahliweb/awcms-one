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

## Approach: foundation first, then one thin vertical slice, then the full store

Scaffold-first (increment 1: catalog listing + product detail, no live database), then **increment 2** (epic [#21](https://github.com/ahliweb/awcms-one/issues/21)): full BjekMart/news-portal parity — a provisioned PostgreSQL for local development and CI, the complete `commerce` module (catalog depth, marketing, orders), and the complete public site (catalog, news, cart, checkout, order tracking, wishlist). Then **increment 3** (epic [#46](https://github.com/ahliweb/awcms-one/issues/46)): functional parity with seputarborneo.com v2.4.0 — real images on every surface, the news chrome and shared sidebar, the newsletter form, the share row, the "Dengarkan berita ini" read-aloud player, the ad popup, complete social metadata, rule-based legacy redirects, first-party visitor analytics with an opt-in GA4 switch, a seputarborneo-shaped seed and a legacy-dump exporter, and the institution emblem. Then **increment 4** (epic [#32](https://github.com/ahliweb/awcms-one/issues/32)): a real customer identity ([ADR-0016](docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md)) — e-mail OTP login/registration, opaque bearer sessions, an account dashboard (addresses, order history, reviews, a synced wishlist), and an affiliate program with `?ref=` capture, checkout attribution, and an owner moderation screen. Then **increment 5** (epic [#33](https://github.com/ahliweb/awcms-one/issues/33)): the admin-only BjekMart features with no public-site counterpart, and the two external integrations awcms routes through the outbox ([ADR-0017](docs/adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md)) — RajaOngkir courier rates, WhatsApp OTP/outbox, a Midtrans Snap payment gateway with token-addressed webhook intake and a reconciliation job, POS (cash sales, `orders.channel`), sales reports (day/product/category projections), a customer inbox, marketing campaigns with consent, and per-tenant feature toggles plus tiered pricing at quote.

## What is here today, and what is not

Every child issue of [issue #21](https://github.com/ahliweb/awcms-one/issues/21), [issue #46](https://github.com/ahliweb/awcms-one/issues/46), [issue #32](https://github.com/ahliweb/awcms-one/issues/32), and [issue #33](https://github.com/ahliweb/awcms-one/issues/33) has landed: the workspace root and its governance, `packages/config`, `packages/gerbang`, `packages/kontrak`, `tools/`, `knowledge/`, `docs/`, the full `apps/storefront` public site — now including a customer-account dashboard, the affiliate surface, courier options and a payment-gateway redirect at checkout, and a customer inbox (`/akun/pesan`) — and `apps/cms` (carrying the one `commerce` module — catalog, marketing, orders, customer accounts/OTP/sessions, affiliates, RajaOngkir courier rates, WhatsApp outbox, Midtrans payment gateway + webhook intake, POS, sales reports, inbox, campaigns, and feature toggles). Where this document or `AGENTS.md` needs to describe a surface that still does not exist, it says so plainly rather than describing a path that is not there — see [`docs/arsitektur.md`](docs/arsitektur.md) and [`docs/cms.md`](docs/cms.md) for that full, current list (e-mail/phone change and phone verification on an existing account — [ADR-0016](docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) D6; a real media upload for product/slider images; a CI pipeline publishing storefront images to a registry and a reverse-proxy config beyond `docs/deployment.md`'s own example — the production topology itself now exists, see [ADR-0019](docs/adr/0019-production-topology-two-images-a-jobs-sidecar-and-a-fail-closed-preflight.md); a Xendit payment-gateway adapter and courier tracking, both named as follow-ups in [ADR-0017](docs/adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md)).

```
apps/
├── cms/                     ahliweb/awcms v10.3.0, embedded via git subtree with full history —
│                             the commerce backend and system of record, carrying the one
│                             commerce module: catalog (images, variants, tiers), marketing
│                             (flash sales, vouchers, sliders, testimonials, popup, store
│                             settings), orders (guest checkout, payment confirmations,
│                             reviews), customer accounts/OTP/bearer sessions, the
│                             affiliate program, RajaOngkir courier rates, a WhatsApp
│                             outbox + OTP channel, a Midtrans Snap payment gateway with
│                             token-addressed webhook intake and a reconciliation job,
│                             POS, sales-report projections, a customer inbox, marketing
│                             campaigns, and per-tenant feature toggles — plus the
│                             anonymous and bearer-secured /api/v1/commerce/storefront/*
│                             API and the public webhook intake route
└── storefront/              the public Astro storefront: full catalog + news parity, cart,
                              checkout (courier options, gateway payment redirect), order
                              tracking, wishlist, and a customer-account dashboard (/masuk,
                              /daftar, /akun*) with a synced wishlist, an affiliate surface,
                              and an inbox (/akun/pesan) — output: "static" throughout,
                              cart/checkout and the account surface call apps/cms's
                              storefront API directly from the browser (ADR-0007, ADR-0016)
packages/
├── config/                  shared tsconfig preset
├── gerbang/                 this workspace's audit gates, as a package
└── kontrak/                 the type-only DTO contract apps/storefront imports from apps/cms,
                              plus its import-direction gate
tools/                       cross-workspace scripts: release, lockfile check, docs i18n stamp,
                              knowledge-graph update/combine/export, seed data
tests/                       the root-level gate tests (docs, changesets, toolchain, scripts,
                              import direction)
docs/                        architecture, schema, API, CMS, routing, SEO, accessibility,
                              responsive, UI/UX, testing, deployment, workflow, and template
                              reference, plus docs/adr/ (nineteen ADRs)
knowledge/                   the federated Graphify + Obsidian knowledge-graph workflow
.claude/skills/               awcms-one-storefront, awcms-one-commerce, awcms-one-template —
                              how-to guides for adding a storefront page, a commerce
                              table/endpoint, or starting a new app from this template
.changesets/, .github/       stay at the repo root — decisions about the whole repo
```

A live, provisioned PostgreSQL now exists for local development and CI (`compose.yaml`, `bun run db:up`/`db:migrate:cms`/`db:seed:cms`, the `check-cms` CI job), and a real production topology exists too (`compose.production.yaml`, a fail-closed `bun run deploy:preflight`, ADR-0019) — see [`docs/deployment.md`](docs/deployment.md) for both sequences and for what remains not built.

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
| `bun run audit:rilis` | The waiting `.changesets/` backlog, bounded at 20 files and 14 days |
| `bun run audit:translation` | Stale or missing Indonesian mirrors of the governance documents |
| `bun run audit:graf` (alias: `knowledge:check`) | The root knowledge-graph corpus describes itself honestly — see [`knowledge/README.md`](knowledge/README.md) |
| `bun run knowledge:graph:update` | Rebuilds the root Graphify graph (`--code-only`, no LLM) — needs `graphify` on `PATH`, not run in CI |
| `bun run knowledge:graph:combine` | Merges the root graph with `apps/cms`'s own into a gitignored, on-demand federated graph — needs `graphify` on `PATH` |
| `bun run knowledge:obsidian:export` | Stages, validates, and syncs a safe Obsidian export of the root graph to `knowledge/generated/graphify/` — needs `graphify` on `PATH` |
| `bun run docs:i18n:stamp` | Writes the language banners and source-hash markers on every `.id.md` mirror |
| `bun run check:cms` | `apps/cms`'s own full gate chain (53 steps — lint, docs, inventories, spec, gates, typecheck, its own tests, its own build) |
| `bun run deploy:preflight` | Fail-closed production preflight — storefront build-env shape, then delegates to `apps/cms`'s own `commerce:deploy:preflight` — see [`docs/deployment.md`](docs/deployment.md) and ADR-0019 |
| `bun run db:up` / `db:down` / `db:reset` | Starts/stops/resets the disposable local `postgres:18.4` (`compose.yaml`, issue #25) |
| `bun run db:migrate:cms` | Runs `apps/cms`'s migrations against `DATABASE_URL` — see `apps/cms/.env.example` |
| `bun run db:seed:cms` | Seeds the `borneojek-mart` tenant, catalog, marketing surfaces, and sample orders through `apps/cms`'s own public API — see [`docs/deployment.md`](docs/deployment.md) |
| `bun run release` | Cuts a tagged release from the waiting changesets — see [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| `dev` / `build` / `check` / `serve` | Delegate into `apps/storefront` — `bun run build` type-checks, fetches the catalog/marketing/news content from `apps/cms` at build time, and bakes static output including the derived CSP; `bun run serve` runs the built `apps/storefront/server/penyaji.mjs`. All three build-time commands honour `SITE_PROFILE` (`toko` default) — see [`docs/deployment.md`](docs/deployment.md) |
| `bun run template:init` | Idempotent brand/profile initialisation for a derived repository — see [`docs/template.md`](docs/template.md) |

### Gates

`bun test` plus four `audit:*` scripts run unconditionally on every push, needing no build, network, or `apps/cms`. Since increment 6 (issue #137), the `Check` job is a **matrix over the three build profiles** — `Check (toko)`, `Check (berita)`, `Check (landing)` — each leg type-checking and profile-smoke-testing `apps/storefront` under its own `SITE_PROFILE`; the root tests and `audit:*` scripts run once, on the `toko` leg. A second CI job, `check-cms`, runs `apps/cms`'s own full gate chain plus its DB-gated integration suite against a real, ephemeral PostgreSQL (issue #25) — see [`docs/alur-kerja-pengembangan.md`](docs/alur-kerja-pengembangan.md). **`Check (toko)`, `Check (berita)`, `Check (landing)`, and `check-cms` are all required status checks on `main`.** A fourth workflow, `.github/workflows/template-init-smoke.yml`, matrices `bun run template:init` over the three profiles into a temporary copy of the repo; it is not yet a required status check (see that document for the promotion plan).

`audit:graf` (graphify artefact hygiene) used to sit on the "not ported" list below — this repository had no `graphify-out/` corpus for it to guard. [Issue #11](https://github.com/ahliweb/awcms-one/issues/11) built one: a root-owned, `--code-only` Graphify graph that deliberately excludes `apps/cms/**` (which already has its own graph and its own gate), plus a federated command family (`bun run knowledge:graph:update` / `knowledge:graph:combine` / `knowledge:obsidian:export`) documented in [`knowledge/README.md`](knowledge/README.md). `audit:graf` now checks that corpus for real — see that document for exactly what.

**Still not ported**, and deliberately so: `media-lenterakalteng` also carries `audit:konten` (published-output content checks), `audit:aset` (reader byte budget), and `audit:serapan` (upstream ADR uptake). Every one of them guards a surface — built HTML output, a crawlable running server — that this repository does not have yet. Porting them now would ship a gate that always passes trivially, which reads as more dangerous than no gate at all: a green check that has checked nothing looks exactly like one that checked something and found it clean.

## Use this as a template

Increment 6 (epic [#135](https://github.com/ahliweb/awcms-one/issues/135)) turned awcms-one into a **template** other applications can start from, while it keeps running as the BjekMart reference deployment. A build-time `SITE_PROFILE` picks which pages a deployment ships, and an idempotent `bun run template:init` rewrites the brand surface (name, domain, colours, contact) for a repository created from GitHub's own **"Use this template"** button.

### Quick start

1. Click **"Use this template"** on `ahliweb/awcms-one` to create a new, historyless repository — not a fork. Clone it, then `bun install`.
2. Run `bun run template:init`, answering the prompts (or passing every flag non-interactively) — see [`docs/template.md`](docs/template.md#templateinit--cli-reference) for the full flag reference, including `--profil`, the colours, and the contact fields.
3. `cp .env.example .env` and `cp apps/cms/.env.example apps/cms/.env`, filling in what `template:init` did not already set (database credentials, any provider keys — see [ADR-0017](docs/adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md)).
4. `bun run db:up` — a local PostgreSQL via `docker compose`.
5. `bun run db:migrate:cms` — runs `apps/cms`'s own migration chain.
6. `bun run db:seed:cms:profil <toko|berita|landing>` — the neutral sample content matching your chosen profile.
7. `bun run dev` — starts `apps/cms` and `apps/storefront`, the storefront built against the `SITE_PROFILE` from step 2.
8. Deploy per [`docs/deployment.md`](docs/deployment.md) — nothing about being a derived repo changes that mechanism.

### Build profiles

| Profile | Composition | What it is |
| --- | --- | --- |
| `toko` (default) | shared + toko + berita | Today's BjekMart shape — commerce and news together |
| `berita` | shared + berita | A news portal only, no commerce |
| `landing` | shared only | A company profile / landing site — pages, contact, SEO chrome; no commerce, no news |

See [ADR-0018](docs/adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md) for the decisions behind the template mechanism and [`docs/template.md`](docs/template.md) for the full walkthrough, the `template:init` CLI reference, the profile matrix, and the per-profile seed sets.

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
| [`docs/README.md`](docs/README.md) | Architecture, schema, API, CMS, routing, SEO, accessibility, responsive, UI/UX, testing, deployment, workflow, and template reference, plus [`docs/adr/`](docs/adr/README.md) |

## Language

English at the bare path is the authoritative source; Indonesian at `<name>.id.md` is the mirror, and it records the hash of the English it was translated from. `bun run audit:translation` fails when a mirror goes stale. This document's mirror is [`README.id.md`](README.id.md).

This repository's own code (`packages/gerbang/`, `tools/`, `tests/`) is written in English throughout — identifiers, comments, and gate messages alike. `apps/cms` carries its own, separate convention as `ahliweb/awcms`'s embedded code; this repository does not govern or change it.

## Licence

[MIT](LICENSE) for the code in this repo. `apps/cms` carries `ahliweb/awcms`'s own licence and copyright notices as part of its embedded history; see that workspace's own `LICENSE`.
