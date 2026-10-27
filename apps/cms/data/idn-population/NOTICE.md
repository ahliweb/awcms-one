# NOTICE — `data/idn-population/`

## Where the figures come from

Every figure in `datasets/*.csv` was read from a **"Dalam Angka"** statistical
yearbook published by a **Badan Pusat Statistik (BPS)** office — the provincial
office for a "Provinsi … Dalam Angka", the regency/city office for a
"Kabupaten/Kota … Dalam Angka". The data was **obtained from the official BPS
website of the publishing office**, where the publication is **publicly
downloadable by anyone, free of charge**. Each dataset's own
`datasets/<datasetCode>.json` names the office, its official website, the
publication title, the publication page URL and the PDF's SHA-256, and carries
an `attribution` sentence in this form:

> Data diperoleh dari situs web resmi BPS <Kantor> (<https://host>), publikasi
> "<Judul>", yang dapat diunduh secara bebas oleh siapa pun.

The statistical figures **belong to BPS** and are attributed to it. Nothing in
this repository claims otherwise.

## Terms printed in the publications

Each publication prints its own terms on its copyright page. They are copied
**verbatim** into the dataset's `termsOfUse` field. For example, the provincial
and regency/city yearbooks read:

> Dilarang mereproduksi dan/atau menggandakan sebagian atau seluruh isi buku ini
> untuk tujuan komersial tanpa izin tertulis dari Badan Pusat Statistik <Kantor>.

Those terms — including the clause that forbids commercial reproduction without
the written permission of the publishing BPS office — **still apply to the
figures**, whatever licence covers this repository's code. Anyone reusing the
figures is responsible for observing them.

## What the MIT License covers here — and what it does not

The MIT License in the repository root (`LICENSE`) covers **this repository's
own work**: the extraction tooling (`tools/bps-population/`), the importer and
its tests, and the CSV/JSON **format** (column layout, category keys, manifest
fields) defined for these files.

It does **not** relicense the statistical figures. The figures remain BPS's
work, attributed to BPS, and the publication's own terms (above) govern their
reuse. The MIT License is never a statement that BPS figures are MIT-licensed.

## The PDFs are not vendored

The source PDFs (11–14 MB each; about 550 to 1,000 pages) are **not** committed.
They are fetched from the official BPS site into a local cache
(`~/.cache/awcms-bps-population/`, or `BPS_CACHE_DIR`) by
`tools/bps-population/fetch.ts`. A dataset is verifiable against its PDF:

```bash
bun tools/bps-population/fetch.ts ...        # (re-)download into the cache
sha256sum ~/.cache/awcms-bps-population/pdf/6271-dalam-angka-2026.pdf
# must equal `sourceFileSha256` in datasets/bps-6271-dalam-angka-2026.json

bun tools/bps-population/extract/run.ts --pdf <that pdf> --domain 6271 --out /tmp/verify
diff /tmp/verify/bps-6271-dalam-angka-2026.csv datasets/bps-6271-dalam-angka-2026.csv
```

The extraction is deterministic: the same PDF yields the same CSV bytes
(`csvSha256` in the JSON). If a BPS office later replaces a PDF, its SHA-256
changes and the dataset must be re-extracted and re-reviewed, not edited.

## Caveats on the data itself

- Figures are stored **exactly as published** (`ribu_jiwa` stays thousands; it
  is never converted to persons) with the level, reference year, basis
  (`census`, `projection`, `registration`, `survey_estimate`) and source table
  and page they were printed at. Different bases are never summed together.
- A value that could not be read reliably is **left out** and listed in the
  dataset's `knownGaps`; nothing is interpolated, rounded or filled in.
- `income` rows are Sakernas **net wages of employees**, not household income;
  `expenditure` rows are Susenas **per-capita expenditure**, a welfare proxy,
  not income.
- Privacy: small cells are to be suppressed by any future read surface; see
  `README.md`.
