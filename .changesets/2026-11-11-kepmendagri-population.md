---
bump: minor
type: structure
impact: public
---

# Population and area from the Kepmendagri region decree; BPS removed

The owner stopped the BPS source on 11 November 2026 ("terlalu banyak data yang diperlukan, gunakan Permendagri saja"): one "Dalam Angka" PDF per province, regency/city and district meant tens of thousands of downloads behind Cloudflare, about 39 MB of extracted CSV/JSON already in the repository with most of the country still missing, and hours per province. The figures the platform needs were already vendored and checksummed beside the region dump. [ADR-0053](../docs/adr/0053-population-and-area-come-from-the-kepmendagri-region-decree-not-bps.md) supersedes [ADR-0051](../docs/adr/0051-bps-population-statistics-are-versioned-global-reference-data-stored-exactly-as-published.md).

**Breaking for anyone who imported BPS figures:** after `bun run db:migrate`, every BPS dataset and figure is deleted, and the age group, religion, occupation, income and expenditure dimensions, the `ribu_jiwa`/`rupiah` units and all district/village figures no longer exist. Nothing in this repository read them (no API, no screen), but a derived application that queried `awcms_idn_population_datasets`/`awcms_idn_population_stats` directly loses them.

- New migration `apps/cms/sql/883_awcms_idn_population_kepmendagri_source.sql` (next free in the `880`-`899` band is now `884`): deletes the BPS rows, replaces `sql/882`'s BPS-only CHECKs with ones for the decree source only, admits an `area` figure in `km2`, widens `value` to `numeric(14,3)` so BIG's three decimals are stored unrounded, and adds `source_files`. `sql/882` is unchanged.
- `bun run idn-population:import` now reads the vendored `wilayah_penduduk.sql` (persons per Kepmendagri No 300.2.2-2138 Tahun 2025) and `wilayah_luas.sql` (area from Badan Informasi Geospasial) offline, after checking both against `manifest.json` and `checksums.sha256`, and writes one dataset: 552 provinces and regencies/cities, 2,208 figures (total, male, female, area). It takes no `--dataset`/`--all-pending` any more; re-running over identical bytes is a no-op. `bun run idn-population:activate` is unchanged.
- To serve the figures: `bun run db:migrate`, then (with an active region dataset) `bun run idn-population:import -- --commit` and `bun run idn-population:activate -- --dataset <code> --commit`.
- Removed: `apps/cms/data/idn-population/` (3,812 BPS datasets), the root `tools/bps-population/` pipeline, its tests and fixtures, and the `BPS_CACHE_DIR`/`BPS_ARCHIVE_REMOTE`/`pdftotext`/`rclone` needs that came with them. About 40 MB of tracked files leave the repository.
