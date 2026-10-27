---
bump: minor
type: structure
impact: public
---

# Versioned population statistics per region from BPS "Dalam Angka" (issue #497)

Adds a neutral, global reference-data capability beside `idn_admin_regions` ([ADR-0051](../docs/adr/0051-bps-population-statistics-are-versioned-global-reference-data-stored-exactly-as-published.md)). The point is official, auditable figures per Kemendagri region code, stored exactly as published (value plus unit, level, reference year, basis, source table and page) rather than converted or merged across bases.

- New migration `apps/cms/sql/882_awcms_idn_population_stats.sql` (the `880`-`899` local band): `awcms_idn_population_datasets` and `awcms_idn_population_stats`, global, no RLS, no DELETE for any role; one active dataset per publication series and covered region.
- New operator commands `bun run idn-population:import` (dry run by default; validates region codes and the arithmetic of the figures) and `bun run idn-population:activate`. Run `bun run db:migrate` before using them.
- New root tooling `tools/bps-population/` (discover, fetch, extract) that reads BPS publications politely and never bypasses a challenge; needs `pdftotext`.
- Reviewed datasets under `apps/cms/data/idn-population/datasets/`, starting with Kalimantan Tengah. The MIT licence covers the code and format only; the figures remain BPS's under each publication's terms, so commercial serving needs the operator's own assessment or BPS's written permission (`NOTICE.md`).
- `suppressSmallCells` (religion under 10 persons, any dimension under 10 at village level) is ready for the future read API; there is no HTTP endpoint or admin screen yet.
- Developers: one new local-divergence item in `AGENTS.md` (registry rows and three upstream test edits); keep ours on a subtree conflict, then re-run the generators.
