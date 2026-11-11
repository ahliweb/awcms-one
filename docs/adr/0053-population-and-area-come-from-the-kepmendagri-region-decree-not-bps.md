🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0053-population-and-area-come-from-the-kepmendagri-region-decree-not-bps.id.md)

# ADR-0053 — Population and area come from the Kepmendagri region decree, not from BPS

- **Status:** Accepted
- **Date:** 11 November 2026
- **Decision maker:** ahliweb (owner decision of 11 November 2026)
- **Supersedes:** [ADR-0051](0051-bps-population-statistics-are-versioned-global-reference-data-stored-exactly-as-published.md)
- **Related:** issue [#497](https://github.com/ahliweb/awcms-one/issues/497); [ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md) (template-only ownership; neutral naming); [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md) (migration bands); the reference repo `awcms` ADR-0046 (the `idn_admin_regions` module and its vendored `cahyadsn/wilayah` dataset) and `awcms` ADR-0052 (region dataset activation is a worker CLI)

## Context

[ADR-0051](0051-bps-population-statistics-are-versioned-global-reference-data-stored-exactly-as-published.md) took population figures from Badan Pusat Statistik's "Dalam Angka" yearbooks: one publication per province, per regency/city and per district, downloaded as PDFs and extracted table by table. Kalimantan Tengah went in end to end, and datasets from parts of 20 more provinces followed, before the owner stopped the source on 11 November 2026: "Hentikan penggunaan data dari BPS karena terlalu banyak data yang diperlukan, gunakan Permendagri saja."

What the BPS route cost, measured on the work done under ADR-0051:

- **Volume.** Every region level is a separate publication, so national coverage means tens of thousands of PDFs. The reviewed CSV/JSON pairs already committed, 3,812 datasets from 21 provinces and still far from complete, took 7,624 files and about 39 MB (about 53 MB on disk), before the tooling and fixtures.
- **Access.** The BPS sites sit behind Cloudflare: blocked outright from data-centre addresses, a challenge a headless browser did not pass from a non-residential Indonesian address, transient 403s after a burst. ADR-0051 D9 forbade any bypass, so the crawler could only stop and wait.
- **Time.** BPS's download server sends each file at tens of KB/s; a province with its districts took hours to fetch, and the archive step then uploaded every PDF again to an off-site remote.
- **Fragility.** Watermarked text layers, rows printed out of order, district yearbooks that were scans without text, and covers that named another district all needed their own handling, and 32 of one province's district yearbooks still yielded no dataset.

Meanwhile the figures the platform actually needs, per province and regency/city, were already in the repository. `apps/cms/data/idn-admin-regions/` vendors, from the same upstream commit as the region dump `idn_admin_regions` imports, two companion files that nothing read:

- `db/wilayah_penduduk.sql` — its header: "Data jumlah penduduk dan kode wilayah sesuai Kepmendagri No 300.2.2-2138 Tahun 2025". Total, male and female persons for 38 provinces and 514 regencies/cities, plus one national row: 553 rows, 34,429 bytes.
- `db/wilayah_luas.sql` — "Data Kode Wilayah sesuai Kepmendagri No 300.2.2-2138 Tahun 2025" and "Data Luas Wilayah berdasar dari Badan Informasi Geospasial … Surat Deputi Bidang Informasi Geospasial Dasar Nomor B-16.10/DIGD-BIG/IGD.04.04/12/2024, Tanggal 16 Desember 2024". Area in km2 with three decimals for the same 552 regions: 552 rows, 26,322 bytes.

Both are checksummed in `apps/cms/data/idn-admin-regions/manifest.json` and `checksums.sha256`, and both are under the same decree as the region codes the platform already serves.

## Decision

**D1. BPS is no longer a source, anywhere.** The extracted datasets (the whole `apps/cms/data/idn-population/` directory with its README and NOTICE), the pipeline tooling (`tools/bps-population/`), its root tests and fixtures (`tests/fixtures/bps-population/` and the four `tests/bps-population-*.test.mjs`), and the BPS-only code (the CSV parser `domain/population-csv.ts`, the per-publication manifest `domain/population-manifest.ts`, and the small-cell rule `domain/population-privacy.ts`) are removed. No replacement crawler is added: the new source is already in the repository.

**D2. The figures are the decree's population and BIG's area, per province and regency/city.** `bun run idn-population:import` reads the two vendored files OFFLINE and writes ONE dataset with four figures per region: total persons, male persons (`pria`), female persons (`wanita`), and area in km2. 552 regions, 2,208 figures. The national row of the population file is not stored: `awcms_idn_admin_regions` has no level for it and it is derivable, so the importer checks that it equals the sum of the 38 provinces and then records it as skipped.

**D3. Provenance is per file and truthful.** Each figure's `source_table` names its file, and the dataset row's new `source_files` column records, per file, the path, sha256, size, upstream repository and commit, the origin of its figures and the figures it supplied. Persons are attributed to Kepmendagri No 300.2.2-2138 Tahun 2025 (`figure_basis = 'decree'`). Area is attributed to Badan Informasi Geospasial and its letter (`figure_basis = 'geospatial_calculation'`), never to Kemendagri; only the area file's region CODES follow the decree. Both files are a community packaging (`cahyadsn/wilayah`, MIT), not an official Kemendagri or BIG export: the official-reference caveat of the region dataset (`awcms` ADR-0046) is copied into every dataset row's `terms_of_use`, and `publication_url` points at the upstream commit the files were read from. The MIT licence covers that packaging, not the figures.

**D4. Verified before read, validated before written, fail closed.** Before a figure is read, each file's sha256 and size must match BOTH `manifest.json` and `checksums.sha256`, the manifest must mark the file as read by this importer (`importedBy: idn_admin_regions.population`), and each header must still cite the decree (and, for the area file, BIG's letter); any disagreement refuses the run and records nothing. The dumps are parsed as text by a strict parser (`domain/population-dump-parser.ts`, the same rules as the region parser plus a checked `INSERT` column list), never executed. Validation then reports every problem, and any problem records a `rejected` dataset row with no figures: every code must resolve to a province or regency/city of the ACTIVE region dataset at the matching depth; the active region dataset must cite the same decree; no code twice in one file; `pria + wanita = total`; every area positive with at most three decimals; every level-1/2 region present in both files; regencies/cities adding up to their province (persons exactly, area in exact thousandths of a km2); provinces adding up to the national row.

