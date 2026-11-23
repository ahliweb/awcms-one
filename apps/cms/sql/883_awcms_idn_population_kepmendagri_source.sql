-- awcms-one ADR-0053 — population and area figures come from the Kepmendagri
-- region decree, not from BPS. Supersedes the BPS-only rules of sql/882
-- (awcms-one ADR-0051), which stays byte-identical: an applied migration is
-- never edited, so this one changes what 882 created.
--
-- A LOCAL divergence kept in this repo's 880-899 band (see AGENTS.md), like
-- sql/882 itself. A candidate to propose upstream together with the tables.
--
-- ## Why
--
-- The owner stopped the BPS source on 11 November 2026 ("terlalu banyak data
-- yang diperlukan, gunakan Permendagri saja"): one "Dalam Angka" publication per
-- province, regency/city and district meant thousands of PDFs behind Cloudflare
-- and IP restrictions, about 53 MB of extracted CSV/JSON in the repository, and
-- hours of upload for one province. The decree's own figures are already
-- vendored and checksummed beside the region dump `idn_admin_regions` imports:
--
--   * `db/wilayah_penduduk.sql` — "Data jumlah penduduk dan kode wilayah sesuai
--     Kepmendagri No 300.2.2-2138 Tahun 2025": total, male and female persons
--     per province and regency/city, plus one national row.
--   * `db/wilayah_luas.sql` — region codes per the same decree, with the AREA
--     in km2 from Badan Informasi Geospasial (letter B-16.10/DIGD-BIG/
--     IGD.04.04/12/2024, 16 December 2024). The area is BIG's, not Kemendagri's.
--
-- Both are a community packaging (cahyadsn/wilayah, MIT), not an official
-- Kemendagri or BIG export; the caveat travels with every dataset row.
--
-- ## What this migration does
--
--   1. Deletes every BPS row, statistics first and then datasets, so a database
--      that imported BPS publications stops serving them. sql/882 gives no role
--      DELETE ("a dataset is superseded, never deleted"); this runs as the
--      migration owner and is the one deliberate exception, recorded in
--      ADR-0053. Nothing references these tables except each other.
--   2. Replaces the BPS-only CHECKs with ones that admit the decree source, and
--      ONLY it: BPS is gone, so its source type, publication series, BPS domain
--      code, `*.bps.go.id` website rule, units (`ribu_jiwa`, `rupiah`),
--      dimensions (age group, religion, occupation, income, expenditure),
--      bases and universes are no longer admitted. A future source needs its
--      own ADR and its own migration.
--   3. Admits the AREA figure: dimension `area`, unit `km2`, basis
--      `geospatial_calculation`, universe `region_area`. BIG publishes area
--      with three decimals, so `value` widens from numeric(14,2) to
--      numeric(14,3) — rounding 1851.615 km2 to 1851.62 would invent a figure
--      the source never printed, and the importer refuses a fourth decimal
--      rather than round it. Eleven integer digits still hold any count of
--      persons.
--   4. Adds `source_files` (jsonb): one dataset reads TWO files with different
--      origins, so the single-file columns of sql/882 (`source_file_sha256`,
--      `source_file_bytes`, `csv_sha256`) become nullable and the per-file
--      record (path, sha256, bytes, upstream commit, origin, which figures it
--      supplied) lives there. `publisher_domain` and `csv_sha256` were BPS
--      concepts (a BPS office domain, an extracted CSV) and must stay NULL.
--   5. Allows a NATIONAL coverage: `coverage_region_level = 0` with
--      `coverage_region_code = 'ID'`. The decree covers the whole country in
--      one dataset, so the single-active index of sql/882 (one active dataset
--      per series and covered region) now means one active decree dataset.
--
-- ## The national row is not stored
--
-- `wilayah_penduduk.sql` carries a row `('0','INDONESIA',...)`. It is not a
-- region of `awcms_idn_admin_regions` (levels 1-4 only, and `region_level`
-- keeps its 1..4 CHECK), and it is derivable: the importer checks that it
-- equals the sum of the 38 provinces, then skips it and says so in the
-- dataset's `validation_summary`.
--
-- ## Grants and posture are unchanged
--
-- Both tables stay GLOBAL (no tenant_id, no RLS) and registered in
-- `GLOBAL_TABLE_FORBIDDEN_PRIVILEGES` (scripts/security-readiness.ts). The
-- grants of sql/882 stand: `awcms_app` SELECT on both; `awcms_worker` SELECT +
-- INSERT on both and UPDATE on the dataset table (activation, and promoting a
-- `rejected` row whose re-import now passes); no role holds DELETE. The new
-- column is covered by those table-level grants.

-- 1. BPS rows go, statistics first (they reference their dataset).
DELETE FROM awcms_idn_population_stats
WHERE dataset_id IN (
  SELECT id FROM awcms_idn_population_datasets
  WHERE source_type = 'bps_publication'
);

DELETE FROM awcms_idn_population_datasets
WHERE source_type = 'bps_publication';

-- 2. Datasets: the decree source, and only it.
ALTER TABLE awcms_idn_population_datasets
  ADD COLUMN IF NOT EXISTS source_files jsonb;

ALTER TABLE awcms_idn_population_datasets
  ALTER COLUMN source_type SET DEFAULT 'kepmendagri_decree',
  ALTER COLUMN publisher_domain DROP NOT NULL,
  ALTER COLUMN publisher_website DROP NOT NULL,
  ALTER COLUMN source_file_sha256 DROP NOT NULL,
  ALTER COLUMN source_file_bytes DROP NOT NULL,
  ALTER COLUMN csv_sha256 DROP NOT NULL,
  ALTER COLUMN source_files SET NOT NULL;

ALTER TABLE awcms_idn_population_datasets
  DROP CONSTRAINT IF EXISTS awcms_idn_population_datasets_source_type_check,
  DROP CONSTRAINT IF EXISTS awcms_idn_population_datasets_series_check,
  DROP CONSTRAINT IF EXISTS awcms_idn_population_datasets_coverage_level_check,
  DROP CONSTRAINT IF EXISTS awcms_idn_population_datasets_domain_check,
  DROP CONSTRAINT IF EXISTS awcms_idn_population_datasets_website_check,
  DROP CONSTRAINT IF EXISTS awcms_idn_population_datasets_bps_columns_check,
  DROP CONSTRAINT IF EXISTS awcms_idn_population_datasets_source_files_check;

ALTER TABLE awcms_idn_population_datasets
  ADD CONSTRAINT awcms_idn_population_datasets_source_type_check
    CHECK (source_type IN ('kepmendagri_decree')),
  ADD CONSTRAINT awcms_idn_population_datasets_series_check
    CHECK (publication_series IN ('kepmendagri_kode_data_wilayah')),
  -- Level 0 is the whole country, written 'ID'; levels 1-4 are a dotted
  -- Kemendagri code of that depth.
  ADD CONSTRAINT awcms_idn_population_datasets_coverage_level_check
    CHECK (
      CASE
        WHEN coverage_region_level = 0 THEN coverage_region_code = 'ID'
        WHEN coverage_region_level BETWEEN 1 AND 4 THEN
          coverage_region_code ~ '^[0-9]{2}(\.[0-9]{2}(\.[0-9]{2}(\.[0-9]{4})?)?)?$'
          AND array_length(string_to_array(coverage_region_code, '.'), 1)
            = coverage_region_level
        ELSE false
      END
    ),
  -- A website is optional (the decree source records where the files were
  -- read from in `publication_url`), and when present it is Kemendagri's.
  ADD CONSTRAINT awcms_idn_population_datasets_website_check
    CHECK (
      publisher_website IS NULL
      OR publisher_website ~ '^https://([a-z0-9-]+\.)?kemendagri\.go\.id$'
    ),
  -- BPS-only columns: a BPS office domain code and an extracted CSV.
  ADD CONSTRAINT awcms_idn_population_datasets_bps_columns_check
    CHECK (publisher_domain IS NULL AND csv_sha256 IS NULL),
  -- One entry per source file the dataset read. CASE, not AND: PostgreSQL does
  -- not promise left-to-right evaluation, and jsonb_array_length raises on a
  -- non-array instead of returning false.
  ADD CONSTRAINT awcms_idn_population_datasets_source_files_check
    CHECK (
      CASE
        WHEN jsonb_typeof(source_files) = 'array'
          THEN jsonb_array_length(source_files) >= 1
        ELSE false
      END
    );

COMMENT ON TABLE awcms_idn_population_datasets IS
  'Global reference data (awcms-one ADR-0053, superseding ADR-0051) — one row per imported Kepmendagri region-decree population/area dataset, read offline from the vendored cahyadsn/wilayah files (a community packaging, not an official Kemendagri or BIG export). NOT tenant-scoped, no RLS: see sql/882 and sql/883 headers and scripts/security-readiness.ts GLOBAL_TABLE_FORBIDDEN_PRIVILEGES.';

COMMENT ON COLUMN awcms_idn_population_datasets.source_files IS
  'One object per source file the dataset read: path, sha256, bytes, upstream repository and commit, origin (the decree, or BIG for area) and the figures it supplied (sql/883).';

-- 3. Statistics: total, sex and area, and nothing BPS-specific.
ALTER TABLE awcms_idn_population_stats
  ALTER COLUMN value TYPE numeric(14, 3);

ALTER TABLE awcms_idn_population_stats
  DROP CONSTRAINT IF EXISTS awcms_idn_population_stats_dimension_check,
  DROP CONSTRAINT IF EXISTS awcms_idn_population_stats_unit_check,
  DROP CONSTRAINT IF EXISTS awcms_idn_population_stats_rupiah_dimension_check,
  DROP CONSTRAINT IF EXISTS awcms_idn_population_stats_basis_check,
  DROP CONSTRAINT IF EXISTS awcms_idn_population_stats_universe_check,
  DROP CONSTRAINT IF EXISTS awcms_idn_population_stats_category_check,
  DROP CONSTRAINT IF EXISTS awcms_idn_population_stats_measure_check,
  DROP CONSTRAINT IF EXISTS awcms_idn_population_stats_area_positive_check;

ALTER TABLE awcms_idn_population_stats
  ADD CONSTRAINT awcms_idn_population_stats_dimension_check
    CHECK (dimension IN ('total', 'sex', 'area')),
  ADD CONSTRAINT awcms_idn_population_stats_unit_check
    CHECK (unit IN ('jiwa', 'km2')),
  ADD CONSTRAINT awcms_idn_population_stats_basis_check
    CHECK (figure_basis IN ('decree', 'geospatial_calculation')),
  ADD CONSTRAINT awcms_idn_population_stats_universe_check
    CHECK (universe IN ('total_population', 'region_area')),
  -- A closed vocabulary per dimension: `total` and `area` carry `total`, `sex`
  -- carries the two sexes (the `sex` column itself stays NULL for these
  -- dimensions, sql/882's total_sex_check).
  ADD CONSTRAINT awcms_idn_population_stats_category_check
    CHECK (
      CASE dimension
        WHEN 'sex' THEN category IN ('laki_laki', 'perempuan')
        ELSE category = 'total'
      END
    ),
  -- An area is BIG's km2 measurement; a head count is the decree's persons.
  -- Neither may borrow the other's unit, basis or universe.
  ADD CONSTRAINT awcms_idn_population_stats_measure_check
    CHECK (
      CASE
        WHEN dimension = 'area' THEN
          unit = 'km2' AND figure_basis = 'geospatial_calculation'
          AND universe = 'region_area'
        ELSE
          unit = 'jiwa' AND figure_basis = 'decree'
          AND universe = 'total_population'
      END
    ),
  ADD CONSTRAINT awcms_idn_population_stats_area_positive_check
    CHECK (dimension <> 'area' OR value > 0);

COMMENT ON TABLE awcms_idn_population_stats IS
  'Global reference data (awcms-one ADR-0053, superseding ADR-0051) — total and per-sex persons (Kepmendagri No 300.2.2-2138 Tahun 2025) and area in km2 (Badan Informasi Geospasial) per province and regency/city for ONE dataset, stored exactly as the source prints them. NOT tenant-scoped, no RLS: see sql/882 and sql/883 headers. Aggregate figures only, no personal data.';

COMMENT ON COLUMN awcms_idn_population_stats.value IS
  'The figure as the source prints it: whole persons (unit jiwa) or km2 with up to three decimals (unit km2). Never converted or rounded (sql/883).';
