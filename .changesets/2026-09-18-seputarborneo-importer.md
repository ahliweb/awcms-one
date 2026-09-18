---
bump: minor
type: structure
impact: internal
---

# Exporter from the seputarborneo MariaDB dump to `blog_content`'s legacy-import pipeline

`tools/import-seputarborneo.ts` (`bun run import:seputarborneo`) reads seputarborneo.com's legacy MariaDB archive and writes the input files `apps/cms`'s own operator pipeline for exactly this job expects — `bun run blog:legacy:import` (Issue #599/ADR-0114 in upstream awcms). It makes no network call itself; the actual import runs from inside `apps/cms`, against the same `borneojek-mart` tenant `tools/seed-borneojek-mart.ts` bootstraps.

The **why** is mostly about what an earlier design got wrong: a first pass of this tool called the public HTTP API directly, but no public route can backdate `published_at` for an already-past article or write `legacy_source_id` — `apps/cms`'s own `blog:legacy:import` does both, and was built (per its own docblock) using this exact archive as its reference case. Routing through it also means this exporter does not need its own HTML→Portable Text converter — a second one would diverge from the converter whose refusals the pipeline actually reports and acts on.

- A streaming MariaDB dump reader (`tools/lib/mysql-dump-reader.ts`, unchanged from this issue's first pass) that learns each table's column order from its own `CREATE TABLE` statement — verified necessary against the real dump, whose `berita_vid` schema differs from the reference repo's own migrated fixture.
- The exporter writes `posts.ndjson`/`videos.ndjson` (`legacy-import-record.ts`'s exact field shape), `redirects.json` (built directly from the raw legacy title, correct even for the ~171 rows a naive `{slug}`-templated redirect would get wrong), `term-map-hints.json` (this exporter's own taxonomy classification, as a work aid), and `site-profile.json`.
- One small, deliberate exception to "no HTTP client": `--assign-institutions`, a follow-up pass run after `blog:legacy:import --commit`. That pipeline calls `syncPostTermAssignments` but never `syncPostInstitutionAssignments` (verified directly), so a `DAERAH`/`MITRA BORNEO` article would otherwise import with no institution at all and never reach `/daerah/{slug}`/`/mitra/{slug}` — both this issue's own acceptance criterion.
- Verified end to end against the real 228 MB dump: 25,490 `berita_red` rows read, 25,489 exported, 0 unmapped taxonomy values, 35 `berita_vid` rows exported. The full `blog:legacy:import --commit` run against a live, seeded tenant is deliberately deferred to after issue #57 merges.
