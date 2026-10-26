# `data/idn-population/` — population statistics extracted from BPS "Dalam Angka"

Reviewed, committed CSV + JSON pairs that the `idn_admin_regions` population
importer (`bun run idn-population:import`) loads into
`awcms_idn_population_datasets` / `awcms_idn_population_stats`. Source,
terms and licence scope: [`NOTICE.md`](NOTICE.md) — **read it before reusing any figure**.

```text
data/idn-population/
├── README.md
├── NOTICE.md
└── datasets/
    ├── bps-<dddd>-dalam-angka-<year>.csv    ← the rows (one dataset = one publication)
    └── bps-<dddd>-dalam-angka-<year>.json   ← provenance + terms + attribution + gaps
```

`<dddd>` is the BPS office domain: `6200` is the province of Kalimantan Tengah,
`6271` is Kota Palangka Raya. A domain ending in `00` is a provincial
yearbook (`provinsi_dalam_angka`); any other domain is a regency/city one
(`kabupaten_kota_dalam_angka`). BPS numbers its regency domains in its own
order (6207 is Lamandau, Kemendagri 62.09), so a regency is mapped to its
Kemendagri code **by name**, never by the digits.

A **Kecamatan Dalam Angka** (series `kecamatan_dalam_angka`) is published by the
regency/city office: its dataset code is
`bps-<regency domain>-kecamatan-<compact district code>-dalam-angka-<year>`
(for example `bps-6271-kecamatan-627101-dalam-angka-2025`), its coverage is the
three-segment district code, and its rows are per desa/kelurahan (level 4).
Village names that are unmatched or ambiguous in `wilayah.sql` (BPS and Kemendagri
sometimes spell a name differently, e.g. "Benua Lima" / "Banua Lima") are not
stored and are listed in `knownGaps`.

`category_label` is the category exactly as the publication prints it (`0–4`,
`Protestan`, the full industry-group text); the `category` key stays short and stable.

## What a dataset contains

The CSV header is fixed:

```text
region_code,region_level,source_region_name,dimension,category,sex,value,unit,reference_year,figure_basis,universe,source_table,source_page,value_note,category_label
```

| dimension | category | unit | basis | notes |
| --- | --- | --- | --- | --- |
| `total` | `total` | `ribu_jiwa` / `jiwa` | census, projection, registration | population per region; for `universe = employed_15_plus` the employed total |
| `sex` | `laki_laki` / `perempuan` | same | same | |
| `age_group` | `0-4` … `70-74`, `75+` | same | same | `sex` empty = both sexes |
| `religion` | `islam`, `kristen`, `katolik`, `hindu`, `buddha`, `khonghucu`, `kepercayaan`, `lainnya` | `jiwa` | registration | `kristen` is BPS's "Protestan" |
| `occupation` | snake_case of the published industry-group label | `jiwa` | survey_estimate | Sakernas, employed 15+ |
| `income` | `total` or `lapangan_pekerjaan_utama/<group>` / `kelompok_umur/<band>` | `rupiah` | survey_estimate | average **net wage of employees** (Sakernas); not household income |
| `expenditure` | `total` or `kelompok_komoditas/<group>` | `rupiah` | survey_estimate | Susenas average **per-capita expenditure**; a welfare proxy, not income |

`value` is the published number with `.` as the decimal mark and no thousands
separators (`2.844,99` → `2844.99`, `14.243` → `14243`). The BPS nil symbol
(`–`, `-`, `_`) becomes `0` with `value_note = nil`; a cell that is blank or
`...` produces **no row**. Every table's published aggregate row (the region's
own total) is included.

Minimum wage (UMP/UMK) is a regulation, not a population measure, and is not
stored.

## Producing a dataset

```bash
# one publication (add --district 62.71.01 for a Kecamatan yearbook)
bun tools/bps-population/extract/run.ts --pdf ~/.cache/awcms-bps-population/pdf/6271-dalam-angka-2026.pdf --domain 6271

# every publication (regency/province `offices` and `districts`) that fetch.ts has downloaded and that has no dataset yet
bun tools/bps-population/extract/run.ts --from-state [--only 6271|62.71.01] [--force] [--drop-failed-tables]
```

The extractor finds each table by its Indonesian **title wording** (the table
numbers differ between offices), reads every number by its x-position under the
column markers `(1) (2) (3) …` (the PDFs' text layer sometimes emits two rows'
numbers out of order, and a diagonal watermark is interleaved), maps row names
to Kemendagri codes using the vendored `wilayah.sql` scoped to the covered
region, and **validates before writing**:

- sex split = total; age bands = total (both sexes and per sex); religions = total;
- children → parent (e.g. the 14 regencies/cities add up to the province), with
  `ribu_jiwa` tolerating the rounding of each published figure (0.005 × (parts + 1));
- a figure read from two tables must agree; a name that is unmatched or
  ambiguous (the 16 same-name Kabupaten/Kota pairs; "Kabupaten/Regency" and
  "Kota/Municipality" group lines are used as hints) is reported, never guessed.

`--drop-failed-tables` leaves out a table whose own figures contradict each other
(a printing error in the source; the dataset's `knownGaps` says which and why).
When a heading says "jiwa" over figures that are almost all printed with decimals
(a recurring printing error), the unit is stored as `ribu_jiwa`, digits unchanged,
and the correction is listed in `knownGaps`.

A dataset that fails is **not written**; a review file goes to
`~/.cache/awcms-bps-population/review/<datasetCode>.review.md`, outside the
repository. Tables that a publication does not contain, or that could not be
read reliably, are listed in the JSON's `knownGaps`.

Requires `pdftotext` (poppler-utils) on `PATH`. The extractor reads
`~/.cache/awcms-bps-population/state.json` (written by `fetch.ts`) for the
publication page URL, official host and release date.

## Reviewing a dataset

The extractor's checks prove internal consistency; they do not prove the PDF was
read correctly where the PDF itself is wrong. A reviewer renders the cited
pages (`pdftoppm -r 110 -f <pdf page> -l <pdf page> -png …`; printed page =
PDF page − 62 in the 2026 provincial yearbook) and compares the CSV values.
`sourcePages` in the JSON lists the printed pages used.

## Privacy rule for any read surface

These are aggregates, but small cells can identify people. A future read API
must withhold cells with `value < 10` (unit `jiwa`) for `dimension = religion`
at every level and for every dimension at `region_level = 4`
(`domain/population-privacy.ts`, `suppressSmallCells`).

## Licence scope

The MIT License (repository root `LICENSE`) covers this repository's code, the
CSV/JSON format and the extraction tooling. The statistical figures remain
BPS's, attributed to BPS, and each publication's own terms (`termsOfUse` in the
JSON, quoted in [`NOTICE.md`](NOTICE.md)) still apply, including the ban on
commercial reproduction without written permission from the publishing BPS
office.
