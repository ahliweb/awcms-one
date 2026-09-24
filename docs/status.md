🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](status.id.md)

# Status

The single, current-state reference for `awcms-one` — what exists, by surface, and what does not, each item linking to the document or ADR that has the detail. No increment chronicle: history lives in [`CHANGELOG.md`](../CHANGELOG.md) and the [ADR index](adr/README.md); this page only states what is true of the tree today. Where this page and another document disagree, the other document's own detail wins and this page is stale — file an issue.

## The platform

`awcms-one` re-platforms the borneojek-mart commerce store — PHP/Laravel/MySQL/React-Inertia — onto Bun, Astro, and PostgreSQL under row-level security: a re-platform, not a refactor, with the source schema read from the live `commerce_bj_mart` MySQL database and re-expressed as AWCMS module tables (framing: [issue #1](https://github.com/ahliweb/awcms-one/issues/1)). It is also a GitHub template repository other applications start from — see "Template and build profiles" below.

## Workspace

A Bun workspace: `apps/cms` (backend/system of record, `ahliweb/awcms` embedded whole via `git subtree` — see [`AGENTS.md`](../AGENTS.md#the-subtree-embed)), `apps/storefront` (the public site, static output), `packages/kontrak` (the type-only DTO contract between them), `packages/gerbang`/`packages/config` (root tooling), `tools/` (seeding, release, template-init), `knowledge/` (the federated Graphify graph). [`README.md`](../README.md) has the full directory map.

## `apps/cms` — the `commerce` module (ADR-0008)

One module, not three, carries the whole store: catalog (images, variants, tiered pricing, size charts, service forms), marketing (flash sales, vouchers, sliders, testimonials, a popup, versioned store settings, promo banners), and orders (guest checkout by order code + phone — [ADR-0009](adr/0009-guest-checkout-by-order-code-and-phone.md) — payment confirmations, reviews). The anonymous, Origin-bound `/api/v1/commerce/storefront/*` family a static browser calls directly is [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md). Field-by-field detail: [`docs/cms.md`](cms.md), [`docs/api.md`](api.md), [`docs/skema-basis-data.md`](skema-basis-data.md), [`docs/kamus-data.md`](kamus-data.md).

## Customer accounts and affiliates (ADR-0016)

A third, OTP-verified trust tier on top of the guest-checkout customer: e-mail (and WhatsApp, see integrations below) OTP login/registration, opaque `cs_`-prefixed bearer sessions (`sha256:`-hashed at rest, `Authorization: Bearer`, kept in the browser's own `localStorage` — never a cookie, see [`AGENTS.md`](../AGENTS.md)'s bearer-session rule), an account dashboard (addresses, order history, reviews, a synced wishlist, a customer inbox), and an affiliate program (`?ref=` capture, checkout attribution, `/akun/afiliasi`, an owner moderation screen). **Not here yet:** e-mail/phone change on an existing account, and phone verification — [ADR-0016](adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) D6's two deferred items.

## External integrations (ADR-0017)

Every one of these is a `commerce`-owned provider port + adapter(s) + outbox, modelled on `email` — never a synchronous call on the order path ([ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md), [ADR-0017](adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) D1): RajaOngkir courier-rate caching, a WhatsApp outbox (Fonnte + Meta Cloud API adapters) including WhatsApp OTP, a Midtrans Snap payment gateway with token-addressed public webhook intake and a `commerce:payments:reconcile` job, POS (`orders.channel`, cash sales), sales-report projections, a customer inbox, and marketing campaigns gated on `marketing_consent_at`. Tiered pricing (`price_level_1..4`) applies at quote time. **Not here yet:** a Xendit payment-gateway adapter and courier tracking, both named as explicit follow-ups behind the same ports.

## `apps/storefront` — build profiles (ADR-0018)

`SITE_PROFILE` ∈ `{toko, berita, landing}`, read at build time by `apps/storefront/src/config/profil.ts`:

- **`toko`** (default) — the full hybrid: commerce (catalog, cart, checkout, order tracking, wishlist, account/affiliate pages) plus the news IA below.
- **`berita`** — the news portal only, mirroring seputarborneo.com/beritasampit.co.id's own IA and chrome: 8-item nav, a "Daerah" panel, a "Terkini" ticker, a Mitra institution directory, a footer leaderboard, newsletter double opt-in, a share row, a read-aloud player, an ad popup, rule-based legacy redirects ([ADR-0013](adr/0013-rule-based-legacy-redirects-beside-the-row-based-map.md)), and first-party visitor analytics with an opt-in GA4 switch ([ADR-0012](adr/0012-first-party-visitor-analytics-with-an-opt-in-ga4-switch.md)).
- **`landing`** — a company profile/landing site: pages, contact, SEO chrome; no commerce, no news.

Media (product photography, article heroes, ad creatives) resolves through `GET /api/v1/media/objects`, and the CSP is derived at build time from what actually resolved ([ADR-0011](adr/0011-storefront-media-resolves-through-the-media-objects-endpoint.md)). See [`docs/template.md`](template.md) for the full profile mechanism and matrix, [`docs/routing.md`](routing.md) for every route, and [`docs/ui-ux.md`](ui-ux.md) for the design system (tokens, product imagery, computed badge contrast, price/stock presentation) — including the 2026-09 redesign covering admin and public chrome (issues #166–#171).

## Template mechanism

`bun run template:init` (`tools/template-init.ts`) is an idempotent CLI a derived repository runs once to rewrite its brand surface — name, domain, colours, contact, chosen profile — never touching `apps/cms/**`. `.github/workflows/template-init-smoke.yml` matrices it over the three profiles on every push; all four of its legs (`toko`, `berita`, `landing`, `root-suite`) are required status checks. Per-profile seeds live at `tools/seed-data/profil/{toko,berita,landing}/**`; the BjekMart reference content itself (kept as the template's worked example) is `tools/seed-data/contoh/borneojek-mart/**`. Full walkthrough: [`docs/template.md`](template.md) and [ADR-0018](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md).

## Ops and deployment

`compose.production.yaml` gives the production topology: two `apps/cms` images (`runtime` for the `cms` service, `jobs` for the `jobs`/`migrate` services) built from the unmodified upstream `apps/cms/Dockerfile.production`, a jobs sidecar, a two-role database model, and a fail-closed `commerce:deploy:preflight`/`deploy:preflight` ([ADR-0019](adr/0019-production-topology-two-images-a-jobs-sidecar-and-a-fail-closed-preflight.md)). Those two `apps/cms` images are published to GHCR — SBOM and provenance attestation on every push, verifiable with `gh attestation verify` — on a version tag or an explicit dispatch, by `.github/workflows/images.yml`; `apps/storefront`'s own image is deliberately never published this way, because its build bakes a tenant's live catalog/news content using the CMS owner token as a BuildKit secret ([ADR-0020](adr/0020-publish-only-the-cms-images-to-ghcr-with-sbom-and-provenance.md) D2) — it stays a manual `docker build` on the deploy host, per `SITE_PROFILE`, per content change. That workflow's own `storefront-smoke` job still proves `apps/storefront/Dockerfile` builds against this repo's own stub CMS on every relevant push and PR. **Not here yet:** a reverse-proxy/TLS-termination configuration beyond [`docs/deployment.md`](deployment.md)'s own example, at-rest backup encryption, and a production PostgreSQL this repository itself operates (`compose.production.yaml`'s own `postgres` service is a self-hosted convenience, not a managed offering). Full runbook: [`docs/deployment.md`](deployment.md).

## Releases

`bun run release` folds the waiting `.changesets/` backlog into `CHANGELOG.md`, bumps `package.json`, and (with `--commit`) tags `vX.Y.Z`. Pushing that tag publishes a matching GitHub Release from the tag's `CHANGELOG.md` section (`.github/workflows/release.yml`), idempotently — a `workflow_dispatch` run can back-fill or re-publish an older tag's notes. See [`docs/alur-kerja-pengembangan.md`](alur-kerja-pengembangan.md)'s "Releases" section.

## The gates and repository hardening

`AGENTS.md`'s ["The gates"](../AGENTS.md#the-gates) is the authoritative list of what runs on every push and which are required status checks. Beyond that: `.github/workflows/codeql.yml` runs GitHub's CodeQL `security-extended` analysis over this workspace's own JavaScript/TypeScript (and `apps/cms`'s source, though not its `.astro` files — CodeQL ships no Astro extractor) on every push, PR, and a weekly schedule — not yet a required status check. `.github/workflows/e2e.yml` runs `apps/storefront`'s Playwright e2e suite — checkout, the ad popup, axe-core accessibility (`wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa`, fails on `serious`/`critical`), a deterministic responsive/overflow check, and per-profile full-page screenshots uploaded as CI artifacts — matrixed over the three build profiles; its three legs (`e2e (toko)`, `e2e (berita)`, `e2e (landing)`) became required status checks in issue #215, after a verified post-introduction run history with no observed e2e failure. `.github/CODEOWNERS`, a PR template, and issue forms (bug report, feature request, upstream-sync) route review and intake but are not merge gates — this repo has a single maintainer, so no code-owner review is required to merge. `.github/dependabot.yml` opens monthly, grouped version-bump PRs for GitHub Actions only; there is deliberately no `bun` ecosystem block (Dependabot's `bun` updater does not yet parse this repo's `bun.lock` `lockfileVersion` 2), so this repo's own workspace dependencies are bumped by hand — see `AGENTS.md`'s "Configuration and toolchain". `audit:graf` additionally bounds how far the committed knowledge graph may drift from the tree it describes (`MAX_STALE_FILES`), content-hash based since a CI checkout is not guaranteed to be full.

## Not here yet — the short list

- E-mail/phone change on an existing customer account, and phone verification ([ADR-0016](adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) D6).
- A real, uploaded media library for product/slider/testimonial images — `media_library`'s R2-backed session exists, but nothing in this repo populates it yet (see [`docs/deployment.md`](deployment.md), [`docs/cms.md`](cms.md)).
- A Xendit payment-gateway adapter and courier tracking, both named as explicit follow-ups behind the ports [ADR-0017](adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) already built.
- A CI pipeline that publishes `apps/storefront`'s per-profile images to a registry — [ADR-0020](adr/0020-publish-only-the-cms-images-to-ghcr-with-sbom-and-provenance.md) D2 rejects this outright, not merely postpones it.
- A reverse-proxy/TLS-termination configuration beyond [`docs/deployment.md`](deployment.md)'s own example, at-rest backup encryption, and a production PostgreSQL this repository itself operates.
- CodeQL as a required status check — it runs on every push today but has not yet accumulated the green track record `.github/workflows/template-init-smoke.yml`'s own comment describes as the promotion path (the Playwright e2e/accessibility/responsive workflow went through that same promotion in issue #215).
- A committed visual-regression baseline for the Playwright screenshots above — a deliberate decision (a reviewer opens the CI artifact and looks, rather than a byte-diff gating the run), not a gap.

See [`docs/arsitektur.md`](arsitektur.md), [`docs/cms.md`](cms.md), and [`docs/skema-basis-data.md`](skema-basis-data.md) for what each area's own document defers in more detail.
