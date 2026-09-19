---
bump: minor
type: content
impact: public
---

# Neutral sample seeds per profile; BjekMart's seed becomes the labelled reference example

ADR-0018 D6, issue #139. `tools/seed-cms.ts` replaces `tools/seed-borneojek-mart.ts` as the
seeder every profile shares — `--profil toko|berita|landing|contoh:borneojek-mart`, `--dry-run`,
idempotent upsert-by-slug, a printed inventory summary — so a repository derived from this
template (`template:init`, #138) has real, honest, fast-to-seed sample content the moment it
first runs `bun run dev`, without inheriting BjekMart's own five-increment-deep production
content as its default.

- `tools/seed-data/*.json` moved, unchanged in shape, to
  `tools/seed-data/contoh/borneojek-mart/**` — the reference example. `bun run db:seed:cms`
  with no flag still targets it by default, so the live reference deployment's own workflow is
  unchanged; `tools/seed-borneojek-mart.ts` is now a one-release deprecation shim that prints a
  notice and delegates to `tools/seed-cms.ts --profil contoh:borneojek-mart`.
- Three new neutral, fictional seed sets under `tools/seed-data/profil/{toko,berita,landing}/*`
  — invented names ("Toko Nusantara", "Kabar Kita", "PT Contoh Karya"), placeholder contacts on
  `example.com`/`example.id` and `+62 800 0000 0000`-style numbers, no real people, brands, or
  places tied to BjekMart/seputarborneo. `toko` ships 6 categories/12 products/marketing/4
  pages/terms; `berita` ships 5 rubrics/10 news posts/3 informational author bylines/4 pages,
  plus the region/institution rows a `/daerah/{slug}` archive needs (resolved generically from
  the seed data itself, not a hardcoded region list); `landing` ships a site profile, 4 pages,
  and contact details. Placeholder images are simple, self-generated SVGs under
  `tools/seed-assets/profil/**`.
- Root `package.json`: `db:seed:cms` now points at `tools/seed-cms.ts` directly (same default
  behaviour); a new `db:seed:cms:profil` script is the ergonomic entry point for a chosen
  profile (`bun run db:seed:cms:profil toko`).
- `tests/seed-profil.test.mjs` (`tools/lib/seed-profil.mjs`'s shared, side-effect-free
  validators): every profile's JSON validates against the shapes `tools/seed-cms.ts`'s own
  `ensure*` functions expect, a no-PII regex sweep over each file's raw text, every asset
  reference resolves, and `--dry-run` exits 0 for all four profiles with no network call at
  all — `--dry-run` is deliberately network-free by design, a stronger guarantee than seeding
  against a fake server would give, and safe to run against a database that already holds real
  content.
- `docs/template.md`'s "Sample seeds" section now describes real, landed mechanism instead of a
  wave-0 target; a new "Seeding a profile locally" section in
  `docs/alur-kerja-pengembangan.md` warns against ever seeding a neutral profile into this
  repository's own shared local dev database (it already holds BjekMart's own tenant, and
  tenant setup is a once-per-database lock).
- `packages/gerbang/audit-dokumen.mjs`'s `EXCLUDED_PATHS` drops its `tools/seed-cms.ts` entry —
  the path this wave-0 contract named ahead of this issue now genuinely exists.

`#137` (storefront profiles + CI matrix) and `#138` (`template:init`) remain outstanding; this
issue's own scope is the seeder and its seed data only.