**D5. One repair, witnessed, listed.** Five rows of the vendored area file carry codes that passed through a floating-point number (`11.1` for `11.10`, `12.1`, `12.2`, `14.1`, and `31.0` for the province `31`). A code that does not resolve is read as `NN.D0` (from `NN.D`) or `NN` (from `NN.0`) only when that region exists at the matching level, does not also appear literally in the file, and the row's name equals that region's official name. Every repair is listed in `validation_summary.codeRepairs` and printed by the command. A name that differs on a code that did resolve (`Kab Timor Tengah Selatan`, `Papua Barat Oaya`) is a warning; the source's spelling is kept as `source_region_name`.

**D6. The tables of `sql/882` stay; `sql/883` changes their rules.** `apps/cms/sql/882_awcms_idn_population_stats.sql` is applied and stays byte-identical. The new forward-only migration `apps/cms/sql/883_awcms_idn_population_kepmendagri_source.sql`, the next free number in this repo's `880`-`899` band:

- deletes every BPS row (statistics first, then datasets), so a database that imported BPS figures stops serving them. No role holds DELETE on these tables; this runs as the migration owner and is the one deliberate exception;
- replaces the BPS-only CHECKs with ones that admit the decree source and nothing else: `source_type = 'kepmendagri_decree'`, `publication_series = 'kepmendagri_kode_data_wilayah'`, an optional `*.kemendagri.go.id` website, `publisher_domain` and `csv_sha256` (BPS concepts) forced NULL, dimensions `total`/`sex`/`area`, units `jiwa`/`km2`, bases `decree`/`geospatial_calculation`, universes `total_population`/`region_area`, a closed category per dimension, and a pairing CHECK so an area can never carry persons' unit or basis and the other way round;
- widens `value` from `numeric(14,2)` to `numeric(14,3)`: BIG prints three decimals, and rounding 1851.615 km2 to 1851.62 would store a figure the source never printed. A fourth decimal is refused, not rounded;
- adds `source_files` (jsonb, a non-empty array), makes the single-file columns `source_file_sha256`/`source_file_bytes` nullable, and admits a national coverage (`coverage_region_level = 0`, `coverage_region_code = 'ID'`), so the single-active index of `sql/882` now means one active decree dataset.

