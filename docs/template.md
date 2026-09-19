🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](template.id.md)

# Using awcms-one as a template

This document is the skeleton [ADR-0018](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md) commits this repository to filling in: how a new application starts from `awcms-one`, what `bun run template:init` does to make a derived repository its own, the build-profile matrix that decides which pages a deployment ships, and where BjekMart itself fits once this repository is also a template. **As of issue #138, `bun run template:init` is real, running code** (`tools/template-init.ts` + `tools/template-init/**`, tested by `tests/template-init.test.mjs`, matrixed in CI by `.github/workflows/template-init-smoke.yml`). The `src/profil/**` layout and `SITE_PROFILE`'s actual page-filtering behaviour (#137) and the per-profile seed data (#139) have **not** landed yet — see "Status" at the bottom for what that means for `template:init` today.

## Memulai dari template (starting from the template)

1. **Use this template.** Once [#140](https://github.com/ahliweb/awcms-one/issues/140) sets the GitHub *template repository* flag, click "Use this template" on `ahliweb/awcms-one` to create a new, historyless repository — not a fork. Clone it.
2. **`bun install`**, then **`bun run template:init`** (see the CLI reference below) — an idempotent, one-time rewrite of this repository's brand surface (name, domain, colours, contact, chosen profile) into your own. Answer the prompts, or pass every flag non-interactively (useful in a script or CI).
3. **`.env`** — `cp .env.example .env` at root, and `cp apps/cms/.env.example apps/cms/.env` for the backend; fill in what `template:init` did not already set for you (database credentials, any provider keys you intend to use — see [ADR-0017](adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) for what each provider needs).
4. **`bun run db:up`** — a local PostgreSQL via `docker compose`.
5. **`bun run db:migrate:cms`** — runs `apps/cms`'s own migration chain against that database.
6. **`bun run db:seed:cms --profil <toko|berita|landing>`** — seeds the neutral sample content matching your chosen profile (D6, #139), or `--profil contoh:borneojek-mart` if you want to see BjekMart's own full reference content instead.
7. **`bun run dev`** — starts `apps/cms` and `apps/storefront` for local development, storefront built against `SITE_PROFILE` from step 2.
8. **Deploy** per [`docs/deployment.md`](deployment.md) — build, then serve, exactly as this repository's own reference deployment does; nothing about being "a derived repo" changes that mechanism.

## `template:init` — CLI reference

```
bun run template:init \
  --nama "Toko Contoh" \
  --slug toko-contoh \
  --domain toko-contoh.id \
  --profil toko|berita|landing \
  --warna-primer "#0ea5e9" \
  [--warna-sekunder "#0369a1"] \
  [--warna-aksen "#f59e0b"] \
  --kontak-email owner@toko-contoh.id \
  [--kontak-telepon "+62 812-0000-0000"] \
  [--alamat "Jl. Contoh No. 1, Kota Contoh"] \
  [--dry-run] \
  [--yes]
```

| Flag | Required | Meaning |
| --- | --- | --- |
| `--nama` | Yes | The deployment's display name — becomes `DEFAULT_IDENTITY.name`, root `package.json`'s `description`, and the `README*.md`/`SUPPORT*.md`/`SECURITY*.md` hero |
| `--slug` | Yes | A kebab-case identifier — becomes root `package.json`'s `name`, `compose.yaml`'s project name, and the default seed tenant code |
| `--domain` | Yes | The canonical production domain — becomes `SITE_URL`'s default in `.env.example` and `package.json`'s `homepage` |
| `--profil` | Yes | `toko`, `berita`, or `landing` — becomes `.env.example`'s `SITE_PROFILE` default and selects which neutral seed set `db:seed:cms` targets by default |
| `--warna-primer` | Yes | A hex colour — becomes `DEFAULT_THEME_COLORS.primary` |
| `--warna-sekunder` | No | Defaults to a darker shade of `--warna-primer` when omitted — `DEFAULT_THEME_COLORS.secondary` |
| `--warna-aksen` | No | Defaults to a contrasting accent when omitted — `DEFAULT_THEME_COLORS.accent` |
| `--kontak-email` | Yes | Becomes `DEFAULT_IDENTITY.contactEmail` and `SUPPORT*.md`/`SECURITY*.md`'s contact line |
| `--kontak-telepon` | No | Becomes `DEFAULT_IDENTITY.contactPhone` when given; omitted leaves no phone line rather than inventing one |
| `--alamat` | No | Becomes `DEFAULT_IDENTITY.address` when given |
| `--dry-run` | No | Prints the full rewrite/removal plan and touches nothing |
| `--yes` | No | Required to proceed on a dirty working tree; otherwise the tool refuses to run rather than mixing its own rewrite into uncommitted changes |

**Interactive vs. non-interactive:** a missing required flag prompts for it when stdin is a TTY; otherwise the tool exits **`2`**, naming every missing flag on one line, so a CI job or script gets a clear, machine-readable failure instead of hanging on a prompt nobody can answer.

**Idempotency:** running `template:init` a second time with the exact same flags is a no-op — exit **`0`**, printing "nothing to do." Running it again with one or more different flags rewrites again, touching only what actually changed. This is what makes it safe for [#138](https://github.com/ahliweb/awcms-one/issues/138)'s own `template-init-smoke` CI job to run unattended, and safe for a human to re-run after fixing a typo in an earlier flag.

**Exit codes:** `0` success (including "nothing to do"); `1` an internal failure (a file the tool expected to rewrite is missing, a gate it runs at the end fails); `2` missing required flags in non-interactive mode; `3` refused on a dirty working tree without `--yes`.

### What it rewrites

Exactly the brand surface [ADR-0018 D4](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md#d4--brand-lives-in-env--sitets-plus-a-short-named-list-of-files-templateinit-rewrites) names:

- `apps/storefront/src/config/site.ts` — `DEFAULT_IDENTITY` (`name`, `description`, `contactEmail`, and `contactPhone`/`address` when given), `DEFAULT_THEME_COLORS`, and the `SITE_NAME`/`SITE_DESCRIPTION` `readEnvOr` fallbacks. **A third correction to this section's wave-0 wording**: `DEFAULT_IDENTITY.description` was not in the original list (only `name`/`contactEmail`/`contactPhone`/`address` were named) — added here because leaving it untouched ships BjekMart's own catchphrase ("...di BjekMart") into every derived deployment forever, exactly the defect D4's own "Rejected (c)" paragraph describes.
- Root `package.json` — `name`, `description`, `homepage`, `repository.url`, and (once only, on the first run) a new `awcmsOne.templateVersion` field recording the awcms-one version this derived repo was created from
- `compose.yaml` — the Docker Compose project name, container name, and named volume
- `README.md`/`README.id.md` — the hero section
- `SUPPORT.md`/`SUPPORT.id.md` — the hero sentence
- `.env.example` — the seed-script tenant defaults (`SEED_TENANT_CODE`/`SEED_TENANT_NAME`/`SEED_OFFICE_CODE`/`SEED_OFFICE_NAME`/`SEED_OWNER_EMAIL`)
- `apps/storefront/.env.example` — `SITE_URL`, `SITE_NAME`, `SITE_DESCRIPTION`, and a new `SITE_PROFILE` line
- `CHANGELOG.md` — reset to a single `## [0.1.0]` entry reading "Dibuat dari template awcms-one vX.Y.Z (\<sha\>)" (once only)
- `.changesets/*.md` — cleared (the README is kept; once only)

**Two corrections to this section's original wording, made in the same change that implements the tool (issue #138), since the doc and the tree disagreed:**

- `SECURITY.md`/`SECURITY.id.md` carry **no** BjekMart-specific contact line as the tree actually stands — every address in those files is a GitHub URL to `ahliweb/awcms-one`, which `template:init` deliberately does **not** rewrite (see "What it does not know" below). `rewriteSecurity()` (`tools/template-init/rewriters.mjs`) is a documented no-op kept for symmetry with `SUPPORT.md`.
- `SITE_NAME`/`SITE_URL`/`SITE_DESCRIPTION` (and the new `SITE_PROFILE`) live in `apps/storefront/.env.example`, not the root `.env.example` — the root file documents only root-owned-script variables (see that file's own header), and `SITE_PROFILE` itself does not exist anywhere in the tree yet: issue #137, the mechanism that reads it, has not landed on the branch issue #138 was built from. `template:init` writes the line into `apps/storefront/.env.example` anyway, forward-compatible with #137 reading it once it lands, rather than waiting.

### What "no BjekMart string left" actually means

`template:init`'s own test (`tests/template-init.test.mjs`) scans for BjekMart-specific strings only inside D4's own named brand surface (`package.json`, `compose.yaml`, `.env.example`, `apps/storefront/.env.example`, `apps/storefront/src/config/site.ts`, `README*.md`, `SUPPORT*.md`) plus confirming the removal targets are gone — **not** the whole tree. `docs/*`, `apps/storefront/**` (its tests and fixtures included), and this repository's own `AGENTS.md`/`CHANGELOG.md` history legitimately describe BjekMart as this repository's own, real, five-increment reference deployment (ADR-0018 D6) and are out of `template:init`'s scope by the same D4 paragraph that rejects "hunt the whole tree with no closed list to check against" as an option. A derived repo therefore still reads BjekMart's own name throughout its inherited documentation and test fixtures until it edits those itself — `template:init` only guarantees its own OWN named surface is clean.

### What it does not know

`template:init` has no `--org`/`--repo` flag, so it cannot know a derived repository's own GitHub owner/name. `package.json`'s `repository.url` is rewritten to `git+https://github.com/GANTI-ORG/<slug>.git` — a loud, greppable placeholder, not a guess — and every GitHub URL inside `README*.md`/`SUPPORT*.md`/`SECURITY*.md` that still points at `ahliweb/awcms-one` (issue links, the Security Advisory link, ADR links) is left exactly as it is: those are functional links, not brand text, and a repository just created from the template has not necessarily even been renamed or moved yet. Completing `GANTI-ORG` and any GitHub links a derived repo's owner wants pointed at their own fork remains a manual step after `template:init` runs.

### What it removes

BjekMart-only artefacts that a derived deployment does not need and should not carry as dead weight or misleading example content:

- `tools/seed-borneojek-mart.ts` plus every BjekMart-specific file under `tools/seed-data/*.json` and all of `tools/seed-assets/` (today's layout) — **or**, once [#139](https://github.com/ahliweb/awcms-one/issues/139) lands, `tools/seed-data/contoh/borneojek-mart/**` (its target layout). `template:init` checks for both layouts and removes whichever is present; the other is simply absent already and skipped. The `db:seed:cms` script itself is removed from `package.json` only when the OLD seeder is what is actually on disk and no `tools/seed-cms.ts` (#139's replacement) exists yet — once #139 lands, that script belongs to it and `template:init` does not touch it.
- `tools/import-seputarborneo.ts`, `tests/import-seputarborneo.test.mjs`, and the `import:seputarborneo` script entry
- `graphify-out/` and `knowledge/generated/` — removed entirely, not emptied. **This is the "documented empty state" `audit:graf` accepts**: that gate's own first check (`packages/gerbang/audit-graf.mjs`) is `!existsSync(outputDir)`, which passes with a note ("graphify-out/ absent — no root graph artefacts to check") rather than failing — an absent directory is a valid, gate-passing state by that gate's own design, so removing it is simpler and no less correct than writing an empty-but-schema-valid `graph.json`. A derived repo's own first `bun run knowledge:graph:update` recreates it.

### What it never touches

**`apps/cms/**` is never rewritten, under any flag.** It is `ahliweb/awcms`, embedded via `git subtree` ([ADR-0001](adr/0001-git-subtree-with-full-history-for-apps-cms.md)) — upstream's own tree, carried here so fixes flow in both directions through `git subtree pull`. A brand-rewrite tool touching it would create exactly the kind of local divergence [`AGENTS.md`](../AGENTS.md#the-subtree-embed)'s subtree section already warns a future sync cannot safely absorb. A derived deployment's own tenant name, contact details, and theming live entirely in data `apps/cms` serves (its `site_profile`/`theming` modules) or in the `apps/storefront` build-time fallback `site.ts` provides — never in `apps/cms`'s own source.

### After it runs

`template:init` finishes by running, in order: `docs:i18n:stamp`, `bun install`, `audit:dokumen`, `audit:translation`, `audit:rilis`, and root `bun test` — so a derived repository's very first commit is already green, the same "gates pass before you touch anything" starting point this repository's own `AGENTS.md` expects of every change here.

## Build profiles

`SITE_PROFILE` (read at build time by `apps/storefront/src/config/profil.ts`, once #137 lands) selects which page groups a build includes. Full reasoning: [ADR-0018 D2/D3](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md).

| Profile | Composition | What it is |
| --- | --- | --- |
| `toko` (default) | shared + toko + berita | Today's BjekMart shape — commerce and news together |
| `berita` | shared + berita | A news portal only, no commerce |
| `landing` | shared only | A company profile / landing site — pages, contact, SEO chrome; no commerce, no news |

### The profile matrix

Every file under `apps/storefront/src/pages/**` belongs to exactly one group. This table mirrors [ADR-0018](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md#the-profile-matrix)'s own copy; that ADR's copy is the wave-0 contract, this one is kept current as pages actually move into `src/profil/<group>/pages/**`.

| Path | Group | Why |
| --- | --- | --- |
| `404.astro` | shared | Every profile needs a not-found page |
| `akun/afiliasi.astro` | toko | Commerce affiliate dashboard |
| `akun/alamat.astro` | toko | Commerce address book |
| `akun/index.astro` | toko | Commerce account dashboard shell |
| `akun/pesanan.astro` | toko | Commerce order history |
| `akun/pesan.astro` | toko | Commerce customer-inbox thread |
| `akun/ulasan.astro` | toko | Commerce product reviews |
| `arsip/[yyyy]/[mm].astro` | berita | News monthly archive |
| `berita/feed.xml.ts` | berita | News RSS feed (posts) |
| `berita/index.astro` | berita | News front page |
| `berita/[slug].astro` | berita | News article |
| `buletin/index.astro` | berita | Newsletter subscribe page |
| `cari.astro` | toko | Product search (builds from `/index/produk.json`) |
| `cari-berita.astro` | berita | News search |
| `checkout.astro` | toko | Commerce checkout |
| `csp.json.ts` | shared | Every profile derives its own CSP artifact |
| `daerah/[slug].astro` | berita | News regional section |
| `daftar.astro` | toko | Commerce customer registration |
| `feed.xml.ts` | toko | Product RSS feed (not the news feed — `berita/feed.xml.ts` is that) |
| `flash-sale.astro` | toko | Commerce flash sales |
| `halaman/[slug].astro` | shared | Static CMS pages (privacy, terms, editorial, etc.) |
| `index.astro` | shared (per-profile variant) | Every profile has a home page; its content differs per profile |
| `index/berita.json.ts` | berita | Build-time news search index |
| `index/pengalihan-legacy.json.ts` | berita | Legacy news-URL redirect map |
| `index/produk.json.ts` | toko | Build-time product search index |
| `index/wilayah-kabupaten-[provinceCode].json.ts` | toko | Checkout address-region cascade (not a news region) |
| `index/wilayah-kecamatan-[cityCode].json.ts` | toko | Checkout address-region cascade |
| `index/wilayah-provinsi.json.ts` | toko | Checkout address-region cascade |
| `kategori/[slug].astro` | toko | Commerce category listing |
| `keranjang.astro` | toko | Commerce cart |
| `kontak.astro` | shared | Every profile needs a contact page |
| `manifest.webmanifest.ts` | shared | Every profile is an installable site |
| `masuk.astro` | toko | Commerce customer sign-in |
| `mitra/[slug].astro` | berita | The institution/"Mitra" directory — a news partnership feature, not a commerce one (see ADR-0018's own edge-case note) |
| `newsletter/confirm.astro` | berita | Newsletter double opt-in confirm |
| `newsletter/unsubscribe.astro` | berita | Newsletter unsubscribe |
| `penulis/[slug].astro` | berita | News author page |
| `pesanan.astro` | toko | Commerce order tracking |
| `product-labels.css.ts` | toko | Commerce product badge styling |
| `product/[slug].astro` | toko | Commerce product detail |
| `produk.astro` | toko | Commerce product listing |
| `robots.txt.ts` | shared | Every profile needs its own robots rules |
| `rubrik/[slug]/feed.xml.ts` | berita | News rubric RSS feed |
| `rubrik/[slug]/halaman/[n].astro` | berita | News rubric pagination |
| `rubrik/[slug]/index.astro` | berita | News rubric front page |
| `sitemap-index.xml.ts` | shared | Every profile has its own sitemap |
| `sitemap-[n].xml.ts` | shared | Sitemap pagination |
| `tag/[slug].astro` | berita | News tag page |
| `theme-tokens.css.ts` | shared | Every profile has its own theme colours |
| `video/index.astro` | berita | News video listing |
| `video/[slug].astro` | berita | News video article |
| `wishlist.astro` | toko | Commerce wishlist |

**Totals:** shared 10, `toko` 23, `berita` 19 (52 total).

### Navigation, sitemap, feeds, robots, CSP, and fixtures per profile

| | `toko` (default) | `berita` | `landing` |
| --- | --- | --- | --- |
| **Navigation** | Beranda, Produk, Flash Sale, Berita, Kontak, plus cart/wishlist/account icons | Beranda, Berita, Rubrik, Video, Buletin, Kontak | Beranda, static pages, Kontak only |
| **Footer legal links** | Shopping guide, privacy, terms, editorial, media guidelines, disclaimer | Editorial, media guidelines, disclaimer, privacy, terms | Privacy, terms only |
| **Sitemap sources** | All: `static-routes`, `static-pages`, `katalog-produk`, `katalog-kategori`, `katalog-product-detail`, `berita-front`, `berita-posts`, `berita-video`, `berita-rubrik`, `berita-daerah`, `berita-mitra`, `berita-tag` | `static-routes`, `static-pages`, and every `berita-*` source | `static-routes`, `static-pages` only |
| **Feeds** | Product feed + news posts feed + rubric feeds | News posts feed + rubric feeds | None |
| **Robots rules** | Disallows commerce per-visitor paths (`/keranjang`, `/checkout`, `/pesanan`, `/wishlist`, `/cari`, `/masuk`, `/daftar`, `/akun`) plus `/newsletter/*`, `/api/` | Disallows `/newsletter/*`, `/api/` | Disallows `/api/` only |
| **CSP `form-action`/`connect-src`** | `form-action 'self'`, `connect-src` widened to `PUBLIC_AWCMS_ORIGIN` (checkout/cart) | `form-action 'self'` only | `form-action 'self'` only |
| **Stub-CMS fixtures needed** | Every commerce fixture plus every news fixture (the hybrid build needs both) | `blog-posts.json`, `blog-terms.json`, `blog-institutions.json`, `blog-pages-public*.json`, `seo-redirects-legacy.json`, `regions-kalteng.json`, `ad-placements-active.json`, `analytics-pages.json` | `blog-pages-public*.json`, `store-settings-public.json`, `media-objects.json`/`media-public-origin.json`; no commerce or news-specific fixture |

## Sample seeds

`bun run db:seed:cms --profil <toko|berita|landing|contoh:borneojek-mart>` (once [#139](https://github.com/ahliweb/awcms-one/issues/139) lands) seeds one of:

- **`toko`, `berita`, `landing`** — small, neutral, fictional sample content under `tools/seed-data/profil/<profile>/*`: no real people, phone numbers, e-mails, or brand names; `toko` ships ≤ 20 products, ≤ 15 posts, ≤ 6 pages plus categories/marketing/terms; `berita` ships rubrics/posts/authors/pages/regions at the same caps; `landing` ships a site profile, pages, and contact details only. Every seed is re-runnable (upsert by slug) and validates against the same CMS OpenAPI shapes the existing seeder already uses.
- **`contoh:borneojek-mart`** — the full BjekMart reference content, moved from its original location to `tools/seed-data/contoh/borneojek-mart/**`. `db:seed:cms` with no `--profil` flag still targets this by default, so the live reference deployment's own workflow does not change.

## BjekMart as the reference example

BjekMart is not deleted when this repository becomes a template — it is **kept, explicitly labelled as the reference example**: a real, continuously-maintained, full deployment of the `toko` profile, five increments deep, that anyone starting from this template can look at to see what a completed build looks like. `bun run dev` with no `template:init` run at all still gives you BjekMart's own site, exactly as it has since increment 1; `template:init` is what turns this same tree into something else, once you choose to run it.

## Status

**20 September 2026 — issue #138 lands `template:init`.** `tools/template-init.ts` + `tools/template-init/**` are real, tested code (`tests/template-init.test.mjs`), matrixed in CI by `.github/workflows/template-init-smoke.yml`. Two things this page described as the target are still not true, and `template:init` is written to degrade honestly against both:

- **`SITE_PROFILE` has no build-time effect yet.** Issue #137 (the `src/profil/**` layout, the `injectRoute` integration, `apps/storefront/src/config/profil.ts`) has not landed. `template:init --profil <p>` still records the choice (`apps/storefront/.env.example`'s new `SITE_PROFILE` line) and still picks the right `SITE_DESCRIPTION` default for it, but every profile builds the SAME, full `toko`-shaped site until #137 lands — `template-init-smoke.yml`'s own per-profile build leg proves the BUILD succeeds, not yet that the profile's pages are filtered.
- **No per-profile neutral seed data exists yet** (issue #139). `template:init` still removes BjekMart's own seed artefacts (checking both today's flat layout and #139's planned nested one) and still adjusts the generic `SEED_*` tenant defaults in `.env.example`, but a freshly-initialised repo has nothing to seed with `bun run db:seed:cms` until #139 lands or an operator writes their own content.

This page is updated again as [#139](https://github.com/ahliweb/awcms-one/issues/139) (profile seeds) and [#140](https://github.com/ahliweb/awcms-one/issues/140) (the GitHub *template repository* flag, the docs sweep, the release) land.
