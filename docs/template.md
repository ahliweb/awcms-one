🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](template.id.md)

# Using awcms-one as a template

`awcms-one` is both the BjekMart product and a **template** other applications start from: a build-time `SITE_PROFILE` decides which pages a deployment ships, and an idempotent `bun run template:init` rewrites the brand surface for a repository created from GitHub's own *template repository* flag. This document is the working reference [ADR-0018](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md) commits to: how a new application starts from `awcms-one`, what `template:init` does to make a derived repository its own, the build-profile matrix that decides which pages a deployment ships, and where BjekMart itself fits now that this repository is also a template. Every mechanism this document describes is real, tested, running code — `SITE_PROFILE`'s page-filtering behaviour (`apps/storefront/src/config/profil.ts`, `src/profil/**`, issue #137), `bun run template:init` (`tools/template-init.ts` + `tools/template-init/**`, tested by `tests/template-init.test.mjs`, matrixed in CI by `.github/workflows/template-init-smoke.yml`, issue #138), and the neutral per-profile seed sets (`tools/seed-cms.ts`, issue #139). See "Status" at the bottom for the dated landing history and what increment 6 (issue #140) closed out.

## Memulai dari template (starting from the template)

1. **Use this template.** Click "Use this template" on `ahliweb/awcms-one` (the GitHub *template repository* flag is on) to create a new, historyless repository — not a fork. Clone it.
2. **`bun install`**, then **`bun run template:init`** (see the CLI reference below) — an idempotent, one-time rewrite of this repository's brand surface (name, domain, colours, contact, chosen profile) into your own. Answer the prompts, or pass every flag non-interactively (useful in a script or CI).
3. **`.env`** — `cp .env.example .env` at root, and `cp apps/cms/.env.example apps/cms/.env` for the backend; fill in what `template:init` did not already set for you (database credentials, any provider keys you intend to use — see [ADR-0017](adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) for what each provider needs).
4. **`bun run db:up`** — a local PostgreSQL via `docker compose`.
5. **`bun run db:migrate:cms`** — runs `apps/cms`'s own migration chain against that database.
6. **`bun run db:seed:cms:profil <toko|berita|landing>`** — seeds the neutral sample content matching your chosen profile (D6, #139); `bun run db:seed:cms` (no argument) still seeds BjekMart's own full reference content (`contoh:borneojek-mart`, the unchanged default).
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
| `--kontak-telepon` | No | Becomes `DEFAULT_IDENTITY.contactPhone` when given; omitted writes `null` (issue #233 — `DEFAULT_IDENTITY.contactPhone` is typed `string \| null` specifically for this) rather than leaving BjekMart's own real phone number as a live fallback. Every consumer already renders no phone block at all when it is `null` |
| `--alamat` | No | Becomes `DEFAULT_IDENTITY.address` when given; omitted writes `null` the same way, for the same reason — no street address block renders, rather than BjekMart's own |
| `--dry-run` | No | Prints the full rewrite/removal plan and touches nothing |
| `--yes` | No | Required to proceed on a dirty working tree; otherwise the tool refuses to run rather than mixing its own rewrite into uncommitted changes |

**Interactive vs. non-interactive:** a missing required flag prompts for it when stdin is a TTY; otherwise the tool exits **`2`**, naming every missing flag on one line, so a CI job or script gets a clear, machine-readable failure instead of hanging on a prompt nobody can answer.

**Idempotency:** running `template:init` a second time with the exact same flags is a no-op — exit **`0`**, printing "nothing to do." Running it again with one or more different flags rewrites again, touching only what actually changed. This is what makes it safe for [#138](https://github.com/ahliweb/awcms-one/issues/138)'s own `template-init-smoke` CI job to run unattended, and safe for a human to re-run after fixing a typo in an earlier flag.

**Exit codes:** `0` success (including "nothing to do"); `1` an internal failure (a file the tool expected to rewrite is missing, a gate it runs at the end fails); `2` missing required flags in non-interactive mode; `3` refused on a dirty working tree without `--yes`.

### What it rewrites

Exactly the brand surface [ADR-0018 D4](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md#d4--brand-lives-in-env--sitets-plus-a-short-named-list-of-files-templateinit-rewrites) names:

- `apps/storefront/src/config/site.ts` — `DEFAULT_IDENTITY` (`name`, `description`, `contactEmail` always; `contactPhone`/`address` written verbatim when the matching flag is given, and written as the bare `null` literal — never left as BjekMart's own real phone number/street address — when it is omitted, per issue #233; `DEFAULT_IDENTITY`'s own type allows `null` for exactly those two fields), `DEFAULT_THEME_COLORS`, and the `SITE_NAME`/`SITE_DESCRIPTION` `readEnvOr` fallbacks. **A third correction to this section's wave-0 wording**: `DEFAULT_IDENTITY.description` was not in the original list (only `name`/`contactEmail`/`contactPhone`/`address` were named) — added here because leaving it untouched ships BjekMart's own catchphrase ("...di BjekMart") into every derived deployment forever, exactly the defect D4's own "Rejected (c)" paragraph describes.
- Root `package.json` — `name`, `description`, `homepage`, `repository.url`, and (once only, on the first run) a new `awcmsOne.templateVersion` field recording the awcms-one version this derived repo was created from
- `compose.yaml` — the Docker Compose project name, container name, and named volume
- `README.md`/`README.id.md` — the hero section
- `SUPPORT.md`/`SUPPORT.id.md` — the hero sentence
- `.env.example` — the seed-script tenant defaults (`SEED_TENANT_CODE`/`SEED_TENANT_NAME`/`SEED_OFFICE_CODE`/`SEED_OFFICE_NAME`/`SEED_OWNER_EMAIL`)
- `apps/storefront/.env.example` — `SITE_URL`, `SITE_NAME`, `SITE_DESCRIPTION`, and #137's own `SITE_PROFILE` line (uncommented and set to the chosen profile)
- `tools/seed-cms.ts` (issue #139) — its `--profil` default, from `contoh:borneojek-mart` to the deployment's own chosen profile; `package.json`'s `db:seed:cms` script is rewritten the same way, from `bun tools/seed-cms.ts` to `bun tools/seed-cms.ts --profil <chosen profile>`
- `CHANGELOG.md` — reset to a single `## [0.1.0]` entry reading "Dibuat dari template awcms-one vX.Y.Z (\<sha\>)" (once only)
- `.changesets/*.md` — cleared (the README is kept; once only)

**Two corrections to this section's original wording, made in the same change that implements the tool (issue #138), since the doc and the tree disagreed:**

- `SECURITY.md`/`SECURITY.id.md` carry **no** BjekMart-specific contact line as the tree actually stands — every address in those files is a GitHub URL to `ahliweb/awcms-one`, which `template:init` deliberately does **not** rewrite (see "What it does not know" below). `rewriteSecurity()` (`tools/template-init/rewriters.mjs`) is a documented no-op kept for symmetry with `SUPPORT.md`.
- `SITE_NAME`/`SITE_URL`/`SITE_DESCRIPTION`/`SITE_PROFILE` all live in `apps/storefront/.env.example`, not the root `.env.example` — the root file documents only root-owned-script variables (see that file's own header). `SITE_PROFILE` itself is [#137](https://github.com/ahliweb/awcms-one/issues/137)'s own addition to that file (a commented-out `# SITE_PROFILE=toko` default); `template:init` uncomments it and sets it to the deployment's own chosen profile.

### What "no BjekMart string left" actually means

`template:init`'s own test (`tests/template-init.test.mjs`) scans for BjekMart-specific strings only inside D4's own named brand surface (`package.json`, `compose.yaml`, `.env.example`, `apps/storefront/.env.example`, `apps/storefront/src/config/site.ts`, `README*.md`, `SUPPORT*.md`) plus confirming the removal targets are gone — **not** the whole tree. `docs/*`, `apps/storefront/**` (its tests and fixtures included), and this repository's own `AGENTS.md`/`CHANGELOG.md` history legitimately describe BjekMart as this repository's own, real, five-increment reference deployment (ADR-0018 D6) and are out of `template:init`'s scope by the same D4 paragraph that rejects "hunt the whole tree with no closed list to check against" as an option. A derived repo therefore still reads BjekMart's own name throughout its inherited documentation and test fixtures until it edits those itself — `template:init` only guarantees its own OWN named surface is clean.

### What it does not know

`template:init` has no `--org`/`--repo` flag, so it cannot know a derived repository's own GitHub owner/name. `package.json`'s `repository.url` is rewritten to `git+https://github.com/GANTI-ORG/<slug>.git` — a loud, greppable placeholder, not a guess — and every GitHub URL inside `README*.md`/`SUPPORT*.md`/`SECURITY*.md` that still points at `ahliweb/awcms-one` (issue links, the Security Advisory link, ADR links) is left exactly as it is: those are functional links, not brand text, and a repository just created from the template has not necessarily even been renamed or moved yet. Completing `GANTI-ORG` and any GitHub links a derived repo's owner wants pointed at their own fork remains a manual step after `template:init` runs.

### What it removes

BjekMart-only artefacts that a derived deployment does not need and should not carry as dead weight or misleading example content:

- `tools/seed-borneojek-mart.ts` (the deprecation shim [#139](https://github.com/ahliweb/awcms-one/issues/139) left behind) and `tools/seed-data/contoh/borneojek-mart/**` (the full BjekMart reference content #139 relocated there) — `template:init` also checks for the PRE-#139 flat layout (`tools/seed-data/*.json` + `tools/seed-assets/`) and removes it too, in case it ever runs against a tree from before #139 landed. `package.json`'s `db:seed:cms` script is rewritten, not removed: `bun tools/seed-cms.ts` (BjekMart's own default) becomes `bun tools/seed-cms.ts --profil <chosen profile>`, so the derived repo's own default seed target matches its own `--profil` choice instead of the reference example.
- `tools/import-seputarborneo.ts`, `tests/import-seputarborneo.test.mjs`, and the `import:seputarborneo` script entry
- `graphify-out/` and `knowledge/generated/` — removed entirely, not emptied. **This is the "documented empty state" `audit:graf` accepts**: that gate's own first check (`packages/gerbang/audit-graf.mjs`) is `!existsSync(outputDir)`, which passes with a note ("graphify-out/ absent — no root graph artefacts to check") rather than failing — an absent directory is a valid, gate-passing state by that gate's own design, so removing it is simpler and no less correct than writing an empty-but-schema-valid `graph.json`. A derived repo's own first `bun run knowledge:graph:update` recreates it.

**`tests/seed-profil.test.mjs` (#139) is deliberately kept, not removed**: it validates the neutral `tools/seed-data/profil/{toko,berita,landing}/**` seeds every derived repo keeps, not only the BjekMart reference example this run removes. Its own `contoh:borneojek-mart`/deprecation-shim-specific describe blocks guard themselves with an existence check (`HAS_CONTOH_SEED`/`HAS_DEPRECATION_SHIM`) and skip cleanly once `template:init` has removed what they describe, rather than the whole file being a removal target.

### What it never touches

**`apps/cms/**` is never rewritten, under any flag.** It is `ahliweb/awcms`, embedded via `git subtree` ([ADR-0001](adr/0001-git-subtree-with-full-history-for-apps-cms.md)) — upstream's own tree, carried here so fixes flow in both directions through `git subtree pull`. A brand-rewrite tool touching it would create exactly the kind of local divergence [`AGENTS.md`](../AGENTS.md#the-subtree-embed)'s subtree section already warns a future sync cannot safely absorb. A derived deployment's own tenant name, contact details, and theming live entirely in data `apps/cms` serves (its `site_profile`/`theming` modules) or in the `apps/storefront` build-time fallback `site.ts` provides — never in `apps/cms`'s own source.

### After it runs

`template:init` finishes by running, in order: `docs:i18n:stamp`, `bun install`, `audit:dokumen`, `audit:translation`, `audit:rilis`, and root `bun test` — so a derived repository's very first commit is already green, the same "gates pass before you touch anything" starting point this repository's own `AGENTS.md` expects of every change here.

**`tests/template-init.test.mjs` skips itself the moment it detects it is no longer running inside `awcms-one` itself** (`package.json.name !== "awcms-one"`, printed as one clear SKIPPED line). Without this, this trailing `bun test` would discover and re-run its own test file inside the very repository it just initialised — that file's own full-run tests then try to build ANOTHER temp copy from `git ls-files`, which still lists paths this run's own removal step already deleted (a real `unlinkSync`, never a `git rm`), throwing `ENOENT` on every one of them. The guard is not a workaround for that copy failure (`makeTempCopy` also filters `git ls-files` through `existsSync`, defensively, as a second and independent layer) — it is the actual fix: these tests exist to test the template, and must never run a second time against a repository that is no longer the template.

`TEMPLATE_INIT_TEST_SCOPE=root` (environment variable, CI-only) makes that trailing `bun test` run only the root gate tests (`bun test ./tests/` — the leading `./` matters, see below) instead of the whole workspace: the `template-init-smoke` workflow and `tests/template-init.test.mjs` both already run the full suite around the tool, and a nested full run doubled the stub-CMS build load enough to trip the storefront smoke tests' stub-start deadline. A real derived repository never sets it.

**Why `./tests/`, not `tests` (issue #147).** `bun test`'s positional argument is a path **filter** — a substring match against every test file's path — not a directory restriction. `bun test tests` therefore also matches `apps/storefront/tests/*.test.ts`, because that path contains the substring `tests` too; it matches every test file in this repository, since each one lives under a directory literally named `tests`. `TEMPLATE_INIT_TEST_SCOPE=root` silently never scoped anything until this fix — `tools/template-init/gates.mjs`'s own docblock on `runFollowUpGates` has the full repro, and `tests/gerbang-test-scope.test.mjs` keeps it a permanent regression test. A path starting with `./` or `/` is not treated as a filter; it resolves as an actual directory instead.

## Build profiles

`SITE_PROFILE` (read at build time by `apps/storefront/src/config/profil.ts`, [#137](https://github.com/ahliweb/awcms-one/issues/137)) selects which page groups a build includes. Full reasoning: [ADR-0018 D2/D3](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md).

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

`bun run db:seed:cms:profil <toko|berita|landing|contoh:borneojek-mart>` (equivalently, `bun run db:seed:cms -- --profil <name>`; [#139](https://github.com/ahliweb/awcms-one/issues/139), `tools/seed-cms.ts`) seeds one of:

- **`toko`, `berita`, `landing`** — small, neutral, fictional sample content under `tools/seed-data/profil/<profile>/*`: no real people, phone numbers, e-mails, or brand names — placeholder contacts use `example.com`/`example.id` and `+62 800 0000 0000`-style numbers. `toko` ships ≤ 20 products across ≤ 6 categories plus marketing/pages/terms; `berita` ships ≤ 15 posts across ≤ 5 rubrics, ≤ 3 informational author bylines, ≤ 4 pages, and the region/institution rows a `/daerah/{slug}` archive needs; `landing` ships a site profile, ≤ 4 pages, and contact details only. Placeholder images are generated SVGs under `tools/seed-assets/profil/<profile>/`. Every seed is idempotent (upsert by slug, safe to re-run) and validates against the shapes `apps/cms/openapi/awcms-public-api.openapi.yaml` already documents for the endpoints the seeder calls.
- **`contoh:borneojek-mart`** — the full BjekMart reference content, moved from its original location to `tools/seed-data/contoh/borneojek-mart/**`. `bun run db:seed:cms` with no `--profil` flag still targets this by default, so the live reference deployment's own workflow does not change; `tools/seed-borneojek-mart.ts` (the file that used to BE the seeder) is now a one-release deprecation shim that prints a notice and delegates to `tools/seed-cms.ts --profil contoh:borneojek-mart`.

`--dry-run` validates the chosen profile's seed JSON and prints an inventory summary without making any network call at all — safe to run against a database that already holds real content (see `docs/alur-kerja-pengembangan.md`'s "Seeding a profile locally" for the full runbook and why the shared local dev database is never seeded with a neutral profile).

## BjekMart as the reference example

BjekMart is not deleted when this repository becomes a template — it is **kept, explicitly labelled as the reference example**: a real, continuously-maintained, full deployment of the `toko` profile, five increments deep, that anyone starting from this template can look at to see what a completed build looks like. `bun run dev` with no `template:init` run at all still gives you BjekMart's own site, exactly as it has since increment 1; `template:init` is what turns this same tree into something else, once you choose to run it.

## Status

Increment 6 (epic [#135](https://github.com/ahliweb/awcms-one/issues/135)) is complete; every mechanism in this document is real, tested, running code, not a plan.

| Date | Issue | What landed |
| --- | --- | --- |
| 20 September 2026 | [#136](https://github.com/ahliweb/awcms-one/issues/136) | [ADR-0018](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md) (D1–D8), this document's skeleton, and the profile matrix (all 52 files under `apps/storefront/src/pages/**` assigned) |
| 20 September 2026 | [#137](https://github.com/ahliweb/awcms-one/issues/137) | `SITE_PROFILE` itself — `apps/storefront/src/config/profil.ts`, the `injectRoute` integration (`integrations/profil.mjs`), pages moved into `src/profil/<group>/pages/**`, `apps/storefront/.env.example`'s commented-out `# SITE_PROFILE=toko` default, and `ci.yml`'s 3-leg `Check (toko|berita|landing)` build matrix. `SITE_PROFILE` genuinely decides which pages a build includes, exactly as the profile matrix above describes |
| 20 September 2026 | [#139](https://github.com/ahliweb/awcms-one/issues/139) | `tools/seed-cms.ts`, with `--profil toko|berita|landing|contoh:borneojek-mart` and `--dry-run`, plus the neutral seed sets under `tools/seed-data/profil/{toko,berita,landing}/*` and placeholder SVGs under `tools/seed-assets/profil/**`; the BjekMart seed moved to `tools/seed-data/contoh/borneojek-mart/**`, unchanged in shape; `tools/seed-borneojek-mart.ts` became a one-release deprecation shim |
| 20 September 2026 | [#138](https://github.com/ahliweb/awcms-one/issues/138) | `bun run template:init` (`tools/template-init.ts` + `tools/template-init/**`), tested by `tests/template-init.test.mjs`, matrixed in CI by `.github/workflows/template-init-smoke.yml`. Its removal step and its `apps/storefront/.env.example` rewrite target #137's and #139's own landed layouts directly: `template:init --profil <p>` uncomments and sets the real `SITE_PROFILE` line #137 added, so a derived repository's build genuinely filters pages by the chosen profile from its very first build |
| 20 September 2026 | [#140](https://github.com/ahliweb/awcms-one/issues/140) | The docs sweep to this actual state (this page, `README.md`, `AGENTS.md`, the CI/routing/SEO/testing/deployment/workflow docs, `apps/storefront/README.md`, the `.claude/skills/` how-tos including the new `awcms-one-template` skill), the GitHub *template repository* flag, `packages/gerbang/audit-dokumen.mjs`'s `EXCLUDED_PATHS` cleanup, the knowledge-graph rebuild, and the v0.8.0 release that closed epic #135 |

The three-legged `Check` matrix, `check-cms`, and all four `template-init-smoke` legs are required status checks on `main` (the latter promoted in issue #182 — see [`docs/alur-kerja-pengembangan.md`](alur-kerja-pengembangan.md) for the settings as verified).