Grants are unchanged: `awcms_app` SELECT on both tables; `awcms_worker` SELECT and INSERT on both and UPDATE on the dataset table; nobody DELETE. Both tables stay global (no `tenant_id`, no RLS) in `GLOBAL_TABLE_FORBIDDEN_PRIVILEGES`.

**D7. The lifecycle and commands of ADR-0051 are kept.** `validated` -> `active` -> `superseded`, with `rejected`; `bun run idn-population:import` (dry run by default, `--commit` writes; it now takes no `--dataset` or `--all-pending`) and `bun run idn-population:activate -- --dataset <code|uuid>` keep their names, their job-registry entries and their `awcms_worker` role, and still write no audit row for the reason `awcms` ADR-0052 gives. The dataset code is derived from the decree and both files' sha256 (`kepmendagri-300.2.2-2138-2025-b0b6b9dc-3ffd506e` for the vendored pair), so re-running over identical bytes is a no-op that exits 0, and a re-vendored correction becomes a new dataset to activate. A `rejected` row whose identical bytes later pass (because the region dataset was fixed) is promoted to `validated`, keeping the earlier rejection as `validation_summary.previousRejection`: the worker has no DELETE, so without this those bytes could never be imported.

## Consequences

- **Breaking for anyone who imported BPS figures.** After `bun run db:migrate`, every BPS dataset and figure is gone, and the age group, religion, occupation, income and expenditure dimensions, `ribu_jiwa`/`rupiah` units and district/village figures no longer exist. Nothing in this repository read them (there was no API and no screen), but a derived application that queried the tables directly loses them. Run `bun run idn-population:import -- --commit` and then `bun run idn-population:activate -- --dataset <code> --commit` to serve the decree's figures.
- Coverage is exactly the decree's: provinces and regencies/cities, total and sex, plus BIG's area. No district or village figures, no age, religion or occupation, no income measure. Each would need a new source and its own ADR.
- The small-cell suppression rule of ADR-0051 D7 is retired with its code: the smallest stored figure is a whole regency's population, and no breakdown remains that could single out a household. A future source at district or village level must bring its own rule.
- About 40 MB of tracked files (7,670 files: the BPS datasets, the tooling, its tests and fixtures) leave the repository; the importer reads 60 KB that were already vendored. The root tests and tools no longer need `pdftotext`, `rclone`, `BPS_CACHE_DIR` or `BPS_ARCHIVE_REMOTE`.
- The population figures are a decree's administrative counts, not a census or a projection, and the reference year stored is the decree's (2025) and BIG's letter's (2024); the files state no other period and none is guessed.
- Local divergences from upstream grow by a few lines and shrink by the BPS tooling: `data/idn-admin-regions/manifest.json` (both files' `importedBy`, the population file's `decreeReference` that an earlier note wrongly said its header lacks, an `areaSourceReference`, three notes; no checksum or size changed), the vendor-manifest test (its header match now folds whitespace, because the population file wraps its decree across two lines), and one-line truths in the module README, the data README and `source-provenance.ts`. They are listed in [`AGENTS.md`](../../AGENTS.md).

## Upstream candidacy

The capability is generic (every AWCMS deployment serving Indonesian regions can use the decree's population and area), and its source files are already upstream's. It is a candidate to propose to `ahliweb/awcms` together with the two tables, the importer and the manifest change. If upstream adopts it, the local files and `sql/882`/`sql/883` are dropped at that sync with a ledger rename.

## Alternatives considered

- **Keep BPS for the levels the decree lacks (age, religion, districts).** Rejected by the owner: the cost of D1's context is in those very levels.
- **Store the area at two decimals in the existing `numeric(14,2)`.** Rejected: it rounds 552 printed figures, and the importer would be the one inventing them.
- **Two datasets, one per file (persons from Kemendagri, area from BIG).** Considered: it would fit the single-file columns of `sql/882`. Rejected for one dataset with per-file `source_files`, because the two files share the decree's codes, are vendored and validated together, and are served together; activating them separately would allow persons and area from different vendorings to be served side by side.
- **Repair the five float-truncated codes by editing the vendored file.** Rejected: a vendored file is never edited (`awcms` ADR-0046), and its checksum is the provenance.
- **Execute the dumps in PostgreSQL.** Rejected for the same reason as the region parser: upstream SQL never runs in our database.
