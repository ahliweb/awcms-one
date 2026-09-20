---
name: awcms-one-template
description: Start a new application from awcms-one, GitHub's own template repository. Use when a request is "create a new app/store/site from awcms-one", "run template:init", or "what does template:init rewrite/remove". Covers the init flags, choosing a build profile, seeding it, and what to check afterward.
---

🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](SKILL.id.md)

# awcms-one — Start a new app from this template

Follow [ADR-0018](../../../docs/adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md) and [`docs/template.md`](../../../docs/template.md) for the full reasoning and reference; this skill is the practical how-to for actually running it.

## What this repository is, twice over

`awcms-one` keeps running as the BjekMart product **and** is a GitHub *template repository* other applications start from. Creating a new app means using GitHub's own "Use this template" button (a fresh, historyless repository — never a fork, never a manual copy), then running `bun run template:init` once inside the clone to make it its own.

## Step 1 — pick the build profile before anything else

Every derived app is one of three shapes, decided by `SITE_PROFILE` at build time ([ADR-0018 D2](../../../docs/adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md)):

| Profile | Composition | Pick this when the app is… |
| --- | --- | --- |
| `toko` (default) | shared + commerce + news | An online store, optionally with a news/blog section — today's BjekMart shape |
| `berita` | shared + news | A news portal / blog only, no commerce |
| `landing` | shared only | A company profile or landing site — pages, contact, SEO chrome; no commerce, no news |

This choice is not easily reversible after content exists: it decides which page groups the build includes, which seed set matches, and which fixtures a CI smoke check needs. See [`docs/template.md`](../../../docs/template.md#the-profile-matrix) for exactly which routes each profile ships.

## Step 2 — run `template:init`

```bash
bun install
bun run template:init \
  --nama "Toko Contoh" \
  --slug toko-contoh \
  --domain toko-contoh.id \
  --profil toko|berita|landing \
  --warna-primer "#0ea5e9" \
  --kontak-email owner@toko-contoh.id \
  [--warna-sekunder "#0369a1"] [--warna-aksen "#f59e0b"] \
  [--kontak-telepon "+62 812-0000-0000"] [--alamat "Jl. Contoh No. 1"] \
  [--dry-run] [--yes]
```

- Missing a required flag prompts for it on a TTY; in a script/CI it exits **`2`**, naming every missing flag.
- Run `--dry-run` first to see the exact rewrite/removal plan with nothing touched — always safe, no network, no side effects.
- The tool refuses on a dirty working tree without `--yes` (exit `3`) — commit or stash first, then re-run.
- Running it twice with identical flags is a no-op (exit `0`, "nothing to do"); different flags rewrite again, touching only what changed.
- Full flag reference, exit codes, and idempotency guarantees: [`docs/template.md`](../../../docs/template.md#templateinit--cli-reference).

**What it rewrites** (and nothing outside this list): `apps/storefront/src/config/site.ts` (`DEFAULT_IDENTITY`, `DEFAULT_THEME_COLORS`, `SITE_NAME`/`SITE_DESCRIPTION` fallbacks), root `package.json` (name/description/homepage/repository — `repository.url` becomes a loud `GANTI-ORG` placeholder since the tool has no `--org`/`--repo` flag), `compose.yaml`, `README*.md`/`SUPPORT*.md` heroes, both `.env.example` files (including uncommenting and setting `SITE_PROFILE`), `tools/seed-cms.ts`'s default profile and the `db:seed:cms` script line, `CHANGELOG.md` (reset to `0.1.0`), and `.changesets/*.md` (cleared).

**What it removes**: the BjekMart-only reference seed (`tools/seed-borneojek-mart.ts`, `tools/seed-data/contoh/borneojek-mart/**`), the seputarborneo importer and its test, and `graphify-out/`/`knowledge/generated/` (an absent directory is a valid state — a fresh `bun run knowledge:graph:update` recreates it).

**What it never touches, under any flag**: `apps/cms/**`. That tree is `ahliweb/awcms` embedded via `git subtree` — upstream's own code, never rewritten locally (see the root [`AGENTS.md`](../../../AGENTS.md#the-subtree-embed)). A derived app's tenant name, contact details, and theming live in what `apps/cms` serves at runtime or in `apps/storefront`'s own build-time `site.ts` fallback, never in `apps/cms`'s source.

**What it does NOT guarantee**: a whole-tree sweep for every BjekMart-shaped string. `template:init`'s own test only scans the named brand surface above — `docs/*`, test fixtures, and this repository's own `AGENTS.md`/`CHANGELOG.md` history legitimately keep describing BjekMart as *this* repository's own reference deployment. A derived repo still reads "BjekMart" in inherited docs and fixtures until it edits those itself.

## Step 3 — seed it and run it

```bash
cp .env.example .env
cp apps/cms/.env.example apps/cms/.env   # fill in DB credentials + any provider keys — see ADR-0017
bun run db:up                             # local PostgreSQL via docker compose
bun run db:migrate:cms
bun run db:seed:cms:profil <toko|berita|landing>   # match the profile chosen in step 1
bun run dev
```

`bun run db:seed:cms:profil <name>` seeds small, neutral, fictional content from `tools/seed-data/profil/<name>/**` — no real people, phone numbers, e-mails, or brand names (placeholders use `example.com`/`example.id` and `+62 800 0000 0000`-style numbers). Never point a neutral-profile seed at a database that already holds real content — `POST /api/v1/setup/initialize` is a once-per-database singleton lock.

## After `template:init` runs, check

`template:init` already runs `docs:i18n:stamp`, `bun install`, `audit:dokumen`, `audit:translation`, `audit:rilis`, and root `bun test` for you — a derived repo's first commit is already green. Beyond that, verify by hand:

1. **`repository.url` in `package.json`** still reads `GANTI-ORG` — replace it, and any GitHub links in `README*.md`/`SUPPORT*.md`/`SECURITY*.md` still pointing at `ahliweb/awcms-one`, once the new repo has an owner.
2. **`SITE_PROFILE`** in `apps/storefront/.env.example` matches the profile chosen — `bun run build` with no override should ship exactly that profile's pages.
3. **No leftover BjekMart-only artefact** — `tools/seed-borneojek-mart.ts` and `tools/seed-data/contoh/**` should be gone; `tests/seed-profil.test.mjs`'s reference-example test cases self-skip once they are.
4. **`cd apps/storefront && SITE_PROFILE=<chosen> bun run check`** passes, and a real `bun run build` produces only the chosen profile's routes.

## Common mistakes

- **Editing `apps/cms/**` to "fix" a brand string** — it never carries brand data; find the equivalent in `apps/storefront/src/config/site.ts` or the seed data instead.
- **Running `template:init` on a dirty tree with `--yes` out of habit** — that flag exists for CI, not to skip reviewing what will be rewritten; read the `--dry-run` output first on a real derived app.
- **Choosing a profile after content already exists** — pick it in step 1, before seeding or authoring pages, since it decides which page groups and fixtures matter.
