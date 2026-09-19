---
bump: minor
type: content
impact: public
---

# ADR-0018 + profile matrix + template contract (wave 0 of epic #135)

Increment 6 turns awcms-one into a **template** other applications can start from, while it
keeps running as the BjekMart reference deployment. Wave 0 (issue #136) settles the eight
architectural decisions (D1–D8) the whole increment codes against, before any code changes,
exactly as ADR-0016 and ADR-0017 did for their own increments.

- [ADR-0018](../docs/adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md)
  records the template shape (this repository stays the template, no fork, no second repo),
  build profiles (`SITE_PROFILE ∈ {toko, berita, landing}`), the page-group mechanism
  (`src/profil/<group>/pages/**` injected by an Astro integration — runtime 404 guards and
  one-app-per-profile are both rejected), the brand surface `template:init` rewrites, the
  `template:init` CLI's own idempotency/dry-run/exit-code contract, neutral per-profile sample
  seeds (with BjekMart's own content kept as the labelled reference example), a 3-leg CI
  matrix, and this increment's own v0.8.0 release / derived-repo-starts-at-0.1.0 versioning
  rule.
- The **profile matrix** assigns every one of the 52 files under `apps/storefront/src/pages/**`
  to `shared`/`toko`/`berita`, including three edge cases decided from reading the code rather
  than the issue text: `mitra/[slug].astro` is a news-institution directory (`berita`, not
  `toko` — it uses `BeritaLayout` and is registered as a `berita-mitra` sitemap source), the
  root `feed.xml.ts` is the PRODUCT feed (`toko`, not the news feed — `berita/feed.xml.ts` is
  that), and `index/wilayah-*.json` is the checkout address cascade (`toko`, despite the
  "wilayah" name overlapping with `berita`'s own regional sections).
- [`docs/template.md`](../docs/template.md) walks through starting from the template
  ("Use this template" → `template:init` → `.env` → `db:up`/`db:migrate:cms`/`db:seed:cms
  --profil` → `bun run dev` → deploy), the `template:init` CLI flag table, the same profile
  matrix, the seeds section, and BjekMart as the reference example. Linked from
  [`docs/README.md`](../docs/README.md) and root `README.md`, with a new "Use this as
  template" section pointing at both documents.
- `packages/gerbang/audit-dokumen.mjs`'s `EXCLUDED_PATHS` gains entries for the not-yet-built
  paths this wave-0 contract names ahead of #137/#138/#139 (`apps/storefront/src/config/profil.ts`,
  `apps/storefront/integrations/profil.mjs`, `tests/template-init.test.mjs`,
  `tools/seed-cms.ts`), plus ADR-0018's own two rejected-alternative paths under a hypothetical
  examples workspace (a shape this ADR turned down, never built), each citing the issue or ADR
  section that names it.

No code changes — this is the contract #137 (storefront profiles + CI matrix), #138
(`template:init`), and #139 (profile seeds) build against in parallel next.
