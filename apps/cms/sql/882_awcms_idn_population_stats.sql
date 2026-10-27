-- Issue #497 (awcms-one ADR-0051) — Indonesian population statistics published
-- by BPS (Badan Pusat Statistik), stored beside `idn_admin_regions` and keyed by
-- the same Kemendagri dotted region codes.
--
-- A LOCAL divergence kept in this repo's 880-899 band (see AGENTS.md): it adds
-- two tables next to an upstream-owned module, so it cannot sit in upstream's
-- 001-899 range or commerce's 901+ range. A candidate to propose upstream.
--
-- Two tables:
--
--   1. `awcms_idn_population_datasets` — one row per IMPORTED publication file
--      (for example "Kota Palangka Raya Dalam Angka 2026"), carrying where the
--      figures came from (publisher, official website, catalogue/ISSN numbers,
--      the printed terms of use, the sha256 of the source file and of the
--      extracted CSV), which region dataset its codes were validated against,
--      and a lifecycle status.
--   2. `awcms_idn_population_stats` — one row per published figure, belonging to
--      exactly one dataset.
--
-- ## Values are stored EXACTLY as published
--
-- `value` is `numeric(14,2)` and `unit` says what it counts: `jiwa` (persons),
-- `ribu_jiwa` (thousands of persons) or `rupiah` (a monetary average). A figure
-- is NEVER converted on the way in: "2,84 ribu jiwa" is stored as 2.84 with unit
-- `ribu_jiwa`, not as 2840, because BPS rounded it to two decimals of a thousand
-- and multiplying would invent precision the publication never had. A unit of
-- `jiwa` must be a whole number (CHECK), and `rupiah` is allowed only for the
-- `income`/`expenditure` dimensions (CHECK) so an average wage can never be
-- summed with a head count by accident.
--
-- Every row also says which LEVEL it was published at (`region_level`), the
-- `reference_year` of the figure (not the publication year), its `figure_basis`
-- (census / projection / registration / survey estimate), its `universe` (who is
-- being counted) and the table and printed page it came from. Figures with
-- different bases are never added up against each other.
--
-- ## GLOBAL reference data — no tenant_id, no RLS
--
-- The same reasoning as sql/080 (ADR-0046 §3): a province's population is not
-- tenant-owned data, so both tables are global, exactly like
-- `awcms_idn_region_datasets`. They are registered in
-- `GLOBAL_TABLE_FORBIDDEN_PRIVILEGES` (`scripts/security-readiness.ts`), the
-- single structure that feeds both the RLS exemption set and the
-- forbidden-privilege check. What is global is the ROW, not the permission: this
-- change adds no HTTP endpoint, so there is nothing for a tenant to reach yet.
-- Any future read surface must apply small-cell suppression
-- (`domain/population-privacy.ts`).
--
-- ## Least-privilege grants, written to match the code paths that exist
--
-- Migration 013's `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE,
-- DELETE ON TABLES TO awcms_app` fires the moment `CREATE TABLE` runs, so both
-- tables start over-granted. This migration narrows them in the same
-- transaction:
--
--   * `awcms_app`    — SELECT on both (a future read API). No write: nothing in
--     a request creates, edits or activates population data.
--   * `awcms_worker` — SELECT + INSERT on both (`idn-population:import`), and
--     UPDATE on the DATASET table only (`idn-population:activate` flips
--     `status`/`activated_at`). Statistics rows are never edited in place.
--   * Nobody gets DELETE: a dataset is superseded, never deleted.
--
-- `awcms_setup` gets nothing: bootstrap does not touch reference data.

CREATE TABLE IF NOT EXISTS awcms_idn_population_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_code text NOT NULL,
  source_type text NOT NULL DEFAULT 'bps_publication',
  publication_series text NOT NULL,
  -- Kemendagri dotted code of the region the publication covers ('62',
  -- '62.71', '62.71.01').
  coverage_region_code text NOT NULL,
  coverage_region_level smallint NOT NULL,
  publication_title text NOT NULL,
  publisher_name text NOT NULL,
  -- BPS "domain" of the publishing office (four digits, e.g. '6271').
  publisher_domain text NOT NULL,
  -- The OFFICIAL website of the publishing BPS office. Population figures are
  -- only ever taken from there, and the row says so (see `attribution`).
  publisher_website text NOT NULL,
  attribution text NOT NULL,
  catalogue_number text,
  publication_number text,
  issn text,
  publication_year smallint NOT NULL,
  release_date date,
  publication_url text NOT NULL,
  source_file_sha256 text NOT NULL,
  source_file_bytes bigint NOT NULL,
  -- sha256 of the extracted CSV the importer actually read.
  csv_sha256 text NOT NULL,
  -- Printed in the publication, copied verbatim.
  terms_of_use text NOT NULL,
  -- The ACTIVE region dataset the region codes were validated against at import.
  region_dataset_id uuid NOT NULL REFERENCES awcms_idn_region_datasets (id),
  row_count integer NOT NULL,
  status text NOT NULL,
  validation_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  activated_at timestamptz,
  activated_by uuid,
  CONSTRAINT awcms_idn_population_datasets_dataset_code_key UNIQUE (dataset_code),
  CONSTRAINT awcms_idn_population_datasets_source_type_check
    CHECK (source_type IN ('bps_publication')),
  CONSTRAINT awcms_idn_population_datasets_series_check
    CHECK (publication_series IN (
      'provinsi_dalam_angka',
      'kabupaten_kota_dalam_angka',
      'kecamatan_dalam_angka'
    )),
  CONSTRAINT awcms_idn_population_datasets_coverage_level_check
    CHECK (coverage_region_level BETWEEN 1 AND 4),
  CONSTRAINT awcms_idn_population_datasets_domain_check
    CHECK (publisher_domain ~ '^[0-9]{4}$'),
  CONSTRAINT awcms_idn_population_datasets_website_check
    CHECK (publisher_website ~ '^https://([a-z0-9-]+\.)?bps\.go\.id$'),
  CONSTRAINT awcms_idn_population_datasets_url_check
    CHECK (publication_url ~ '^https://'),
  CONSTRAINT awcms_idn_population_datasets_source_sha_check
    CHECK (source_file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT awcms_idn_population_datasets_csv_sha_check
    CHECK (csv_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT awcms_idn_population_datasets_source_bytes_check
    CHECK (source_file_bytes > 0),
  CONSTRAINT awcms_idn_population_datasets_row_count_check
    CHECK (row_count >= 0),
  -- Same lifecycle as the region datasets: `validated` = imported, not serving;
  -- `active` = serving; `superseded` = was active, replaced; `rejected` = an
  -- import attempt that failed validation (the summary says why).
  CONSTRAINT awcms_idn_population_datasets_status_check
    CHECK (status IN ('validated', 'active', 'superseded', 'rejected'))
);

COMMENT ON TABLE awcms_idn_population_datasets IS
  'Global reference data (awcms-one ADR-0051) — one row per imported BPS population publication file. NOT tenant-scoped, no RLS: see sql/882 header and scripts/security-readiness.ts GLOBAL_TABLE_FORBIDDEN_PRIVILEGES.';

-- One active dataset per publication series and covered region, enforced by the
-- DATABASE (the same technique as sql/080's single-active index, keyed wider
-- because a province and each of its regencies are separate publications that
-- are all served at once).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_idn_population_datasets_single_active
  ON awcms_idn_population_datasets (publication_series, coverage_region_code)
  WHERE status = 'active';

-- The foreign key to the region dataset the codes were validated against: a
-- parent DELETE/UPDATE on `awcms_idn_region_datasets` checks this table through it.
CREATE INDEX IF NOT EXISTS awcms_idn_population_datasets_region_dataset_idx
  ON awcms_idn_population_datasets (region_dataset_id);

CREATE TABLE IF NOT EXISTS awcms_idn_population_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES awcms_idn_population_datasets (id),
  -- Dotted Kemendagri code as in `awcms_idn_admin_regions.code`.
  region_code text NOT NULL,
  -- The level the figure was PUBLISHED at; equals the code's segment count.
  region_level smallint NOT NULL,
  -- The region name exactly as the publication spells it.
  source_region_name text NOT NULL,
  dimension text NOT NULL,
  -- `total`; `laki_laki`/`perempuan`; an age band such as `0-4` or `75+`; a
  -- religion key; or, for occupation/income/expenditure, a snake_case label
  -- (income/expenditure: `<breakdown>/<key>` or `total`).
  category text NOT NULL,
  -- NULL for the dimension totals and for "both sexes"; set for a cross-tab.
  sex text,
  value numeric(14, 2) NOT NULL,
  unit text NOT NULL,
  reference_year smallint NOT NULL,
  figure_basis text NOT NULL,
  universe text NOT NULL,
  source_table text NOT NULL,
  -- Printed page number (not the PDF page index).
  source_page integer,
  -- 'nil' = the publication printed its nil symbol; the value is 0. A cell that
  -- was blank or "not available" has NO ROW at all: gaps are never filled.
  value_note text,
  -- The category's label exactly as the publication prints it (Indonesian);
  -- `category` stays the stable machine key.
  category_label text,
  source_row_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_idn_population_stats_category_length_check
    CHECK (char_length(category) <= 80),
  CONSTRAINT awcms_idn_population_stats_category_label_check
    CHECK (category_label IS NULL OR char_length(category_label) <= 500),
  CONSTRAINT awcms_idn_population_stats_level_check
    CHECK (region_level BETWEEN 1 AND 4),
  CONSTRAINT awcms_idn_population_stats_dimension_check
    CHECK (dimension IN (
      'total', 'sex', 'age_group', 'religion', 'occupation',
      'income', 'expenditure'
    )),
  CONSTRAINT awcms_idn_population_stats_sex_check
    CHECK (sex IS NULL OR sex IN ('laki_laki', 'perempuan')),
  CONSTRAINT awcms_idn_population_stats_total_sex_check
    CHECK (dimension NOT IN ('total', 'sex') OR sex IS NULL),
  CONSTRAINT awcms_idn_population_stats_value_check CHECK (value >= 0),
  CONSTRAINT awcms_idn_population_stats_unit_check
    CHECK (unit IN ('jiwa', 'ribu_jiwa', 'rupiah')),
  CONSTRAINT awcms_idn_population_stats_jiwa_integral_check
    CHECK (unit <> 'jiwa' OR value = trunc(value)),
  -- A rupiah average belongs to income/expenditure and nothing else does.
  CONSTRAINT awcms_idn_population_stats_rupiah_dimension_check
    CHECK ((unit = 'rupiah') = (dimension IN ('income', 'expenditure'))),
  CONSTRAINT awcms_idn_population_stats_reference_year_check
    CHECK (reference_year BETWEEN 1961 AND 2100),
  CONSTRAINT awcms_idn_population_stats_basis_check
    CHECK (figure_basis IN (
      'census', 'projection', 'registration', 'survey_estimate'
    )),
  CONSTRAINT awcms_idn_population_stats_universe_check
    CHECK (universe IN (
      'total_population', 'employed_15_plus', 'employees', 'per_capita'
    )),
  CONSTRAINT awcms_idn_population_stats_source_page_check
    CHECK (source_page IS NULL OR source_page > 0),
  CONSTRAINT awcms_idn_population_stats_value_note_check
    CHECK (value_note IS NULL OR value_note IN ('nil'))
);

COMMENT ON TABLE awcms_idn_population_stats IS
  'Global reference data (awcms-one ADR-0051) — figures published by BPS for ONE dataset, stored exactly as published (value + unit, never converted). NOT tenant-scoped, no RLS: see sql/882 header. Aggregate statistics only, no personal data; small-cell suppression applies to any read surface.';

-- A figure is identified by the table it was published in, its basis and what it
-- measures (one table can print a projection total and a registration total for
-- the same region and year),
-- so a repeated key is a defect in the extraction rather than a second opinion.
-- `source_table` is part of the key because every BPS table prints its own total
-- rows for a region; the same total appearing in two tables is two figures, and
-- the importer compares them (a warning, never a silent overwrite). NULLS NOT
-- DISTINCT because `sex` is NULL for "both sexes" and two NULLs must collide.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_idn_population_stats_key
  ON awcms_idn_population_stats (
    dataset_id, source_table, region_code, dimension, category, sex,
    reference_year, universe, figure_basis
  ) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS awcms_idn_population_stats_dataset_region_idx
  ON awcms_idn_population_stats (dataset_id, region_code);

CREATE INDEX IF NOT EXISTS awcms_idn_population_stats_region_dimension_idx
  ON awcms_idn_population_stats (region_code, dimension);

-- Least-privilege: see this file's header for why each grant exists.
REVOKE ALL ON awcms_idn_population_datasets FROM awcms_app;
REVOKE ALL ON awcms_idn_population_stats FROM awcms_app;
GRANT SELECT ON awcms_idn_population_datasets TO awcms_app;
GRANT SELECT ON awcms_idn_population_stats TO awcms_app;
GRANT SELECT, INSERT, UPDATE ON awcms_idn_population_datasets TO awcms_worker;
GRANT SELECT, INSERT ON awcms_idn_population_stats TO awcms_worker;
